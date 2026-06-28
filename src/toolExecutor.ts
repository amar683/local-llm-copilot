import * as vscode from 'vscode';
import * as path from 'path';
import { exec } from 'child_process';

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
 * Dispatches a tool call to the appropriate handler function.
 * All file paths are resolved relative to the workspace root.
 */
export async function executeToolCall(
  toolName: string,
  args: Record<string, any>
): Promise<ToolResult> {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot && toolName !== 'run_command') {
    return { success: false, output: 'Error: No workspace folder is open. Please open a folder first.' };
  }

  try {
    switch (toolName) {
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
      default:
        return { success: false, output: `Unknown tool: ${toolName}` };
    }
  } catch (err: any) {
    return { success: false, output: `Error executing ${toolName}: ${err.message}` };
  }
}

function getWorkspaceRoot(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    return folders[0].uri.fsPath;
  }
  return undefined;
}

/**
 * Resolve a relative path against the workspace root, with basic path traversal protection.
 */
function resolveWorkspacePath(workspaceRoot: string, relativePath: string): string {
  // Normalize the path
  const resolved = path.resolve(workspaceRoot, relativePath);
  // Ensure the resolved path is within the workspace
  if (!resolved.startsWith(workspaceRoot)) {
    throw new Error(`Path "${relativePath}" resolves outside the workspace. Access denied.`);
  }
  return resolved;
}

// ─── Tool Handlers ───────────────────────────────────────────────────────────

async function handleReadFile(workspaceRoot: string, filePath: string): Promise<ToolResult> {
  if (!filePath) {
    return { success: false, output: 'Error: "path" argument is required.' };
  }

  const absPath = resolveWorkspacePath(workspaceRoot, filePath);
  const uri = vscode.Uri.file(absPath);

  try {
    const data = await vscode.workspace.fs.readFile(uri);
    const text = Buffer.from(data).toString('utf-8');
    
    // Add line numbers for easier reference
    const lines = text.split('\n');
    const maxLineLen = String(lines.length).length;
    const numbered = lines.map((line, i) => `${String(i + 1).padStart(maxLineLen)}│ ${line}`).join('\n');
    
    // Truncate very large files
    if (lines.length > 2000) {
      const truncated = lines.slice(0, 2000).map((line, i) => `${String(i + 1).padStart(maxLineLen)}│ ${line}`).join('\n');
      return {
        success: true,
        output: `File: ${filePath} (${lines.length} lines, showing first 2000)\n\n${truncated}\n\n... [truncated ${lines.length - 2000} remaining lines]`
      };
    }

    return {
      success: true,
      output: `File: ${filePath} (${lines.length} lines)\n\n${numbered}`
    };
  } catch (err: any) {
    if (err.code === 'FileNotFound' || err.message?.includes('ENOENT')) {
      return { success: false, output: `File not found: ${filePath}` };
    }
    throw err;
  }
}

async function handleWriteFile(workspaceRoot: string, filePath: string, content: string): Promise<ToolResult> {
  if (!filePath) {
    return { success: false, output: 'Error: "path" argument is required.' };
  }
  if (content === undefined || content === null) {
    return { success: false, output: 'Error: "content" argument is required.' };
  }

  const absPath = resolveWorkspacePath(workspaceRoot, filePath);

  // Check if file already exists
  let exists = false;
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(absPath));
    exists = true;
  } catch {
    exists = false;
  }

  // We no longer prompt the user with a modal box.
  // The action will be previewed and confirmable inside the chat's worktree UI.

  const uri = vscode.Uri.file(absPath);
  
  // Read current content if it exists
  let originalContent = '';
  if (exists) {
    try {
      const existingData = await vscode.workspace.fs.readFile(uri);
      originalContent = Buffer.from(existingData).toString('utf-8');
    } catch {
      originalContent = '';
    }
  }
  
  const data = Buffer.from(content, 'utf-8');
  await vscode.workspace.fs.writeFile(uri, data);

  const newLinesCount = content.split('\n').length;
  const oldLinesCount = originalContent ? originalContent.split('\n').length : 0;

  return {
    success: true,
    needsConfirmation: true, // Trigger the undo UI in chat
    originalContent: originalContent, // Save for Reject
    originalUri: uri,
    addedLines: newLinesCount,
    removedLines: oldLinesCount,
    output: `Successfully ${exists ? 'overwrote' : 'created'} ${filePath} (${newLinesCount} lines, ${data.length} bytes)`
  };
}

async function handleEditFile(workspaceRoot: string, filePath: string, search: string, replace: string): Promise<ToolResult> {
  if (!filePath || !search || replace === undefined) {
    return { success: false, output: 'Error: "path", "search", and "replace" arguments are required.' };
  }

  const absPath = resolveWorkspacePath(workspaceRoot, filePath);
  const uri = vscode.Uri.file(absPath);

  // Read current content
  let currentContent: string;
  try {
    const data = await vscode.workspace.fs.readFile(uri);
    currentContent = Buffer.from(data).toString('utf-8');
  } catch {
    return { success: false, output: `File not found: ${filePath}` };
  }

  // Find the search text
  const index = currentContent.indexOf(search);
  if (index === -1) {
    return {
      success: false,
      output: `Could not find the search text in ${filePath}. Make sure it matches exactly, including whitespace and indentation. Use read_file first to see the current content.`
    };
  }

  // Check for multiple occurrences
  const secondIndex = currentContent.indexOf(search, index + 1);
  const multipleOccurrences = secondIndex !== -1;

  const newContent = currentContent.substring(0, index) + replace + currentContent.substring(index + search.length);
  const data = Buffer.from(newContent, 'utf-8');
  await vscode.workspace.fs.writeFile(uri, data);
  
  // Calculate rough diff stats for the preview
  const originalLines = search.split('\n').length;
  const newLines = replace.split('\n').length;

  return {
    success: true, 
    needsConfirmation: true, // Trigger the undo UI in chat
    originalContent: currentContent, // Save for Reject
    originalUri: uri,
    addedLines: newLines,
    removedLines: originalLines,
    output: `Successfully edited ${filePath} (replaced ${search.length} bytes)`
  };
}

async function handleListDirectory(workspaceRoot: string, dirPath: string): Promise<ToolResult> {
  const resolvedPath = dirPath && dirPath !== '.' && dirPath !== ''
    ? resolveWorkspacePath(workspaceRoot, dirPath)
    : workspaceRoot;

  const uri = vscode.Uri.file(resolvedPath);

  try {
    const entries = await vscode.workspace.fs.readDirectory(uri);
    
    if (entries.length === 0) {
      return { success: true, output: `Directory "${dirPath || '.'}" is empty.` };
    }

    // Sort: directories first, then files
    entries.sort((a, b) => {
      if (a[1] === b[1]) return a[0].localeCompare(b[0]);
      return a[1] === vscode.FileType.Directory ? -1 : 1;
    });

    const lines: string[] = [];
    for (const [name, type] of entries) {
      if (name.startsWith('.git') || name === 'node_modules' || name === '.DS_Store') {
        continue; // Skip common clutter
      }
      if (type === vscode.FileType.Directory) {
        lines.push(`📁 ${name}/`);
      } else {
        // Get file size
        try {
          const stat = await vscode.workspace.fs.stat(vscode.Uri.file(path.join(resolvedPath, name)));
          const sizeStr = formatFileSize(stat.size);
          lines.push(`📄 ${name} (${sizeStr})`);
        } catch {
          lines.push(`📄 ${name}`);
        }
      }
    }

    const displayPath = dirPath || '.';
    return {
      success: true,
      output: `Directory: ${displayPath}/ (${lines.length} items)\n\n${lines.join('\n')}`
    };
  } catch (err: any) {
    return { success: false, output: `Could not list directory "${dirPath}": ${err.message}` };
  }
}

async function handleSearchFiles(
  workspaceRoot: string,
  pattern: string,
  searchPath?: string,
  filePattern?: string
): Promise<ToolResult> {
  if (!pattern) {
    return { success: false, output: 'Error: "pattern" argument is required.' };
  }

  // Use VS Code's built-in search via workspace.findFiles + reading files
  // For better performance, we use a simulated grep approach
  const includePattern = filePattern || '**/*';
  const excludePattern = '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/*.vsix,**/*.gguf}';
  
  let relativeBase = '';
  if (searchPath && searchPath !== '.' && searchPath !== '') {
    relativeBase = searchPath.endsWith('/') ? searchPath : searchPath + '/';
  }

  const searchGlob = relativeBase ? `${relativeBase}${includePattern}` : includePattern;

  try {
    const uris = await vscode.workspace.findFiles(searchGlob, excludePattern, 100);
    const results: string[] = [];
    let totalMatches = 0;
    const maxResults = 50;

    for (const uri of uris) {
      if (totalMatches >= maxResults) break;

      try {
        const data = await vscode.workspace.fs.readFile(uri);
        const text = Buffer.from(data).toString('utf-8');
        const lines = text.split('\n');
        const relativePath = vscode.workspace.asRelativePath(uri);

        for (let i = 0; i < lines.length; i++) {
          if (totalMatches >= maxResults) break;

          if (lines[i].includes(pattern)) {
            const lineNum = i + 1;
            const trimmedLine = lines[i].trim();
            const displayLine = trimmedLine.length > 120 ? trimmedLine.substring(0, 120) + '...' : trimmedLine;
            results.push(`${relativePath}:${lineNum}: ${displayLine}`);
            totalMatches++;
          }
        }
      } catch {
        // Skip files we can't read (binary, etc.)
      }
    }

    if (results.length === 0) {
      return {
        success: true,
        output: `No matches found for "${pattern}"${searchPath ? ` in ${searchPath}` : ''}.`
      };
    }

    const header = `Found ${totalMatches} match${totalMatches > 1 ? 'es' : ''} for "${pattern}"${totalMatches >= maxResults ? ` (showing first ${maxResults})` : ''}:\n`;
    return {
      success: true,
      output: header + '\n' + results.join('\n')
    };
  } catch (err: any) {
    return { success: false, output: `Search error: ${err.message}` };
  }
}

async function handleRunCommand(workspaceRoot: string, command: string): Promise<ToolResult> {
  if (!command) {
    return { success: false, output: 'Error: "command" argument is required.' };
  }

  // Ask for user confirmation
  const choice = await vscode.window.showWarningMessage(
    `The AI wants to run a shell command. Allow?`,
    { modal: true, detail: `Command:\n$ ${command}\n\nThis will execute in the workspace directory. Timeout: 30 seconds.` },
    'Allow',
    'Deny'
  );

  if (choice !== 'Allow') {
    return { success: false, output: `User denied permission to run command: ${command}`, denied: true };
  }

  return new Promise((resolve) => {
    const cwd = workspaceRoot || process.cwd();
    const child = exec(command, {
      cwd,
      timeout: 30000,
      maxBuffer: 1024 * 1024, // 1MB
      env: { ...process.env, PAGER: 'cat' }
    }, (error, stdout, stderr) => {
      const parts: string[] = [];
      
      if (stdout && stdout.trim()) {
        parts.push(`stdout:\n${stdout.trim()}`);
      }
      if (stderr && stderr.trim()) {
        parts.push(`stderr:\n${stderr.trim()}`);
      }

      if (error) {
        if (error.killed) {
          parts.push('(Command timed out after 30 seconds)');
        }
        const exitCode = error.code || 'unknown';
        resolve({
          success: false,
          output: `Command failed (exit code ${exitCode}):\n$ ${command}\n\n${parts.join('\n\n') || error.message}`
        });
      } else {
        resolve({
          success: true,
          output: `Command succeeded:\n$ ${command}\n\n${parts.join('\n\n') || '(no output)'}`
        });
      }
    });
  });
}

async function handleOpenFile(workspaceRoot: string, filePath: string, line?: string): Promise<ToolResult> {
  if (!filePath) {
    return { success: false, output: 'Error: "path" argument is required.' };
  }

  const absPath = resolveWorkspacePath(workspaceRoot, filePath);
  const uri = vscode.Uri.file(absPath);

  try {
    const lineNum = line ? parseInt(line, 10) - 1 : 0;
    const selection = new vscode.Range(
      new vscode.Position(Math.max(0, lineNum), 0),
      new vscode.Position(Math.max(0, lineNum), 0)
    );

    await vscode.window.showTextDocument(uri, {
      selection,
      preserveFocus: false,
      preview: false
    });

    return {
      success: true,
      output: `Opened ${filePath}${line ? ` at line ${line}` : ''} in the editor.`
    };
  } catch (err: any) {
    return { success: false, output: `Could not open file "${filePath}": ${err.message}` };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
