import * as vscode from 'vscode';

// Import tool handler modules
import { getWorkspaceRoot, handleReadFile, handleWriteFile, handleEditFile, handleListDirectory, handleSearchFiles, handleRunCommand, handleOpenFile } from './tools/fileTools';
import { handleWebSearch, handleFetchUrl } from './tools/webTools';
import { handleCreateTodo, handleListTodos, handleUpdateTodo, handleDeleteTodo, initTodoTools } from './tools/todoTools';
import { handleGetDiagnostics, handleFindReferences, handleGoToDefinition } from './tools/vscodeTools';

/**
 * Result from executing a tool call.
 */
export interface ToolResult {
  success: boolean;
  output: string;
  /** Whether user confirmation was required and denied */
  denied?: boolean;
  /** Whether the tool needs webview confirmation before applying */
  needsConfirmation?: boolean;
  /** The original file content (for undo) */
  originalContent?: string;
  /** The original URI being edited */
  originalUri?: vscode.Uri;
  /** Lines added for preview */
  addedLines?: number;
  /** Lines removed for preview */
  removedLines?: number;
}

/**
 * Initialize tool modules that need the extension context.
 */
export function initTools(context: vscode.ExtensionContext) {
  initTodoTools(context);
}

/**
 * Dispatches a tool call to the appropriate handler function.
 * All file paths are resolved relative to the workspace root.
 */
export async function executeToolCall(
  toolName: string,
  args: Record<string, any>
): Promise<ToolResult> {
  const workspaceRoot = getWorkspaceRoot();
  
  // Tools that don't need a workspace
  const noWorkspaceTools = ['run_command', 'web_search', 'fetch_url', 'create_todo', 'list_todos', 'update_todo', 'delete_todo'];
  
  if (!workspaceRoot && !noWorkspaceTools.includes(toolName)) {
    return { success: false, output: 'Error: No workspace folder is open. Please open a folder first.' };
  }

  try {
    switch (toolName) {
      // ─── File Tools ──────────────────────────────────────────────────
      case 'read_file':
        return await handleReadFile(workspaceRoot!, args.path);
      case 'write_file':
        return await handleWriteFile(workspaceRoot!, args.path, args.content);
      case 'edit_file':
        return await handleEditFile(workspaceRoot!, args.path, args.search, args.replace);
      case 'list_directory':
        return await handleListDirectory(workspaceRoot!, args.path);
      case 'search_files':
        return await handleSearchFiles(workspaceRoot!, args.pattern, args.path, args.file_pattern);
      case 'run_command':
        return await handleRunCommand(workspaceRoot || '', args.command);
      case 'open_file':
        return await handleOpenFile(workspaceRoot!, args.path, args.line);

      // ─── Web Tools ───────────────────────────────────────────────────
      case 'web_search':
        return await handleWebSearch(args.query);
      case 'fetch_url':
        return await handleFetchUrl(args.url);

      // ─── Todo Tools ──────────────────────────────────────────────────
      case 'create_todo':
        return await handleCreateTodo(args.title, args.description, args.priority);
      case 'list_todos':
        return await handleListTodos(args.filter);
      case 'update_todo':
        return await handleUpdateTodo(args.id, args.status, args.title, args.description, args.priority);
      case 'delete_todo':
        return await handleDeleteTodo(args.id);

      // ─── VS Code Tools ──────────────────────────────────────────────
      case 'get_diagnostics':
        return await handleGetDiagnostics(args.path);
      case 'find_references':
        return await handleFindReferences(args.path, parseInt(args.line, 10), parseInt(args.column, 10));
      case 'go_to_definition':
        return await handleGoToDefinition(args.path, parseInt(args.line, 10), parseInt(args.column, 10));

      default:
        return { success: false, output: `Unknown tool: ${toolName}` };
    }
  } catch (err: any) {
    return { success: false, output: `Error executing ${toolName}: ${err.message}` };
  }
}
