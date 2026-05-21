import * as vscode from 'vscode';
import * as http from 'http';
import { ServerController } from './serverController';

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'localLlmChatView';
  private _view?: vscode.WebviewView;
  private currentServerStatus: 'idle' | 'starting' | 'ready' | 'error' = 'idle';
  private currentStatusMessage = 'Select a model to begin';
  private selectedModelId = '';
  private activeRequest: http.ClientRequest | undefined;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly serverController: ServerController
  ) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
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
          break;

        case 'selectModel':
          this.selectedModelId = data.modelId;
          const models = this.getModelsFromConfig();
          const model = models.find(m => m.id === data.modelId);
          if (model) {
            await this.serverController.startServer(
              model.command,
              model.port,
              (status, message) => {
                this.currentServerStatus = status;
                this.currentStatusMessage = message || '';
                this.sendUpdateStatus();
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
          break;

        case 'sendMessage':
          this.handleSendMessage(data.messages, data.includeActiveFile, data.includeWorkspaceMap);
          break;

        case 'abortMessage':
          if (this.activeRequest) {
            this.activeRequest.destroy();
            this.activeRequest = undefined;
            this._view?.webview.postMessage({ type: 'streamEnd' });
          }
          break;
      }
    });
  }

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

  private sendModelsToWebview() {
    const models = this.getModelsFromConfig();
    this._view?.webview.postMessage({
      type: 'modelsList',
      models: models.map(m => ({ id: m.id, name: m.name })),
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

  private async handleSendMessage(messages: any[], includeActiveFile: boolean, includeWorkspaceMap: boolean) {
    if (this.currentServerStatus !== 'ready') {
      this._view?.webview.postMessage({
        type: 'error',
        text: 'Server not ready. Start a model first.'
      });
      return;
    }

    const editor = vscode.window.activeTextEditor;
    let enrichedMessages = [...messages];
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

      // Truncate to first 1000 lines to prevent context bloat
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

    // Let the webview know what context was attached
    this._view?.webview.postMessage({
      type: 'messageContextAttached',
      context: attachedContext,
      workspaceMapAttached
    });

    const port = this.serverController.getPort();
    const postData = JSON.stringify({
      messages: enrichedMessages,
      stream: true,
      temperature: 0.7,
      max_tokens: 2048
    });

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

    this.activeRequest = http.request(options, (res) => {
      if (res.statusCode !== 200) {
        this._view?.webview.postMessage({
          type: 'error',
          text: `Server error: HTTP ${res.statusCode}`
        });
        this._view?.webview.postMessage({ type: 'streamEnd' });
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
              this._view?.webview.postMessage({ type: 'streamEnd' });
              this.activeRequest = undefined;
              return;
            }
            
            try {
              const parsed = JSON.parse(dataStr);
              const content = parsed.choices?.[0]?.delta?.content || '';
              if (content) {
                this._view?.webview.postMessage({ type: 'streamChunk', text: content });
              }
            } catch {
              // Ignore incomplete JSON chunks
            }
          }
          newlineIdx = buffer.indexOf('\n');
        }
      });

      res.on('end', () => {
        this._view?.webview.postMessage({ type: 'streamEnd' });
        this.activeRequest = undefined;
      });
    });

    this.activeRequest.on('error', (err) => {
      this._view?.webview.postMessage({
        type: 'error',
        text: `Error: ${err.message}. Is llama-server still running?`
      });
      this._view?.webview.postMessage({ type: 'streamEnd' });
      this.activeRequest = undefined;
    });

    this.activeRequest.write(postData);
    this.activeRequest.end();
  }

  private _getHtmlForWebview(webview: vscode.Webview) {
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'style.css'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'main.js'));
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
          <div class="header">
            <div class="selector-wrapper">
              <label for="model-select">Active Model</label>
              <select id="model-select">
                <option value="" disabled selected>Loading models...</option>
              </select>
            </div>
            
            <div class="status-bar" id="status-bar">
              <span class="status-indicator idle" id="status-indicator"></span>
              <span class="status-text" id="status-text">Select a model to begin</span>
              <button class="stop-btn" id="stop-btn" title="Stop Server" style="display: none;">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
              </button>
            </div>
          </div>

          <div class="messages" id="messages-container">
            <div class="welcome-message">
              <h3>Local LLM Sidebar Chat</h3>
              <p>Choose a model from the dropdown above. The extension will automatically spawn the llama-server command in your VS Code terminal and connect to it.</p>
              <p style="font-size: 11px; margin-top: 10px; color: var(--accent-color);">💡 Tip: Highlight any code in your editor to automatically attach it to your prompts!</p>
            </div>
          </div>

          <div class="input-area">
            <!-- Context toggles -->
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

            <!-- Active selection indicator -->
            <div id="selection-bar" class="selection-bar hidden">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right: 4px;"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
              <span id="selection-text">Attached: index.ts (10 lines)</span>
            </div>

            <textarea id="chat-input" placeholder="Type a message..." rows="1" disabled></textarea>
            <div class="action-buttons">
              <button class="clear-btn" id="clear-btn" title="Clear Chat">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6"/></svg>
              </button>
              <button class="send-btn" id="send-btn" disabled>
                <svg id="send-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
                <svg id="stop-generation-icon" class="hidden" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
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

    // Exclude node_modules, .git, binary media files, gguf models, and common zip folders
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
