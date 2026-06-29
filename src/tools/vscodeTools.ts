import * as vscode from 'vscode';
import * as path from 'path';
import { ToolResult } from '../toolExecutor';

// ─── VS Code Feature Tool Handlers ──────────────────────────────────────────

/**
 * Get diagnostics (errors, warnings) from VS Code's language servers.
 * Can target a specific file or the entire workspace.
 */
export async function handleGetDiagnostics(filePath?: string): Promise<ToolResult> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  if (filePath && workspaceRoot) {
    // Get diagnostics for a specific file
    const absPath = path.resolve(workspaceRoot, filePath);
    const uri = vscode.Uri.file(absPath);
    const diagnostics = vscode.languages.getDiagnostics(uri);

    if (diagnostics.length === 0) {
      return { success: true, output: `No diagnostics (errors/warnings) found for ${filePath}. The file looks clean! ✅` };
    }

    const lines = diagnostics.map(d => {
      const severity = d.severity === vscode.DiagnosticSeverity.Error ? '❌ Error' :
                       d.severity === vscode.DiagnosticSeverity.Warning ? '⚠️ Warning' :
                       d.severity === vscode.DiagnosticSeverity.Information ? 'ℹ️ Info' : '💡 Hint';
      const line = d.range.start.line + 1;
      const col = d.range.start.character + 1;
      return `  ${severity} at line ${line}:${col}: ${d.message}${d.source ? ` [${d.source}]` : ''}`;
    });

    const errorCount = diagnostics.filter(d => d.severity === vscode.DiagnosticSeverity.Error).length;
    const warningCount = diagnostics.filter(d => d.severity === vscode.DiagnosticSeverity.Warning).length;

    return {
      success: true,
      output: `Diagnostics for ${filePath} (${errorCount} errors, ${warningCount} warnings):\n\n${lines.join('\n')}`
    };
  } else {
    // Get workspace-wide diagnostics
    const allDiagnostics = vscode.languages.getDiagnostics();
    
    if (allDiagnostics.length === 0) {
      return { success: true, output: 'No diagnostics found across the workspace. Everything looks clean! ✅' };
    }

    const results: string[] = [];
    let totalErrors = 0;
    let totalWarnings = 0;

    for (const [uri, diagnostics] of allDiagnostics) {
      if (diagnostics.length === 0) continue;
      
      const relativePath = vscode.workspace.asRelativePath(uri);
      // Skip common noise
      if (relativePath.includes('node_modules') || relativePath.includes('.git')) continue;

      const errors = diagnostics.filter(d => d.severity === vscode.DiagnosticSeverity.Error);
      const warnings = diagnostics.filter(d => d.severity === vscode.DiagnosticSeverity.Warning);
      totalErrors += errors.length;
      totalWarnings += warnings.length;

      const items = diagnostics.slice(0, 10).map(d => {
        const severity = d.severity === vscode.DiagnosticSeverity.Error ? '❌' :
                         d.severity === vscode.DiagnosticSeverity.Warning ? '⚠️' : 'ℹ️';
        const line = d.range.start.line + 1;
        return `    ${severity} Line ${line}: ${d.message}`;
      });

      results.push(`📄 **${relativePath}** (${errors.length} errors, ${warnings.length} warnings)\n${items.join('\n')}`);
    }

    if (results.length === 0) {
      return { success: true, output: 'No significant diagnostics found in the workspace. ✅' };
    }

    return {
      success: true,
      output: `Workspace diagnostics (${totalErrors} errors, ${totalWarnings} warnings across ${results.length} files):\n\n${results.join('\n\n')}`
    };
  }
}

/**
 * Find all references to a symbol at a given position.
 */
export async function handleFindReferences(
  filePath: string,
  line: number,
  column: number
): Promise<ToolResult> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    return { success: false, output: 'Error: No workspace folder is open.' };
  }
  if (!filePath) {
    return { success: false, output: 'Error: "path" argument is required.' };
  }

  const absPath = path.resolve(workspaceRoot, filePath);
  const uri = vscode.Uri.file(absPath);
  const position = new vscode.Position(Math.max(0, (line || 1) - 1), Math.max(0, (column || 1) - 1));

  try {
    const locations: vscode.Location[] = await vscode.commands.executeCommand(
      'vscode.executeReferenceProvider',
      uri,
      position
    );

    if (!locations || locations.length === 0) {
      return { success: true, output: `No references found at ${filePath}:${line}:${column}.` };
    }

    const results = locations.slice(0, 30).map(loc => {
      const relPath = vscode.workspace.asRelativePath(loc.uri);
      const refLine = loc.range.start.line + 1;
      const refCol = loc.range.start.character + 1;
      return `  ${relPath}:${refLine}:${refCol}`;
    });

    return {
      success: true,
      output: `Found ${locations.length} reference(s) at ${filePath}:${line}:${column}:\n\n${results.join('\n')}${locations.length > 30 ? `\n\n... and ${locations.length - 30} more` : ''}`
    };
  } catch (err: any) {
    return { success: false, output: `Failed to find references: ${err.message}` };
  }
}

/**
 * Go to the definition of a symbol at a given position.
 */
export async function handleGoToDefinition(
  filePath: string,
  line: number,
  column: number
): Promise<ToolResult> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    return { success: false, output: 'Error: No workspace folder is open.' };
  }
  if (!filePath) {
    return { success: false, output: 'Error: "path" argument is required.' };
  }

  const absPath = path.resolve(workspaceRoot, filePath);
  const uri = vscode.Uri.file(absPath);
  const position = new vscode.Position(Math.max(0, (line || 1) - 1), Math.max(0, (column || 1) - 1));

  try {
    const definitions: vscode.Location[] = await vscode.commands.executeCommand(
      'vscode.executeDefinitionProvider',
      uri,
      position
    );

    if (!definitions || definitions.length === 0) {
      return { success: true, output: `No definition found at ${filePath}:${line}:${column}.` };
    }

    const results = definitions.map(def => {
      const relPath = vscode.workspace.asRelativePath(def.uri);
      const defLine = def.range.start.line + 1;
      const defCol = def.range.start.character + 1;
      return `  ${relPath}:${defLine}:${defCol}`;
    });

    // Also open the first definition in the editor
    if (definitions.length > 0) {
      const first = definitions[0];
      await vscode.window.showTextDocument(first.uri, {
        selection: first.range,
        preserveFocus: false,
        preview: true
      });
    }

    return {
      success: true,
      output: `Definition(s) for symbol at ${filePath}:${line}:${column}:\n\n${results.join('\n')}`
    };
  } catch (err: any) {
    return { success: false, output: `Failed to find definition: ${err.message}` };
  }
}
