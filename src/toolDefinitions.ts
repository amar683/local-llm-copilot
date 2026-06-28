/**
 * Tool definitions in OpenAI function-calling format.
 * These are sent to llama-server in the `tools` field of /v1/chat/completions.
 * The Qwythos model (with --jinja flag) will use these to decide when to invoke tools.
 */

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, { type: string; description: string; enum?: string[] }>;
      required: string[];
    };
  };
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file from the workspace. Use this to examine source code, configuration files, or any text file. The path should be relative to the workspace root.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative path to the file from the workspace root (e.g. "src/index.ts", "package.json")'
          }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create a new file or overwrite an existing file with the given content. The path should be relative to the workspace root. Parent directories will be created if needed. Requires user confirmation.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative path to the file from the workspace root (e.g. "src/utils.ts", "README.md")'
          },
          content: {
            type: 'string',
            description: 'The full content to write to the file'
          }
        },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Edit a file by finding and replacing a specific text block. The search text must match exactly (including whitespace and indentation). Use read_file first to see the current content before editing.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative path to the file from the workspace root'
          },
          search: {
            type: 'string',
            description: 'The exact text to find in the file (must match precisely, including whitespace)'
          },
          replace: {
            type: 'string',
            description: 'The replacement text to substitute for the search text'
          }
        },
        required: ['path', 'search', 'replace']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description: 'List all files and subdirectories in a directory. Returns a tree-like listing with file sizes. The path should be relative to the workspace root. Use "." or "" for the workspace root.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative path to the directory from the workspace root (e.g. "src", "src/components", or "." for root)'
          }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: 'Search for a text pattern across files in the workspace. Returns matching lines with file paths and line numbers. Useful for finding usages, definitions, TODOs, etc.',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'The text or regex pattern to search for'
          },
          path: {
            type: 'string',
            description: 'Optional: relative directory path to limit the search scope (e.g. "src"). Defaults to entire workspace.'
          },
          file_pattern: {
            type: 'string',
            description: 'Optional: glob pattern to filter files (e.g. "*.ts", "*.{js,jsx}"). Defaults to all files.'
          }
        },
        required: ['pattern']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Execute a shell command in the workspace directory and return stdout and stderr. Useful for running builds, tests, git commands, etc. Requires user confirmation. Commands have a 30-second timeout.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The shell command to execute (e.g. "npm run build", "git status", "ls -la")'
          }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'open_file',
      description: 'Open a file in the VS Code editor so the user can see it. Optionally jump to a specific line number. Use this after making edits so the user can review changes.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative path to the file from the workspace root'
          },
          line: {
            type: 'string',
            description: 'Optional: line number to scroll to (1-indexed)'
          }
        },
        required: ['path']
      }
    }
  }
];

/**
 * Agentic system prompt that instructs the model on how to use tools effectively.
 * This is prepended when tools are enabled.
 */
export const AGENTIC_SYSTEM_PROMPT = `You are an expert coding assistant running locally in VS Code. You have access to tools that let you read, write, and search files in the user's workspace, as well as run shell commands.

## How to use tools effectively:
1. **Always read before writing**: Use read_file to understand existing code before making changes.
2. **Use list_directory** to explore project structure when you're unsure about file locations.
3. **Use search_files** to find relevant code, usages, or patterns across the codebase.
4. **Use edit_file for surgical changes**: When modifying existing files, use edit_file with precise search/replace instead of rewriting entire files with write_file.
5. **Use write_file for new files**: Only use write_file when creating new files or when you need to completely rewrite a file.
6. **Use open_file** after making changes so the user can review your work.
7. **Use run_command** for builds, tests, git operations, or to verify your changes work.

## Important rules:
- All file paths are relative to the workspace root.
- Be precise with edit_file search text — it must match exactly.
- Explain what you're doing and why before making changes.
- After completing changes, summarize what you did.`;
