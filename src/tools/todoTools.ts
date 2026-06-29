import * as vscode from 'vscode';
import { ToolResult } from '../toolExecutor';

/**
 * Todo item stored in VS Code's globalState (per-workspace).
 */
interface TodoItem {
  id: string;
  title: string;
  description: string;
  priority: 'high' | 'medium' | 'low';
  status: 'pending' | 'done';
  createdAt: string;
  completedAt?: string;
}

// We store the ExtensionContext reference so tools can access globalState
let _context: vscode.ExtensionContext | undefined;

export function initTodoTools(context: vscode.ExtensionContext) {
  _context = context;
}

function getStorageKey(): string {
  const workspaceName = vscode.workspace.workspaceFolders?.[0]?.name || 'global';
  return `localLlm.todos.${workspaceName}`;
}

function getTodos(): TodoItem[] {
  if (!_context) return [];
  return _context.globalState.get<TodoItem[]>(getStorageKey()) || [];
}

function saveTodos(todos: TodoItem[]): Thenable<void> {
  if (!_context) return Promise.resolve();
  return _context.globalState.update(getStorageKey(), todos);
}

function generateId(): string {
  return Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 7);
}

// ─── Todo Tool Handlers ─────────────────────────────────────────────────────

export async function handleCreateTodo(
  title: string,
  description?: string,
  priority?: string
): Promise<ToolResult> {
  if (!title) {
    return { success: false, output: 'Error: "title" argument is required.' };
  }

  const validPriority = (['high', 'medium', 'low'].includes(priority || '') ? priority : 'medium') as TodoItem['priority'];
  
  const todo: TodoItem = {
    id: generateId(),
    title,
    description: description || '',
    priority: validPriority,
    status: 'pending',
    createdAt: new Date().toISOString()
  };

  const todos = getTodos();
  todos.push(todo);
  await saveTodos(todos);

  const priorityEmoji = { high: '🔴', medium: '🟡', low: '🟢' };

  return {
    success: true,
    output: `✅ Created todo item:\n  ID: ${todo.id}\n  ${priorityEmoji[todo.priority]} ${todo.title}${todo.description ? `\n  Description: ${todo.description}` : ''}\n  Priority: ${todo.priority}\n  Status: pending`
  };
}

export async function handleListTodos(filter?: string): Promise<ToolResult> {
  const todos = getTodos();

  if (todos.length === 0) {
    return { success: true, output: 'No todo items found. Use create_todo to add some.' };
  }

  let filtered = todos;
  if (filter === 'pending') {
    filtered = todos.filter(t => t.status === 'pending');
  } else if (filter === 'done') {
    filtered = todos.filter(t => t.status === 'done');
  }

  if (filtered.length === 0) {
    return { success: true, output: `No ${filter} todo items found.` };
  }

  const priorityEmoji: Record<string, string> = { high: '🔴', medium: '🟡', low: '🟢' };
  const statusEmoji: Record<string, string> = { pending: '⬜', done: '✅' };

  // Sort: pending first, then by priority (high > medium > low)
  const priorityOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
  filtered.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'pending' ? -1 : 1;
    return (priorityOrder[a.priority] || 1) - (priorityOrder[b.priority] || 1);
  });

  const lines = filtered.map((t, i) => {
    let line = `${i + 1}. ${statusEmoji[t.status]} ${priorityEmoji[t.priority]} **${t.title}** [ID: ${t.id}]`;
    if (t.description) line += `\n   ${t.description}`;
    line += `\n   Priority: ${t.priority} | Status: ${t.status} | Created: ${new Date(t.createdAt).toLocaleDateString()}`;
    return line;
  });

  const pendingCount = todos.filter(t => t.status === 'pending').length;
  const doneCount = todos.filter(t => t.status === 'done').length;
  const header = `📋 Todo List (${pendingCount} pending, ${doneCount} done):\n`;

  return {
    success: true,
    output: header + '\n' + lines.join('\n\n')
  };
}

export async function handleUpdateTodo(
  id: string,
  status?: string,
  title?: string,
  description?: string,
  priority?: string
): Promise<ToolResult> {
  if (!id) {
    return { success: false, output: 'Error: "id" argument is required.' };
  }

  const todos = getTodos();
  const index = todos.findIndex(t => t.id === id);

  if (index === -1) {
    return { success: false, output: `Todo item with ID "${id}" not found. Use list_todos to see all items.` };
  }

  const todo = todos[index];
  
  if (title) todo.title = title;
  if (description !== undefined) todo.description = description;
  if (priority && ['high', 'medium', 'low'].includes(priority)) {
    todo.priority = priority as TodoItem['priority'];
  }
  if (status && ['pending', 'done'].includes(status)) {
    todo.status = status as TodoItem['status'];
    if (status === 'done') {
      todo.completedAt = new Date().toISOString();
    } else {
      todo.completedAt = undefined;
    }
  }

  todos[index] = todo;
  await saveTodos(todos);

  const priorityEmoji: Record<string, string> = { high: '🔴', medium: '🟡', low: '🟢' };

  return {
    success: true,
    output: `✅ Updated todo item:\n  ID: ${todo.id}\n  ${priorityEmoji[todo.priority]} ${todo.title}\n  Priority: ${todo.priority} | Status: ${todo.status}`
  };
}

export async function handleDeleteTodo(id: string): Promise<ToolResult> {
  if (!id) {
    return { success: false, output: 'Error: "id" argument is required.' };
  }

  const todos = getTodos();
  const index = todos.findIndex(t => t.id === id);

  if (index === -1) {
    return { success: false, output: `Todo item with ID "${id}" not found. Use list_todos to see all items.` };
  }

  const deleted = todos.splice(index, 1)[0];
  await saveTodos(todos);

  return {
    success: true,
    output: `🗑️ Deleted todo item: "${deleted.title}" (ID: ${deleted.id})`
  };
}
