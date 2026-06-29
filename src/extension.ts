import * as vscode from 'vscode';
import { ServerController } from './serverController';
import { ChatViewProvider } from './chatViewProvider';

import { registerInlineChat } from './inlineChatProvider';
import { registerCodeActions } from './codeActionProvider';
import { registerHoverProvider } from './hoverProvider';

export function activate(context: vscode.ExtensionContext) {
  const controller = new ServerController();
  const provider = new ChatViewProvider(context, controller);

  registerInlineChat(context, controller);
  registerCodeActions(context, controller, provider);
  registerHoverProvider(context, controller);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider),
    
    vscode.commands.registerCommand('localLlm.stopServer', async () => {
      vscode.window.showInformationMessage('Stopping local LLM server...');
      await controller.stopServer();
    }),

    vscode.commands.registerCommand('localLlm.indexCodebase', async () => {
      await provider.indexCodebase();
    }),

    vscode.commands.registerCommand('localLlm.openChat', async () => {
      await vscode.commands.executeCommand('localLlmChatView.focus');
    }),
    
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('localLlm.models')) {
        vscode.commands.executeCommand('workbench.action.webview.reloadWebviewAction');
      }
    })
  );
}

export function deactivate() {}
