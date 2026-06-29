import * as vscode from 'vscode';
import { ServerController } from './serverController';

import { ChatViewProvider } from './chatViewProvider';

export class LocalLlmCodeActionProvider implements vscode.CodeActionProvider {
  
  public static readonly providedCodeActionKinds = [
    vscode.CodeActionKind.QuickFix,
    vscode.CodeActionKind.Refactor
  ];

  constructor(private serverController: ServerController) {}

  public provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
    token: vscode.CancellationToken
  ): vscode.CodeAction[] {
    
    const actions: vscode.CodeAction[] = [];

    const explainAction = new vscode.CodeAction('💡 Local LLM: Explain this code', vscode.CodeActionKind.Refactor);
    explainAction.command = {
      command: 'localLlm.explainCode',
      title: 'Explain Code',
      arguments: [document, range]
    };
    actions.push(explainAction);

    const editAction = new vscode.CodeAction('💡 Local LLM: Edit Inline', vscode.CodeActionKind.Refactor);
    editAction.command = {
      command: 'localLlm.inlineChat',
      title: 'Edit Inline'
    };
    actions.push(editAction);

    if (context.diagnostics.length > 0) {
      const diagnostic = context.diagnostics[0];
      const fixAction = new vscode.CodeAction(`💡 Local LLM: Fix "${diagnostic.message}"`, vscode.CodeActionKind.QuickFix);
      fixAction.command = {
        command: 'localLlm.fixDiagnostic',
        title: 'Fix Diagnostic',
        arguments: [document, diagnostic]
      };
      fixAction.diagnostics = [diagnostic];
      fixAction.isPreferred = true;
      actions.push(fixAction);
    }

    return actions;
  }
}

export function registerCodeActions(context: vscode.ExtensionContext, serverController: ServerController, provider: ChatViewProvider) {
  
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      { scheme: 'file' },
      new LocalLlmCodeActionProvider(serverController),
      { providedCodeActionKinds: LocalLlmCodeActionProvider.providedCodeActionKinds }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('localLlm.explainCode', async (document?: vscode.TextDocument, range?: vscode.Range) => {
      if (!document || !range) {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.selection.isEmpty) {
          vscode.window.showInformationMessage('Please select some code to explain.');
          return;
        }
        document = editor.document;
        range = editor.selection;
      }
      
      const text = document.getText(range);
      if (!text) return;
      
      await vscode.commands.executeCommand('localLlmChatView.focus');
      provider.setChatInput(`Please explain the following code:\n\n\`\`\`\n${text}\n\`\`\``);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('localLlm.fixDiagnostic', async (document: vscode.TextDocument, diagnostic: vscode.Diagnostic) => {
      const text = document.getText(diagnostic.range);
      
      await vscode.commands.executeCommand('localLlmChatView.focus');
      provider.setChatInput(`I have an error in my code: "${diagnostic.message}".\n\nCode:\n\`\`\`\n${text}\n\`\`\`\n\nHow do I fix this?`);
    })
  );
}
