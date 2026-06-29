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

/**
 * Tool category metadata for the Configure Tools UI.
 */
export interface ToolCategory {
  id: string;
  name: string;
  icon: string;
  description: string;
  tools: string[]; // tool function names
}

export const TOOL_CATEGORIES: ToolCategory[] = [
  {
    id: 'file',
    name: 'File Operations',
    icon: '📁',
    description: 'Read, write, edit, and search files in your workspace',
    tools: ['read_file', 'write_file', 'edit_file', 'list_directory', 'search_files', 'open_file']
  },
  {
    id: 'execute',
    name: 'Execute',
    icon: '💻',
    description: 'Run shell commands in your workspace',
    tools: ['run_command']
  },
  {
    id: 'web',
    name: 'Web',
    icon: '🌐',
    description: 'Search the web and fetch URL content',
    tools: ['web_search', 'fetch_url']
  },
  {
    id: 'todo',
    name: 'Todo',
    icon: '✅',
    description: 'Manage and track todo items for task planning',
    tools: ['create_todo', 'list_todos', 'update_todo', 'delete_todo']
  },
  {
    id: 'vscode',
    name: 'VS Code',
    icon: '⚙️',
    description: 'Use VS Code language features like diagnostics and references',
    tools: ['get_diagnostics', 'find_references', 'go_to_definition']
  }
];

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  // ═══ FILE TOOLS ═══════════════════════════════════════════════════════════
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
  },

  // ═══ EXECUTE TOOLS ════════════════════════════════════════════════════════
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

  // ═══ WEB TOOLS ════════════════════════════════════════════════════════════
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web for information. Returns search result snippets with titles, descriptions, and URLs. Use this to look up documentation, find solutions to errors, research APIs, or get current information.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query (e.g. "Node.js stream API", "how to fix CORS error", "React useEffect cleanup")'
          }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: 'Fetch and read the text content of a web page URL. Returns the page content with HTML stripped. Useful for reading documentation pages, README files, API docs, or any web content.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The URL to fetch (e.g. "https://docs.python.org/3/library/json.html")'
          }
        },
        required: ['url']
      }
    }
  },

  // ═══ TODO TOOLS ═══════════════════════════════════════════════════════════
  {
    type: 'function',
    function: {
      name: 'create_todo',
      description: 'Create a new todo item for tracking tasks. Useful for planning work, tracking bugs, or organizing features to implement.',
      parameters: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'The title of the todo item (e.g. "Refactor login module", "Fix CORS bug")'
          },
          description: {
            type: 'string',
            description: 'Optional detailed description of the task'
          },
          priority: {
            type: 'string',
            description: 'Priority level: "high", "medium", or "low". Defaults to "medium".',
            enum: ['high', 'medium', 'low']
          }
        },
        required: ['title']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_todos',
      description: 'List all current todo items. Can filter by status to show only pending or completed items.',
      parameters: {
        type: 'object',
        properties: {
          filter: {
            type: 'string',
            description: 'Optional: filter by status - "pending", "done", or "all" (default)',
            enum: ['all', 'pending', 'done']
          }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'update_todo',
      description: 'Update an existing todo item. Can change its status to done, update title, description, or priority.',
      parameters: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'The ID of the todo item to update (use list_todos to find IDs)'
          },
          status: {
            type: 'string',
            description: 'New status: "done" or "pending"',
            enum: ['done', 'pending']
          },
          title: {
            type: 'string',
            description: 'Optional: new title'
          },
          description: {
            type: 'string',
            description: 'Optional: new description'
          },
          priority: {
            type: 'string',
            description: 'Optional: new priority level',
            enum: ['high', 'medium', 'low']
          }
        },
        required: ['id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_todo',
      description: 'Delete a todo item by its ID.',
      parameters: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'The ID of the todo item to delete (use list_todos to find IDs)'
          }
        },
        required: ['id']
      }
    }
  },

  // ═══ VS CODE TOOLS ════════════════════════════════════════════════════════
  {
    type: 'function',
    function: {
      name: 'get_diagnostics',
      description: 'Get all errors, warnings, and hints from VS Code\'s language server for a specific file or the entire workspace. Extremely useful for finding and fixing bugs, type errors, and linting issues.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Optional: relative file path to get diagnostics for. If omitted, returns diagnostics for the entire workspace.'
          }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'find_references',
      description: 'Find all references to a symbol (variable, function, class, etc.) at a specific position in a file. Uses VS Code\'s language server for accurate results.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative file path where the symbol is located'
          },
          line: {
            type: 'string',
            description: 'Line number of the symbol (1-indexed)'
          },
          column: {
            type: 'string',
            description: 'Column number of the symbol (1-indexed)'
          }
        },
        required: ['path', 'line', 'column']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'go_to_definition',
      description: 'Jump to the definition of a symbol at a specific position. Opens the definition file in the editor and returns the location. Useful for understanding where functions, classes, or variables are defined.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative file path where the symbol is used'
          },
          line: {
            type: 'string',
            description: 'Line number of the symbol (1-indexed)'
          },
          column: {
            type: 'string',
            description: 'Column number of the symbol (1-indexed)'
          }
        },
        required: ['path', 'line', 'column']
      }
    }
  }
];

/**
 * Agentic system prompt that instructs the model on how to use tools effectively.
 * This is prepended when tools are enabled.
 */
export const AGENTIC_SYSTEM_PROMPT = `You are an expert coding assistant running locally in VS Code. You have access to powerful tools that let you read, write, search files, run commands, browse the web, manage todos, and use VS Code's language features.

## How to use tools effectively:

### File Tools
1. **Always read before writing**: Use read_file to understand existing code before making changes.
2. **Use list_directory** to explore project structure when you're unsure about file locations.
3. **Use search_files** to find relevant code, usages, or patterns across the codebase.
4. **Use edit_file for surgical changes**: When modifying existing files, use edit_file with precise search/replace instead of rewriting entire files with write_file.
5. **Use write_file for new files**: Only use write_file when creating new files or when you need to completely rewrite a file.
6. **Use open_file** after making changes so the user can review your work.

### Execute Tools
7. **Use run_command** for builds, tests, git operations, or to verify your changes work.

### Web Tools
8. **Use web_search** to look up documentation, find solutions to errors, or research APIs when you're unsure about something.
9. **Use fetch_url** to read specific documentation pages or web resources.

### Todo Tools
10. **Use create_todo** to help the user track tasks, bugs, and features.
11. **Use list_todos** to check current task status before planning work.

### VS Code Tools
12. **Use get_diagnostics** to find errors and warnings — this is incredibly useful for debugging.
13. **Use find_references** to understand how a symbol is used across the codebase.
14. **Use go_to_definition** to navigate to where something is defined.

## Important rules:
- All file paths are relative to the workspace root.
- Be precise with edit_file search text — it must match exactly.
- Explain what you're doing and why before making changes.
- After completing changes, summarize what you did.`;
