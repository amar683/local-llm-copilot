import * as vscode from 'vscode';
import * as http from 'http';
import * as path from 'path';
import * as fs from 'fs';
import { ServerController } from './serverController';
import { TOOL_DEFINITIONS, TOOL_CATEGORIES, AGENTIC_SYSTEM_PROMPT } from './toolDefinitions';
import { executeToolCall, initTools } from './toolExecutor';
import { SemanticSearch } from './semanticSearch';

/** Maximum number of tool-call iterations per user turn */
const MAX_TOOL_ITERATIONS = 10;

export interface ChatSession {
  id: string;
  title: string;
  timestamp: number;
  messages: any[];
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'localLlmChatView';
  private _view?: vscode.WebviewView;
  private currentServerStatus: 'idle' | 'starting' | 'ready' | 'error' = 'idle';
  private currentStatusMessage = 'Select a model to begin';
  private selectedModelId = '';
  private activeRequest: http.ClientRequest | undefined;
  private abortRequested = false;
  // Keyed by file path (fsPath), stores the original content before any edits in this turn.
  private turnFileBackups: Map<string, { uri: vscode.Uri, originalContent: string, addedLines: number, removedLines: number }> = new Map();
  private disabledTools: Set<string> = new Set();

  private currentSessionId: string = '';

  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly serverController: ServerController
  ) {
    // Initialize tool modules that need the extension context
    initTools(_context);
    // Load disabled tools from settings
    this.disabledTools = new Set(
      _context.globalState.get<string[]>('localLlm.disabledTools') || []
    );
  }

  public setChatInput(text: string) {
    if (this._view) {
      this._view.webview.postMessage({ type: 'setChatInput', text });
      this._view.show(true);
    }
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._context.extensionUri]
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    // Track editor and workspace changes to display active context indicators in Webview
    const selectionDisposable = vscode.window.onDidChangeTextEditorSelection(() => this.sendContextUpdate());
    const editorDisposable = vscode.window.onDidChangeActiveTextEditor(() => this.sendContextUpdate());
    const workspaceDisposable = vscode.workspace.onDidChangeWorkspaceFolders(() => this.sendContextUpdate());

    webviewView.onDidDispose(() => {
      selectionDisposable.dispose();
      editorDisposable.dispose();
      workspaceDisposable.dispose();
    });

    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.type) {
        case 'getModels':
          this.sendModelsToWebview();
          this.sendUpdateStatus();
          this.sendContextUpdate();
          this.sendLlamaCppPath();
          this.sendSessionsToWebview();
          break;

        case 'getSessions':
          this.sendSessionsToWebview();
          break;

        case 'saveSession':
          this.saveSession(data.session);
          break;

        case 'deleteSession':
          this.deleteSession(data.sessionId);
          break;

        case 'selectModel':
          this.selectedModelId = data.modelId;
          const models = this.getModelsFromConfig();
          const model = models.find(m => m.id === data.modelId);
          if (model) {
            const command = this.buildServerCommand(model);
            if (!command) {
              vscode.window.showErrorMessage('Cannot start server: missing llama.cpp path or model path. Please configure in the setup panel.');
              return;
            }
            const port = model.port || 8080;
            await this.serverController.startServer(
              command,
              port,
              (status, message) => {
                this.currentServerStatus = status;
                this.currentStatusMessage = message || '';
                this.sendUpdateStatus();

                // Auto-fetch server props when ready
                if (status === 'ready') {
                  this.fetchAndSendServerProps();
                }
              }
            );
          } else {
            vscode.window.showErrorMessage(`Model "${data.modelId}" not found in config.`);
          }
          break;

        case 'stopServer':
          await this.serverController.stopServer();
          this.currentServerStatus = 'idle';
          this.currentStatusMessage = 'Server stopped';
          this.sendUpdateStatus();
          this._view?.webview.postMessage({ type: 'serverProps', props: null });
          break;

        case 'sendMessage':
          this.handleSendMessage(
            data.messages,
            data.includeActiveFile,
            data.includeWorkspaceMap,
            data.attachedFiles,
            data.attachedImages,
            data.temperature,
            data.maxTokens,
            data.topP,
            data.systemPrompt,
            data.enableTools
          );
          break;

        case 'abortMessage':
          this.abortRequested = true;
          if (this.activeRequest) {
            this.activeRequest.destroy();
            this.activeRequest = undefined;
            this._view?.webview.postMessage({ type: 'streamEnd' });
          }
          break;

        case 'indexCodebase':
          this.indexCodebase();
          break;

        case 'openWebUI':
          const serverUrl = this.serverController.getServerUrl();
          vscode.env.openExternal(vscode.Uri.parse(serverUrl));
          break;

        case 'getServerProps':
          this.fetchAndSendServerProps();
          break;

        case 'tokenize':
          try {
            const port = this.serverController.getPort();
            const result = await this.serverController.tokenizeText(port, data.text || '');
            this._view?.webview.postMessage({
              type: 'tokenizeResult',
              count: result.tokens ? result.tokens.length : 0
            });
          } catch {
            this._view?.webview.postMessage({ type: 'tokenizeResult', count: -1 });
          }
          break;

        case 'toolAction':
          if (data.action === 'rejectAll') {
            for (const backup of this.turnFileBackups.values()) {
              await vscode.workspace.fs.writeFile(backup.uri, Buffer.from(backup.originalContent, 'utf-8'));
            }
            this.turnFileBackups.clear();
            this._view?.webview.postMessage({ type: 'turnActionComplete', action: 'rejectAll' });
          } else if (data.action === 'acceptAll') {
            this.turnFileBackups.clear();
            this._view?.webview.postMessage({ type: 'turnActionComplete', action: 'acceptAll' });
          } else if (data.action === 'reviewFile' && data.filePath) {
            const backup = this.turnFileBackups.get(data.filePath);
            if (backup) {
              const os = require('os');
              const path = require('path');
              const tempPath = path.join(os.tmpdir(), `local-llm-original-${Date.now()}-${path.basename(backup.uri.fsPath)}`);
              const tempUri = vscode.Uri.file(tempPath);
              await vscode.workspace.fs.writeFile(tempUri, Buffer.from(backup.originalContent, 'utf-8'));
              await vscode.commands.executeCommand('vscode.diff', tempUri, backup.uri, `Review: ${path.basename(backup.uri.fsPath)}`);
            }
          }
          break;

        // ─── Setup / Config Messages ─────────────────────────────────
        case 'getLlamaCppPath':
          this.sendLlamaCppPath();
          break;

        case 'saveLlamaCppPath':
          await this.saveLlamaCppPath(data.path);
          break;

        case 'browseLlamaCppPath':
          await this.browseLlamaCppPath();
          break;

        case 'browseModelFile':
          await this.browseModelFile();
          break;

        case 'browseMmprojFile':
          await this.browseMmprojFile();
          break;

        case 'addModel':
          await this.addModel(data.model);
          break;

        case 'updateModel':
          await this.updateModel(data.modelId, data.model);
          break;

        case 'deleteModel':
          await this.deleteModel(data.modelId);
          break;

        // ─── Tool Configuration Messages ─────────────────────────────
        case 'getToolConfig':
          this._view?.webview.postMessage({
            type: 'toolConfig',
            categories: TOOL_CATEGORIES,
            disabledTools: Array.from(this.disabledTools)
          });
          break;

        case 'updateDisabledTools':
          this.disabledTools = new Set(data.disabledTools || []);
          this._context.globalState.update('localLlm.disabledTools', Array.from(this.disabledTools));
          break;
          
        // ─── Mentions & Attachments ──────────────────────────────────
        case 'getWorkspaceFiles':
          try {
            // Find all files in the workspace excluding common ignores
            const excludePattern = '**/{node_modules,.git,dist,out,build,.next,coverage}/**';
            const files = await vscode.workspace.findFiles('**/*', excludePattern, 1000); // Limit to 1000 files to keep it snappy
            
            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!workspaceRoot) {
              this._view?.webview.postMessage({ type: 'workspaceFiles', files: [] });
              break;
            }

            // Convert to relative paths
            const relativePaths = files.map(file => {
              const relative = path.relative(workspaceRoot, file.fsPath);
              const basename = path.basename(relative);
              return { path: relative, basename };
            });

            this._view?.webview.postMessage({ type: 'workspaceFiles', files: relativePaths });
          } catch (e) {
            console.error('Error fetching workspace files:', e);
            this._view?.webview.postMessage({ type: 'workspaceFiles', files: [] });
          }
          break;
      }
    });
  }

  // ─── Setup / Config Handlers ─────────────────────────────────────────────

  private getSessions(): ChatSession[] {
    return this._context.globalState.get<ChatSession[]>('localLlm.sessions') || [];
  }

  private sendSessionsToWebview() {
    this._view?.webview.postMessage({
      type: 'sessionsList',
      sessions: this.getSessions()
    });
  }

  private saveSession(session: ChatSession) {
    const sessions = this.getSessions();
    const existingIndex = sessions.findIndex(s => s.id === session.id);
    if (existingIndex >= 0) {
      sessions[existingIndex] = session;
    } else {
      sessions.unshift(session);
    }
    this._context.globalState.update('localLlm.sessions', sessions);
    this.sendSessionsToWebview();
  }

  private deleteSession(sessionId: string) {
    const sessions = this.getSessions();
    const newSessions = sessions.filter(s => s.id !== sessionId);
    this._context.globalState.update('localLlm.sessions', newSessions);
    this.sendSessionsToWebview();
  }

  private sendLlamaCppPath() {
    const llamaCppPath = vscode.workspace.getConfiguration('localLlm').get<string>('llamaCppPath') || '';
    this._view?.webview.postMessage({ type: 'llamaCppPath', path: llamaCppPath });
  }

  private async saveLlamaCppPath(newPath: string) {
    await vscode.workspace.getConfiguration('localLlm').update('llamaCppPath', newPath, vscode.ConfigurationTarget.Global);
    this.sendLlamaCppPath();
  }

  private async browseLlamaCppPath() {
    const result = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: 'Select llama.cpp Directory',
      title: 'Select llama.cpp Build Directory'
    });

    if (result && result.length > 0) {
      const folderPath = result[0].fsPath;
      await this.saveLlamaCppPath(folderPath);
    }
  }

  private async browseModelFile() {
    const result = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      openLabel: 'Select Model File',
      title: 'Select a .gguf Model File',
      filters: {
        'GGUF Models': ['gguf'],
        'All Files': ['*']
      }
    });

    if (result && result.length > 0) {
      this._view?.webview.postMessage({
        type: 'browseModelResult',
        path: result[0].fsPath
      });
    }
  }

  private async browseMmprojFile() {
    const result = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      openLabel: 'Select Projector File',
      title: 'Select a Multimodal Projector (.gguf) File',
      filters: {
        'GGUF Models': ['gguf'],
        'All Files': ['*']
      }
    });

    if (result && result.length > 0) {
      this._view?.webview.postMessage({
        type: 'browseMmprojResult',
        path: result[0].fsPath
      });
    }
  }

  private async addModel(modelData: any) {
    const models = this.getModelsFromConfig();
    
    // Generate a unique ID
    const id = modelData.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') 
      + '-' + Date.now().toString(36).slice(-4);

    const newModel: any = {
      id,
      name: modelData.name,
      modelPath: modelData.modelPath,
      mmprojPath: modelData.mmprojPath,
      contextSize: modelData.contextSize || 4096,
      gpuLayers: modelData.gpuLayers ?? 99,
      port: modelData.port || 8080,
      enableTools: modelData.enableTools || false
    };

    models.push(newModel);
    await vscode.workspace.getConfiguration('localLlm').update('models', models, vscode.ConfigurationTarget.Global);
    
    this.sendModelsToWebview();
    this._view?.webview.postMessage({ type: 'modelAdded', model: newModel });
  }

  private async updateModel(modelId: string, modelData: any) {
    const models = this.getModelsFromConfig();
    const index = models.findIndex((m: any) => m.id === modelId);
    
    if (index !== -1) {
      // Preserve id and command if present
      const updatedModel: any = {
        ...models[index],
        name: modelData.name,
        modelPath: modelData.modelPath,
        mmprojPath: modelData.mmprojPath,
        contextSize: modelData.contextSize || 4096,
        gpuLayers: modelData.gpuLayers ?? 99,
        port: modelData.port || 8080,
        enableTools: modelData.enableTools || false
      };
      
      models[index] = updatedModel;
      await vscode.workspace.getConfiguration('localLlm').update('models', models, vscode.ConfigurationTarget.Global);
      
      // If we're updating the currently active model, we might want to restart it, 
      // but for now we'll just let the user manually stop/start it
      
      this.sendModelsToWebview();
      this._view?.webview.postMessage({ type: 'modelUpdated', model: updatedModel });
    }
  }

  private async deleteModel(modelId: string) {
    let models = this.getModelsFromConfig();
    models = models.filter(m => m.id !== modelId);
    await vscode.workspace.getConfiguration('localLlm').update('models', models, vscode.ConfigurationTarget.Global);
    
    if (this.selectedModelId === modelId) {
      this.selectedModelId = '';
      await this.serverController.stopServer();
      this.currentServerStatus = 'idle';
      this.currentStatusMessage = 'Model removed';
      this.sendUpdateStatus();
    }
    
    this.sendModelsToWebview();
    this._view?.webview.postMessage({ type: 'modelDeleted', modelId });
  }

  /**
   * Build the llama-server shell command from model config.
   * If the model has a custom `command` field, use that directly.
   * Otherwise, auto-generate from llamaCppPath + modelPath + other settings.
   */
  private buildServerCommand(model: any): string | null {
    // Custom command override — use directly
    if (model.command && model.command.trim()) {
      return model.command;
    }

    const llamaCppPath = vscode.workspace.getConfiguration('localLlm').get<string>('llamaCppPath') || '';
    const modelPath = model.modelPath || '';

    if (!llamaCppPath || !modelPath) {
      return null;
    }

    const port = model.port || 8080;
    const contextSize = model.contextSize || 4096;
    const gpuLayers = model.gpuLayers ?? 99;
    const enableTools = model.enableTools || false;

    // Build the command
    let cmd = `cd '${llamaCppPath}' && ./build-release/bin/llama-server`;
    cmd += ` -m '${modelPath}'`;
    cmd += ` -ngl ${gpuLayers}`;
    cmd += ` -c ${contextSize}`;
    cmd += ` --port ${port}`;

    if (model.mmprojPath && model.mmprojPath.trim()) {
      cmd += ` --mmproj '${model.mmprojPath.trim()}'`;
    }
    
    // Always enable embeddings so we can use semantic search
    cmd += ' --embedding';
    
    if (enableTools) {
      cmd += ' --jinja';
    }

    return cmd;
  }

  // ─── Existing Methods ────────────────────────────────────────────────────

  private sendContextUpdate() {
    const editor = vscode.window.activeTextEditor;
    const hasWorkspace = !!(vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0);
    const workspaceName = hasWorkspace ? vscode.workspace.workspaceFolders![0].name : '';

    if (editor) {
      const isSelectionEmpty = editor.selection.isEmpty;
      const fileName = editor.document.fileName.split(/[\\/]/).pop() || '';
      const activeFileLineCount = editor.document.lineCount;
      const selectionLineCount = isSelectionEmpty ? 0 : editor.document.getText(editor.selection).split('\n').length;
      
      this._view?.webview.postMessage({
        type: 'contextUpdate',
        hasSelection: !isSelectionEmpty,
        selectionFileName: fileName,
        selectionLineCount,
        hasActiveFile: true,
        activeFileName: fileName,
        activeFileLineCount,
        hasWorkspace,
        workspaceName
      });
    } else {
      this._view?.webview.postMessage({
        type: 'contextUpdate',
        hasSelection: false,
        hasActiveFile: false,
        hasWorkspace,
        workspaceName
      });
    }
  }

  private getModelsFromConfig(): any[] {
    return vscode.workspace.getConfiguration('localLlm').get<any[]>('models') || [];
  }

  /** Check if the currently selected model has tools enabled */
  private isToolsEnabledForModel(): boolean {
    const models = this.getModelsFromConfig();
    const model = models.find(m => m.id === this.selectedModelId);
    return model?.enableTools === true;
  }

  private sendModelsToWebview() {
    const models = this.getModelsFromConfig();
    this._view?.webview.postMessage({
      type: 'modelsList',
      models: models.map(m => ({
        id: m.id,
        name: m.name,
        enableTools: m.enableTools || false,
        modelPath: m.modelPath || '',
        contextSize: m.contextSize || 4096,
        gpuLayers: m.gpuLayers ?? 99,
        port: m.port || 8080,
        hasCustomCommand: !!(m.command && m.command.trim())
      })),
      selectedId: this.selectedModelId
    });
  }

  private sendUpdateStatus() {
    this._view?.webview.postMessage({
      type: 'statusUpdate',
      status: this.currentServerStatus,
      message: this.currentStatusMessage
    });
  }

  private async fetchAndSendServerProps() {
    try {
      const port = this.serverController.getPort();
      const props = await this.serverController.fetchServerProps(port);
      this._view?.webview.postMessage({ type: 'serverProps', props });
    } catch {
      this._view?.webview.postMessage({ type: 'serverProps', props: null });
    }
  }

  public async indexCodebase() {
    if (this.currentServerStatus !== 'ready') {
      vscode.window.showErrorMessage('Local LLM Server is not ready. Start a model with --embedding support first.');
      return;
    }

    try {
      const port = this.serverController.getPort();
      await SemanticSearch.indexWorkspace(this.serverController, port, (msg) => {
        // Send progress updates to the webview UI
        this._view?.webview.postMessage({ type: 'indexProgress', text: msg });
        vscode.window.setStatusBarMessage(`Semantic Search: ${msg}`, 3000);
      });
      vscode.window.showInformationMessage('Codebase successfully indexed for Semantic Search!');
      this._view?.webview.postMessage({ type: 'indexProgress', text: 'Indexing complete!' });
    } catch (e: any) {
      vscode.window.showErrorMessage(`Failed to index codebase: ${e.message}`);
      this._view?.webview.postMessage({ type: 'error', text: `Failed to index codebase: ${e.message}` });
    }
  }

  private async handleSendMessage(
    messages: any[],
    includeActiveFile: boolean,
    includeWorkspaceMap: boolean,
    attachedFiles?: any[],
    attachedImages?: any[],
    temperature?: number,
    maxTokens?: number,
    topP?: number,
    systemPrompt?: string,
    enableTools?: boolean
  ) {
    if (this.currentServerStatus !== 'ready') {
      this._view?.webview.postMessage({
        type: 'error',
        text: 'Server not ready. Start a model first.'
      });
      return;
    }

    this.abortRequested = false;
    this.turnFileBackups.clear();
    const useTools = enableTools && this.isToolsEnabledForModel();

    const editor = vscode.window.activeTextEditor;
    let enrichedMessages = [...messages];

    // If tools are enabled, use the agentic system prompt as base
    if (useTools) {
      const customSystemAddition = systemPrompt?.trim() ? `\n\nAdditional user instructions:\n${systemPrompt.trim()}` : '';
      const fullSystemPrompt = AGENTIC_SYSTEM_PROMPT + customSystemAddition;
      
      if (enrichedMessages.length > 0 && enrichedMessages[0].role === 'system') {
        enrichedMessages[0] = { role: 'system', content: fullSystemPrompt };
      } else {
        enrichedMessages.unshift({ role: 'system', content: fullSystemPrompt });
      }
    } else if (systemPrompt && systemPrompt.trim()) {
      if (enrichedMessages.length > 0 && enrichedMessages[0].role === 'system') {
        enrichedMessages[0] = { role: 'system', content: systemPrompt.trim() };
      } else {
        enrichedMessages.unshift({ role: 'system', content: systemPrompt.trim() });
      }
    }

    let attachedContext: any = null;

    // 1. Check if there is highlighted code (this takes priority over full file)
    if (editor && !editor.selection.isEmpty) {
      const doc = editor.document;
      const selectionText = doc.getText(editor.selection);
      const fileName = doc.fileName.split(/[\\/]/).pop() || '';
      const languageId = doc.languageId;

      attachedContext = {
        type: 'selection',
        fileName,
        lineCount: selectionText.split('\n').length
      };

      const lastIdx = enrichedMessages.length - 1;
      if (lastIdx >= 0 && enrichedMessages[lastIdx].role === 'user') {
        const originalContent = enrichedMessages[lastIdx].content;
        enrichedMessages[lastIdx].content = `[Context from file: "${fileName}"]\n\`\`\`${languageId}\n${selectionText}\n\`\`\`\n\nQuestion:\n${originalContent}`;
      }
    } else if (includeActiveFile && editor) {
      // 2. Full active file context
      const doc = editor.document;
      let fileText = doc.getText();
      const fileName = doc.fileName.split(/[\\/]/).pop() || '';
      const languageId = doc.languageId;
      const originalLines = doc.lineCount;
      let isTruncated = false;

      if (originalLines > 1000) {
        fileText = fileText.split('\n').slice(0, 1000).join('\n') + `\n\n// [... truncated remaining ${originalLines - 1000} lines for context limits ...]`;
        isTruncated = true;
      }

      attachedContext = {
        type: 'file',
        fileName,
        lineCount: isTruncated ? 1000 : originalLines,
        isTruncated
      };

      const lastIdx = enrichedMessages.length - 1;
      if (lastIdx >= 0 && enrichedMessages[lastIdx].role === 'user') {
        const originalContent = enrichedMessages[lastIdx].content;
        enrichedMessages[lastIdx].content = `[Context of full open file: "${fileName}"]\n\`\`\`${languageId}\n${fileText}\n\`\`\`\n\nQuestion:\n${originalContent}`;
      }
    }

    // 3. Include Workspace File List if enabled and folder is open
    let workspaceMapAttached = false;
    if (includeWorkspaceMap) {
      const workspacePaths = await this.getWorkspaceFiles();
      if (workspacePaths.length > 0) {
        workspaceMapAttached = true;
        const workspaceName = vscode.workspace.workspaceFolders?.[0]?.name || 'Project';
        const fileListStr = workspacePaths.map(p => `- ${p}`).join('\n');
        
        const lastIdx = enrichedMessages.length - 1;
        if (lastIdx >= 0 && enrichedMessages[lastIdx].role === 'user') {
          const originalContent = enrichedMessages[lastIdx].content;
          enrichedMessages[lastIdx].content = `[Workspace files list for project "${workspaceName}"]:\n${fileListStr}\n\n${originalContent}`;
        }
      }
    }

    // 4. Handle Semantic Search (@search tag)
    const lastIdx = enrichedMessages.length - 1;
    if (lastIdx >= 0 && enrichedMessages[lastIdx].role === 'user') {
      let originalContent = enrichedMessages[lastIdx].content;
      if (typeof originalContent === 'string' && originalContent.includes('@search')) {
        // Extract the query (everything after @search)
        const match = originalContent.match(/@search\s+(.*)/i);
        if (match && match[1]) {
          const query = match[1].trim();
          try {
            this._view?.webview.postMessage({ type: 'statusUpdate', status: 'generating', message: 'Searching codebase...' });
            const port = this.serverController.getPort();
            const topChunks = await SemanticSearch.search(this.serverController, port, query, 5);
            
            if (topChunks.length > 0) {
              let searchStr = `[Semantic Search Results for "${query}"]\n`;
              for (const chunk of topChunks) {
                searchStr += `\n---\nFile: ${chunk.file} (Lines ${chunk.startLine}-${chunk.endLine})\n\`\`\`\n${chunk.text}\n\`\`\`\n`;
              }
              // Remove the @search from the original content to not confuse the LLM
              originalContent = originalContent.replace(/@search\s+.*$/im, '').trim();
              enrichedMessages[lastIdx].content = `${searchStr}\nQuestion:\n${originalContent || query}`;
            }
          } catch (e: any) {
            this._view?.webview.postMessage({ type: 'error', text: `Semantic search failed: ${e.message}` });
          }
        }
      }
    }

    // 5. Process user-attached files via @ mentions
    if (attachedFiles && attachedFiles.length > 0) {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (workspaceRoot) {
        let attachmentsStr = '';
        for (const file of attachedFiles) {
          try {
            const absPath = path.join(workspaceRoot, file.path);
            const content = await fs.promises.readFile(absPath, 'utf8');
            const lines = content.split('\n');
            const isTruncated = lines.length > 1000;
            const textToInclude = isTruncated ? lines.slice(0, 1000).join('\n') + `\n\n// [... truncated remaining ${lines.length - 1000} lines ...]`: content;
            
            attachmentsStr += `[Attached File: "${file.path}"]\n\`\`\`\n${textToInclude}\n\`\`\`\n\n`;
          } catch (e) {
            console.error(`Failed to read attached file: ${file.path}`, e);
          }
        }
        
        if (attachmentsStr) {
          const lastIdx = enrichedMessages.length - 1;
          if (lastIdx >= 0 && enrichedMessages[lastIdx].role === 'user') {
            const originalContent = enrichedMessages[lastIdx].content;
            enrichedMessages[lastIdx].content = `${attachmentsStr}Question:\n${originalContent}`;
          }
        }
      }
    }

    // 5. Process user-attached images (Vision)
    if (attachedImages && attachedImages.length > 0) {
      const models = this.getModelsFromConfig();
      const activeModel = models.find(m => m.id === this.selectedModelId);
      
      if (!activeModel?.mmprojPath) {
        this._view?.webview.postMessage({
          type: 'error',
          text: 'This model is not configured for vision. Please attach an mmproj.gguf projector in the model settings, or use a different model.'
        });
        // Send a stop message to reset the UI state
        this._view?.webview.postMessage({ type: 'abortCompletion' });
        return;
      }

      const lastIdx = enrichedMessages.length - 1;
      if (lastIdx >= 0 && enrichedMessages[lastIdx].role === 'user') {
        const originalContent = enrichedMessages[lastIdx].content;
        
        // Convert to array format for multimodal requests
        const contentArray: any[] = [];
        
        // Add text first
        if (typeof originalContent === 'string') {
          contentArray.push({ type: 'text', text: originalContent });
        } else if (Array.isArray(originalContent)) {
          contentArray.push(...originalContent);
        }
        
        // Add all attached images
        for (const img of attachedImages) {
          contentArray.push({
            type: 'image_url',
            image_url: { url: img.dataUrl }
          });
        }
        
        enrichedMessages[lastIdx].content = contentArray;
      }
    }

    this._view?.webview.postMessage({
      type: 'messageContextAttached',
      context: attachedContext,
      workspaceMapAttached
    });

    if (useTools) {
      await this.runAgenticLoop(enrichedMessages, temperature, maxTokens, topP);
    } else {
      await this.streamChatCompletion(enrichedMessages, temperature, maxTokens, topP, false);
    }
  }

  /**
   * The agentic loop: send messages, check for tool calls, execute tools, repeat.
   */
  private async runAgenticLoop(
    messages: any[],
    temperature?: number,
    maxTokens?: number,
    topP?: number
  ) {
    let iteration = 0;

    while (iteration < MAX_TOOL_ITERATIONS) {
      if (this.abortRequested) {
        this._view?.webview.postMessage({ type: 'streamEnd' });
        return;
      }

      iteration++;
      this._view?.webview.postMessage({ type: 'streamStart' });
      const result = await this.streamChatCompletion(messages, temperature, maxTokens, topP, true);

      if (!result) return;

      if (result.toolCalls && result.toolCalls.length > 0) {
        const assistantMsg: any = { role: 'assistant', content: result.content || null };
        assistantMsg.tool_calls = result.toolCalls.map((tc: any) => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.function.name,
            arguments: tc.function.arguments
          }
        }));
        messages.push(assistantMsg);

        for (const toolCall of result.toolCalls) {
          if (this.abortRequested) {
            this._view?.webview.postMessage({ type: 'streamEnd' });
            return;
          }

          const funcName = toolCall.function.name;
          let funcArgs: Record<string, any> = {};
          try {
            funcArgs = JSON.parse(toolCall.function.arguments);
          } catch {
            funcArgs = {};
          }

          this._view?.webview.postMessage({
            type: 'toolCallStart',
            toolName: funcName,
            toolArgs: funcArgs,
            callId: toolCall.id
          });

          let toolResult = await executeToolCall(funcName, funcArgs);

          if (toolResult.needsConfirmation && toolResult.originalContent && toolResult.originalUri) {
            const fsPath = toolResult.originalUri.fsPath;
            if (this.turnFileBackups.has(fsPath)) {
              // File was already edited this turn, just update the cumulative stats
              const backup = this.turnFileBackups.get(fsPath)!;
              backup.addedLines += toolResult.addedLines || 0;
              backup.removedLines += toolResult.removedLines || 0;
            } else {
              // First time edited this turn, store original state
              this.turnFileBackups.set(fsPath, {
                uri: toolResult.originalUri,
                originalContent: toolResult.originalContent,
                addedLines: toolResult.addedLines || 0,
                removedLines: toolResult.removedLines || 0
              });
            }
          }

          this._view?.webview.postMessage({
            type: 'toolCallResult',
            toolName: funcName,
            callId: toolCall.id,
            success: toolResult.success,
            output: toolResult.output,
            denied: toolResult.denied,
            addedLines: toolResult.addedLines,
            removedLines: toolResult.removedLines
          });

          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: toolResult.output
          });
        }

        continue;
      } else {
        this._view?.webview.postMessage({ type: 'streamEnd' });
        break;
      }
    }
    if (iteration >= MAX_TOOL_ITERATIONS) {
      this._view?.webview.postMessage({
        type: 'toolCallResult',
        toolName: 'system',
        callId: 'max-iterations',
        success: false,
        output: `Reached maximum tool call limit (${MAX_TOOL_ITERATIONS} iterations). Stopping.`,
        denied: false
      });
      this._view?.webview.postMessage({ type: 'streamEnd' });
    }

    // Agentic loop finished, emit turn edits complete if there are any
    if (this.turnFileBackups.size > 0) {
      const editsList = Array.from(this.turnFileBackups.entries()).map(([fsPath, backup]) => {
        const path = require('path');
        return {
          fileName: path.basename(fsPath),
          filePath: fsPath,
          addedLines: backup.addedLines,
          removedLines: backup.removedLines
        };
      });

      this._view?.webview.postMessage({
        type: 'turnEditsComplete',
        edits: editsList
      });
    }
  }

  /**
   * Stream a single chat completion from the server.
   */
  private streamChatCompletion(
    messages: any[],
    temperature?: number,
    maxTokens?: number,
    topP?: number,
    collectToolCalls?: boolean
  ): Promise<{ content: string; toolCalls: any[] } | null> {
    return new Promise((resolve) => {
      const port = this.serverController.getPort();
      const useTools = collectToolCalls && this.isToolsEnabledForModel();

      const postBody: any = {
        messages,
        stream: true,
        temperature: typeof temperature === 'number' ? temperature : 0.7,
        max_tokens: typeof maxTokens === 'number' ? maxTokens : 2048,
        ...(typeof topP === 'number' ? { top_p: topP } : {}),
        stream_options: { include_usage: true }
      };

      if (useTools) {
        postBody.tools = TOOL_DEFINITIONS.filter(t => !this.disabledTools.has(t.function.name));
        postBody.tool_choice = 'auto';
      }

      const postData = JSON.stringify(postBody);

      const options = {
        hostname: '127.0.0.1',
        port,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        }
      };

      let buffer = '';
      let contentAccumulator = '';
      let toolCallsAccumulator: Record<number, { id: string; function: { name: string; arguments: string } }> = {};
      let isThinking = false;

      this.activeRequest = http.request(options, (res) => {
        if (res.statusCode !== 200) {
          this._view?.webview.postMessage({
            type: 'error',
            text: `Server error: HTTP ${res.statusCode}`
          });
          this._view?.webview.postMessage({ type: 'streamEnd' });
          resolve(null);
          return;
        }

        res.on('data', (chunk) => {
          buffer += chunk.toString();
          let newlineIdx = buffer.indexOf('\n');
          
          while (newlineIdx !== -1) {
            const line = buffer.substring(0, newlineIdx).trim();
            buffer = buffer.substring(newlineIdx + 1);
            
            if (line.startsWith('data: ')) {
              const dataStr = line.slice(6).trim();
              if (dataStr === '[DONE]') {
                const toolCalls = Object.values(toolCallsAccumulator);
                
                if (!collectToolCalls || toolCalls.length === 0) {
                  this._view?.webview.postMessage({ type: 'streamEnd' });
                  this.activeRequest = undefined;
                  resolve({ content: contentAccumulator, toolCalls: [] });
                } else {
                  this.activeRequest = undefined;
                  resolve({ content: contentAccumulator, toolCalls });
                }
                return;
              }
              
              try {
                const parsed = JSON.parse(dataStr);
                const delta = parsed.choices?.[0]?.delta;

                if (delta?.content) {
                  if (isThinking) {
                    contentAccumulator += '\n</think>\n';
                    this._view?.webview.postMessage({ type: 'streamChunk', text: '\n</think>\n' });
                    isThinking = false;
                  }
                  contentAccumulator += delta.content;
                  this._view?.webview.postMessage({ type: 'streamChunk', text: delta.content });
                }

                if (delta?.reasoning_content) {
                  if (!isThinking && !contentAccumulator.includes('<think>')) {
                    isThinking = true;
                    contentAccumulator += '<think>\n';
                    this._view?.webview.postMessage({ type: 'streamChunk', text: '<think>\n' });
                  }
                  contentAccumulator += delta.reasoning_content;
                  this._view?.webview.postMessage({ type: 'streamChunk', text: delta.reasoning_content });
                }

                if (delta?.tool_calls) {
                  for (const tc of delta.tool_calls) {
                    const idx = tc.index ?? 0;
                    if (!toolCallsAccumulator[idx]) {
                      toolCallsAccumulator[idx] = {
                        id: tc.id || `call_${idx}_${Date.now()}`,
                        function: { name: '', arguments: '' }
                      };
                    }
                    if (tc.id) {
                      toolCallsAccumulator[idx].id = tc.id;
                    }
                    if (tc.function?.name) {
                      toolCallsAccumulator[idx].function.name += tc.function.name;
                    }
                    if (tc.function?.arguments) {
                      toolCallsAccumulator[idx].function.arguments += tc.function.arguments;
                    }
                  }
                }

                if (parsed.usage) {
                  const model = this.getModelsFromConfig().find(m => m.id === this.selectedModelId);
                  this._view?.webview.postMessage({
                    type: 'tokenUsage',
                    usage: parsed.usage,
                    contextSize: model?.contextSize || 4096
                  });
                }
              } catch {
                // Ignore incomplete JSON chunks
              }
            }
            newlineIdx = buffer.indexOf('\n');
          }
        });

        res.on('end', () => {
          if (isThinking) {
            contentAccumulator += '\n</think>\n';
            this._view?.webview.postMessage({ type: 'streamChunk', text: '\n</think>\n' });
            isThinking = false;
          }

          const toolCalls = Object.values(toolCallsAccumulator);
          this.activeRequest = undefined;

          if (toolCalls.length > 0 && collectToolCalls) {
            resolve({ content: contentAccumulator, toolCalls });
          } else {
            this._view?.webview.postMessage({ type: 'streamEnd' });
            resolve({ content: contentAccumulator, toolCalls: [] });
          }
        });
      });

      this.activeRequest.on('error', (err) => {
        this._view?.webview.postMessage({
          type: 'error',
          text: `Error: ${err.message}. Is llama-server still running?`
        });
        this._view?.webview.postMessage({ type: 'streamEnd' });
        this.activeRequest = undefined;
        resolve(null);
      });

      this.activeRequest.write(postData);
      this.activeRequest.end();
    });
  }

  private _getHtmlForWebview(webview: vscode.Webview) {
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'media', 'style.css'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'media', 'main.js'));
    const nonce = getNonce();

    return `<!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'none';">
        <link href="${styleUri}" rel="stylesheet">
        <title>Local LLM Chat</title>
      </head>
      <body>
        <div class="chat-container">
          <!-- Generation Settings Panel (moved to top of chat-view temporarily or inside a modal-like layer, but let's just keep it absolute positioned or at the top of chat-view) -->
          <div class="settings-panel hidden" id="settings-panel" style="position: absolute; top: 0; left: 0; right: 0; background: var(--bg-primary); z-index: 100; border-bottom: 1px solid var(--border-color); padding: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.2);">
              <div class="settings-group">
                <div class="settings-label-row">
                  <label for="settings-temp">Temperature</label>
                  <span class="settings-val-badge" id="settings-temp-val">0.70</span>
                </div>
                <input type="range" id="settings-temp" min="0.1" max="1.5" step="0.05" value="0.70">
              </div>
              <div class="settings-group">
                <div class="settings-label-row">
                  <label for="settings-topp">Top-P</label>
                  <span class="settings-val-badge" id="settings-topp-val">0.90</span>
                </div>
                <input type="range" id="settings-topp" min="0.1" max="1.0" step="0.05" value="0.90">
              </div>
              <div class="settings-group">
                <div class="settings-label-row">
                  <label for="settings-max-tokens">Max Tokens</label>
                </div>
                <input type="number" id="settings-max-tokens" min="64" max="8192" step="64" value="2048">
              </div>
              <div class="settings-group">
                <div class="settings-label-row">
                  <label for="settings-system-prompt">System Prompt Override</label>
                </div>
                <textarea id="settings-system-prompt" rows="2" placeholder="Custom instructions for the LLM (e.g. 'Answer in emojis')..."></textarea>
              </div>
          </div>


          <!-- ═══ CONFIG VIEW ═══ -->
          <div class="config-view hidden" id="config-view">
            <div class="config-section">
              <div class="config-section-label">LLAMA.CPP PATH</div>
              <div class="config-browse-row">
                <input type="text" class="config-input" id="llamacpp-path-input" placeholder="/path/to/llama.cpp" spellcheck="false">
                <button class="config-browse-btn" id="llamacpp-browse-btn">Browse</button>
              </div>
              <div class="config-hint">Path to your llama.cpp build directory</div>
            </div>

            <div class="config-section">
              <div class="config-section-label">YOUR MODELS</div>
              <div class="config-models-list" id="config-models-list">
                <!-- Model cards will be rendered here by JS -->
              </div>
              <button class="config-add-model-btn" id="config-add-model-btn">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                Add New Model
              </button>
            </div>

            <!-- Add Model Form (hidden by default) -->
            <div class="config-add-form hidden" id="config-add-form">
              <div class="config-section-label">ADD MODEL</div>
              
              <div class="config-form-group">
                <label for="form-model-name">Model Name</label>
                <input type="text" class="config-input" id="form-model-name" placeholder="e.g. Qwythos 9B Agent" spellcheck="false">
              </div>

              <div class="config-form-group">
                <label for="form-model-path">Model File (.gguf)</label>
                <div class="config-browse-row">
                  <input type="text" class="config-input" id="form-model-path" placeholder="/path/to/model.gguf" spellcheck="false">
                  <button class="config-browse-btn" id="form-browse-model-btn">Browse</button>
                </div>
              </div>

              <div class="config-form-group">
                <label for="form-mmproj-path">Multimodal Projector (.gguf) (Optional)</label>
                <div class="config-browse-row">
                  <input type="text" class="config-input" id="form-mmproj-path" placeholder="/path/to/mmproj.gguf (for vision)" spellcheck="false">
                  <button class="config-browse-btn" id="form-browse-mmproj-btn">Browse</button>
                </div>
              </div>

              <div class="config-form-row">
                <div class="config-form-group config-form-half">
                  <label for="form-context-size">Context Size</label>
                  <input type="number" class="config-input" id="form-context-size" value="4096" min="512" step="512">
                </div>
                <div class="config-form-group config-form-half">
                  <label for="form-port">Port</label>
                  <input type="number" class="config-input" id="form-port" value="8080" min="1024" max="65535">
                </div>
              </div>

              <div class="config-form-group">
                <label for="form-gpu-layers">GPU Layers (-ngl)</label>
                <input type="number" class="config-input" id="form-gpu-layers" value="99" min="-1" max="999">
                <div class="config-hint">99 = full GPU offload. -1 = auto. 0 = CPU only.</div>
              </div>

              <div class="config-form-group">
                <div class="config-toggle-row">
                  <label>Enable Agent Tools</label>
                  <label class="toggle-switch">
                    <input type="checkbox" id="form-enable-tools">
                    <span class="toggle-slider"></span>
                  </label>
                </div>
                <div class="config-hint">Enables AI to read/write files, run commands, etc. Requires a tool-calling capable model.</div>
              </div>

              <div class="config-form-buttons">
                <button class="config-save-btn" id="config-save-model-btn">Save Model</button>
                <button class="config-cancel-btn" id="config-cancel-btn">Cancel</button>
              </div>
            </div>
          </div>

          <!-- ═══ MAIN CHAT CONTAINER ═══ -->
          <div class="main-chat-container" id="chat-view">
            <!-- Scrollable View Area -->
            <div class="view-area">
              
              <!-- Sessions View -->
              <div class="sessions-view hidden" id="sessions-view">
                <div class="sessions-header">
                  <div class="sessions-title">SESSIONS</div>
                  <div class="sessions-actions">
                    <button class="sessions-action-btn" id="sessions-refresh-btn" title="Refresh">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>
                    </button>
                    <button class="sessions-action-btn" id="sessions-search-btn" title="Search">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                    </button>
                    <button class="sessions-action-btn" id="sessions-filter-btn" title="Filter">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>
                    </button>
                  </div>
                </div>
                <div class="sessions-list" id="sessions-list">
                  <!-- Session items dynamically injected -->
                </div>
              </div>

              <!-- Chat Messages View -->
              <div class="chat-messages-view" id="chat-messages-view">
                <div class="chat-header hidden" id="chat-header">
                  <button class="back-to-sessions-btn" id="back-to-sessions-btn" title="Back to Sessions">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline></svg>
                  </button>
                  <span class="chat-header-title" id="chat-header-title">New Chat</span>
                </div>
                <div class="messages" id="messages-container">
                  <div class="welcome-message">
                    <h3>Local LLM Sidebar Chat</h3>
                    <p>Choose a model from the dropdown above. The extension will automatically spawn the llama-server command in your VS Code terminal and connect to it.</p>
                    <p style="font-size: 11px; margin-top: 10px; color: var(--accent-color);">💡 Tip: Highlight any code in your editor to automatically attach it to your prompts!</p>
                  </div>
                </div>
              </div>
            </div> <!-- closes view-area -->

            <div class="input-area">
              <div class="context-toggles">
                <button class="context-toggle-btn" id="toggle-active-file" title="Attach full active file" disabled>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="margin-right: 3px;"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                  <span id="active-file-label">No Active File</span>
                </button>
                <button class="context-toggle-btn" id="toggle-workspace" title="Attach list of files in project" disabled>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="margin-right: 3px;"><rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/></svg>
                  <span id="workspace-label">No Workspace</span>
                </button>
              </div>

              <div id="selection-bar" class="selection-bar hidden">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right: 4px;"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
                <span id="selection-text">Attached: index.ts (10 lines)</span>
              </div>

              <div class="tools-toggle-row" id="tools-toggle-row" style="display: none;">
                <button class="context-toggle-btn tools-toggle-btn" id="toggle-tools" title="Enable agentic tool calling">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="margin-right: 3px;"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>
                  <span>Agent Tools</span>
                </button>
                <button class="context-toggle-btn tools-config-btn" id="configure-tools-btn" title="Configure which tools are available" style="display: none;">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right: 3px;"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
                  <span id="tools-config-count">17 Tools</span>
                </button>
              </div>

              <!-- Tool Configuration Modal -->
              <div id="tool-config-modal" class="tool-config-modal hidden">
                <div class="tool-config-header">
                  <span class="tool-config-title">Configure Tools</span>
                  <button id="tool-config-close" class="tool-config-close-btn">&times;</button>
                </div>
                <div class="tool-config-body" id="tool-config-body">
                  <!-- Populated dynamically -->
                </div>
              </div>

              <!-- Dedicated container for the worktree review block -->
              <div id="worktree-container"></div>

              <div id="attachment-tags" class="attachment-tags hidden"></div>
              
              <div class="tokenizer-row">
                <textarea id="chat-input" placeholder="Type a message... (Type @ to attach files)" rows="1" disabled></textarea>
                <div id="mentions-dropdown" class="mentions-dropdown hidden"></div>
              </div>
              <div class="action-buttons">
                <div class="action-buttons-left" style="display: flex; gap: 6px;">
                  <button class="token-count-btn attach-image-btn" id="attach-image-btn" title="Attach Image" disabled>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
                  </button>
                  <input type="file" id="image-upload-input" accept="image/*" multiple style="display: none;">
                  <button class="token-count-btn index-codebase-btn" id="index-codebase-btn" title="Index Codebase (Semantic Search)" disabled>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
                  </button>
                  <button class="token-count-btn" id="token-count-btn" title="Count tokens in current input" disabled>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg>
                    <span id="token-count-label">Tokens</span>
                  </button>
                </div>
                <div class="action-buttons-right">
                <button class="clear-btn" id="clear-btn" title="Clear Chat">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6"/></svg>
                </button>
                <button class="send-btn" id="send-btn" disabled>
                  <svg id="send-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
                  <svg id="stop-generation-icon" class="hidden" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
                </button>
                </div>
              </div>
            </div> <!-- closes input-area -->
          </div> <!-- closes main-chat-container -->

          <!-- Compact Footer -->
          <div class="chat-footer">
            <div class="footer-left" id="status-bar" title="Select a model to begin">
              <span class="status-indicator idle" id="status-indicator"></span>
              <select id="model-select" class="compact-select">
                <option value="" disabled selected>Loading models...</option>
              </select>
              <button class="stop-btn" id="stop-btn" title="Stop Server" style="display: none;">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
              </button>
              <button class="stop-btn" id="start-btn" title="Start Server" style="display: none;">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="5 3 19 12 5 21 5 3"/></svg>
              </button>
            </div>
            <div class="footer-right">
              <span class="context-usage" id="context-usage-label" style="display: none;" title="Context Usage">0 / 4096</span>
              <button class="footer-btn" id="open-webui-btn" title="Open llama.cpp Web UI" style="display: none;">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
              </button>
              <button class="footer-btn" id="settings-toggle-btn" title="Settings">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
              </button>
              <button class="footer-btn config-toggle-btn" id="config-toggle-btn" title="Model Setup">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
              </button>
              <button class="footer-btn sessions-toggle-btn" id="sessions-toggle-btn" title="View Sessions">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
              </button>
              <button class="footer-btn" id="new-session-btn" title="New Session">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              </button>
            </div>
          </div>
        </div>

        <script nonce="${nonce}" src="${scriptUri}"></script>
      </body>
      </html>`;
  }

  private async getWorkspaceFiles(): Promise<string[]> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return [];
    }

    const excludePattern = '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/.vscode/**,**/*.vsix,**/*.png,**/*.jpg,**/*.jpeg,**/*.gif,**/*.svg,**/*.gguf,**/*.zip,**/*.tar.gz}';
    
    try {
      const uris = await vscode.workspace.findFiles('**/*', excludePattern, 150);
      const paths = uris.map(uri => vscode.workspace.asRelativePath(uri));
      return paths.sort();
    } catch (e) {
      return [];
    }
  }
}

function getNonce() {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
