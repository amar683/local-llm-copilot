import * as vscode from 'vscode';
import { ServerController } from './serverController';
import * as http from 'http';

class InlineEditProvider implements vscode.TextDocumentContentProvider {
  private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  private contents = new Map<string, string>();

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.path) || '';
  }

  setContent(path: string, content: string) {
    this.contents.set(path, content);
    this._onDidChange.fire(vscode.Uri.parse(`local-llm-inline:${path}`));
  }
}

// Store pending edits so the accept command knows what to do
export const pendingInlineEdits = new Map<string, {
  originalUri: vscode.Uri,
  selection: vscode.Selection,
  newCode: string
}>();

export function registerInlineChat(context: vscode.ExtensionContext, serverController: ServerController) {
  const provider = new InlineEditProvider();
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('local-llm-inline', provider));

  const disposable = vscode.commands.registerCommand('localLlm.inlineChat', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage('No active editor.');
      return;
    }

    if (!serverController.isServerReady()) {
      vscode.window.showErrorMessage('Local LLM Server is not ready. Please start a model first.');
      return;
    }

    const selection = editor.selection;
    if (selection.isEmpty) {
      vscode.window.showInformationMessage('Please select some code to edit.');
      return;
    }

    const selectedText = editor.document.getText(selection);

    const userInput = await vscode.window.showInputBox({
      prompt: 'What do you want to do with the selected code?',
      placeHolder: 'e.g. Add comments, Refactor this, Fix the bug'
    });

    if (!userInput) return; // User cancelled

    const systemPrompt = `You are an expert software engineer.
The user wants you to modify the provided code.
Reply ONLY with the new code. Do not include markdown code blocks (\`\`\`) unless they are part of the code itself.
Do NOT include any explanations, greetings, or pleasantries. JUST THE RAW CODE.`;

    const userMessage = `Instruction: ${userInput}\n\nCode to modify:\n${selectedText}`;

    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: "Local LLM: Editing code...",
      cancellable: true
    }, async (progress, token) => {
      
      const port = serverController.getPort();
      
      const postBody = {
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage }
        ],
        stream: false,
        temperature: 0.2, // Low temperature for more deterministic edits
        max_tokens: 2048
      };

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

      return new Promise<void>((resolve, reject) => {
        const req = http.request(options, (res) => {
          let buffer = '';
          res.on('data', (chunk) => { buffer += chunk.toString(); });
          res.on('end', async () => {
            if (res.statusCode !== 200) {
              vscode.window.showErrorMessage(`Server error: HTTP ${res.statusCode}`);
              reject();
              return;
            }
            try {
              const data = JSON.parse(buffer);
              let newCode = data.choices[0].message.content;
              
              // Clean up markdown blocks if the model ignored the system prompt
              if (newCode.startsWith('\`\`\`')) {
                const lines = newCode.split('\n');
                if (lines.length > 1) {
                  lines.shift(); // remove opening ```
                  if (lines[lines.length - 1].trim() === '\`\`\`') {
                    lines.pop(); // remove closing ```
                  }
                  newCode = lines.join('\n');
                }
              }

              // Create full file content with replacement
              const fullText = editor.document.getText();
              const before = fullText.substring(0, editor.document.offsetAt(selection.start));
              const after = fullText.substring(editor.document.offsetAt(selection.end));
              const newFullText = before + newCode + after;

              const editId = Date.now().toString();
              const virtualPath = `/${editId}/${editor.document.fileName.split('/').pop() || 'edit'}`;
              const virtualUri = vscode.Uri.parse(`local-llm-inline:${virtualPath}`);
              
              provider.setContent(virtualPath, newFullText);
              pendingInlineEdits.set(virtualPath, {
                originalUri: editor.document.uri,
                selection,
                newCode
              });

              await vscode.commands.executeCommand(
                'vscode.diff',
                editor.document.uri,
                virtualUri,
                'Local LLM: Review Edit'
              );
              resolve();
            } catch (e) {
              vscode.window.showErrorMessage('Failed to parse LLM response.');
              reject(e);
            }
          });
        });

        req.on('error', (err) => {
          vscode.window.showErrorMessage(`Request failed: ${err.message}`);
          reject(err);
        });

        token.onCancellationRequested(() => {
          req.destroy();
          resolve();
        });

        req.write(postData);
        req.end();
      });
    });
  });

  context.subscriptions.push(disposable);

  context.subscriptions.push(vscode.commands.registerCommand('localLlm.acceptInlineEdit', async (uri: vscode.Uri) => {
    let virtualUri = uri;
    if (!virtualUri) {
      const activeEditor = vscode.window.activeTextEditor;
      if (activeEditor && activeEditor.document.uri.scheme === 'local-llm-inline') {
        virtualUri = activeEditor.document.uri;
      }
    }

    if (!virtualUri || virtualUri.scheme !== 'local-llm-inline') return;

    const pendingEdit = pendingInlineEdits.get(virtualUri.path);
    if (!pendingEdit) {
      vscode.window.showErrorMessage('Edit state lost.');
      return;
    }

    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

    const doc = await vscode.workspace.openTextDocument(pendingEdit.originalUri);
    const editor = await vscode.window.showTextDocument(doc);
    
    // Apply the edit to the original document
    const workspaceEdit = new vscode.WorkspaceEdit();
    workspaceEdit.replace(pendingEdit.originalUri, pendingEdit.selection, pendingEdit.newCode);
    await vscode.workspace.applyEdit(workspaceEdit);
    
    pendingInlineEdits.delete(virtualUri.path);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('localLlm.rejectInlineEdit', async (uri: vscode.Uri) => {
    let virtualUri = uri;
    if (!virtualUri) {
      const activeEditor = vscode.window.activeTextEditor;
      if (activeEditor && activeEditor.document.uri.scheme === 'local-llm-inline') {
        virtualUri = activeEditor.document.uri;
      }
    }
    
    if (virtualUri && virtualUri.scheme === 'local-llm-inline') {
      pendingInlineEdits.delete(virtualUri.path);
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    }
  }));
}
