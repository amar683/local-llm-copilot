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

    // Track editor selection changes to display active context indicator in Webview
    const selectionDisposable = vscode.window.onDidChangeTextEditorSelection(() => this.sendSelectionUpdate());
    const editorDisposable = vscode.window.onDidChangeActiveTextEditor(() => this.sendSelectionUpdate());

    webviewView.onDidDispose(() => {
      selectionDisposable.dispose();
      editorDisposable.dispose();
    });

    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.type) {
        case 'getModels':
          this.sendModelsToWebview();
          this.sendUpdateStatus();
          this.sendSelectionUpdate();
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
          this.handleSendMessage(data.messages);
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

  private sendSelectionUpdate() {
    const editor = vscode.window.activeTextEditor;
    if (editor && !editor.selection.isEmpty) {
      const text = editor.document.getText(editor.selection);
      this._view?.webview.postMessage({
        type: 'selectionUpdate',
        hasSelection: true,
        fileName: editor.document.fileName.split(/[\\/]/).pop(),
        lineCount: text.split('\n').length
      });
    } else {
      this._view?.webview.postMessage({
        type: 'selectionUpdate',
        hasSelection: false
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

  private handleSendMessage(messages: any[]) {
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

    // If there is highlighted code, inject it as context into the prompt
    if (editor && !editor.selection.isEmpty) {
      const doc = editor.document;
      const selectionText = doc.getText(editor.selection);
      const fileName = doc.fileName.split(/[\\/]/).pop() || '';
      const languageId = doc.languageId;

      attachedContext = {
        fileName,
        code: selectionText,
        lineCount: selectionText.split('\n').length
      };

      const lastIdx = enrichedMessages.length - 1;
      if (lastIdx >= 0 && enrichedMessages[lastIdx].role === 'user') {
        const originalContent = enrichedMessages[lastIdx].content;
        enrichedMessages[lastIdx].content = `[Context from file: "${fileName}"]\n\`\`\`${languageId}\n${selectionText}\n\`\`\`\n\nQuestion:\n${originalContent}`;
      }
    }

    // Let the webview know if context was attached so it can render a file tag in the message bubble
    this._view?.webview.postMessage({
      type: 'messageContextAttached',
      context: attachedContext
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
}

function getNonce() {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
