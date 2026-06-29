import * as vscode from 'vscode';
import { ServerController } from './serverController';
import { ChatViewProvider } from './chatViewProvider';

import { registerInlineChat } from './inlineChatProvider';
import { registerCodeActions } from './codeActionProvider';

export function activate(context: vscode.ExtensionContext) {
  const controller = new ServerController();
  const provider = new ChatViewProvider(context, controller);

  registerInlineChat(context, controller);
  registerCodeActions(context, controller, provider);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider),
    
    vscode.commands.registerCommand('localLlm.stopServer', async () => {
      vscode.window.showInformationMessage('Stopping local LLM server...');
      await controller.stopServer();
    }),
    
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('localLlm.models')) {
        vscode.commands.executeCommand('workbench.action.webview.reloadWebviewAction');
      }
    })
  );
}

export function deactivate() {}
