import * as vscode from 'vscode';
import { ServerController } from './serverController';
import * as http from 'http';

// Simple LRU cache for hover results
class HoverCache {
  private cache = new Map<string, { result: string; timestamp: number }>();
  private maxSize = 200;
  private ttlMs = 5 * 60 * 1000; // 5 minutes

  get(key: string): string | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.result;
  }

  set(key: string, result: string) {
    if (this.cache.size >= this.maxSize) {
      // Evict oldest entry
      const firstKey = this.cache.keys().next().value;
      if (firstKey) this.cache.delete(firstKey);
    }
    this.cache.set(key, { result, timestamp: Date.now() });
  }
}

// Debounce tracker to avoid flooding the server
let lastHoverTime = 0;
const HOVER_DEBOUNCE_MS = 500;

// Set of pending requests to avoid duplicate calls
const pendingRequests = new Set<string>();

export function registerHoverProvider(context: vscode.ExtensionContext, serverController: ServerController) {
  const cache = new HoverCache();

  const hoverProvider = vscode.languages.registerHoverProvider(
    { scheme: 'file' },
    {
      async provideHover(document, position, token) {
        // Check if feature is enabled
        const config = vscode.workspace.getConfiguration('localLlm');
        if (!config.get<boolean>('enableHoverSummary', true)) {
          return undefined;
        }

        // Check if server is ready
        if (!serverController.isServerReady()) {
          return undefined;
        }

        // Debounce: skip if too soon after last hover
        const now = Date.now();
        if (now - lastHoverTime < HOVER_DEBOUNCE_MS) {
          return undefined;
        }
        lastHoverTime = now;

        // Get the word under cursor
        const wordRange = document.getWordRangeAtPosition(position);
        if (!wordRange) return undefined;

        const word = document.getText(wordRange);
        if (!word || word.length < 2 || word.length > 60) return undefined;

        // Skip common language keywords and simple tokens
        const skipWords = new Set([
          'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue',
          'return', 'function', 'class', 'const', 'let', 'var', 'new', 'this', 'import',
          'export', 'from', 'default', 'true', 'false', 'null', 'undefined', 'void',
          'typeof', 'instanceof', 'try', 'catch', 'finally', 'throw', 'async', 'await',
          'yield', 'in', 'of', 'with', 'as', 'is', 'not', 'and', 'or', 'int', 'float',
          'double', 'char', 'bool', 'boolean', 'string', 'number', 'any', 'object',
          'enum', 'interface', 'type', 'namespace', 'module', 'package', 'public',
          'private', 'protected', 'static', 'final', 'abstract', 'override', 'virtual',
          'struct', 'union', 'typedef', 'sizeof', 'include', 'define', 'ifdef', 'endif',
          'pragma', 'using', 'template', 'typename', 'auto', 'register', 'volatile',
          'extern', 'inline', 'goto', 'signed', 'unsigned', 'long', 'short',
          'self', 'super', 'None', 'True', 'False', 'def', 'lambda', 'print',
          'elif', 'except', 'raise', 'pass', 'del', 'global', 'nonlocal',
          'assert', 'begin', 'end', 'then', 'elsif', 'unless', 'until', 'when',
          'puts', 'gets', 'attr', 'fn', 'pub', 'mod', 'use', 'crate', 'impl', 'trait',
          'where', 'move', 'mut', 'ref', 'loop', 'match', 'Some', 'Ok', 'Err',
        ]);
        if (skipWords.has(word)) return undefined;

        // Build a cache key from file + position + word
        const cacheKey = `${document.uri.fsPath}:${position.line}:${word}`;

        // Check cache first
        const cached = cache.get(cacheKey);
        if (cached) {
          const md = new vscode.MarkdownString();
          md.isTrusted = true;
          md.appendMarkdown(`**${word}**\n\n`);
          md.appendMarkdown(`✦ Local LLM\n\n`);
          md.appendMarkdown(cached);
          return new vscode.Hover(md, wordRange);
        }

        // Skip if already pending
        if (pendingRequests.has(cacheKey)) return undefined;

        // Get surrounding context (5 lines before and after)
        const startLine = Math.max(0, position.line - 5);
        const endLine = Math.min(document.lineCount - 1, position.line + 5);
        const contextRange = new vscode.Range(startLine, 0, endLine, document.lineAt(endLine).text.length);
        const contextText = document.getText(contextRange);
        const fileName = document.fileName.split(/[\\/]/).pop() || '';
        const languageId = document.languageId;

        // Make the LLM request
        const port = serverController.getPort();
        const prompt = `You are a code documentation assistant. Given the symbol "${word}" in the following ${languageId} code from file "${fileName}", provide a brief 1-2 sentence summary of what this symbol represents or does. Be concise and precise. Do NOT use markdown formatting, just plain text.

Code context:
\`\`\`${languageId}
${contextText}
\`\`\`

Symbol to explain: ${word}

Brief summary:`;

        pendingRequests.add(cacheKey);

        try {
          const result = await queryLlm(port, prompt, token);
          pendingRequests.delete(cacheKey);

          if (!result || token.isCancellationRequested) return undefined;

          // Clean up the result
          const cleanResult = result.trim().replace(/^["']|["']$/g, '');
          if (cleanResult.length < 5) return undefined;

          // Cache it
          cache.set(cacheKey, cleanResult);

          const md = new vscode.MarkdownString();
          md.isTrusted = true;
          md.appendMarkdown(`**${word}**\n\n`);
          md.appendMarkdown(`✦ Local LLM\n\n`);
          md.appendMarkdown(cleanResult);
          return new vscode.Hover(md, wordRange);
        } catch (e) {
          pendingRequests.delete(cacheKey);
          return undefined;
        }
      }
    }
  );

  context.subscriptions.push(hoverProvider);
}

function queryLlm(port: number, prompt: string, token: vscode.CancellationToken): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const postBody = {
      messages: [
        { role: 'user', content: prompt }
      ],
      stream: false,
      temperature: 0.1,
      max_tokens: 150 // Keep it short for hover
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
      },
      timeout: 8000 // Short timeout for hover — don't block the UI
    };

    const req = http.request(options, (res) => {
      let buffer = '';
      res.on('data', (chunk) => { buffer += chunk.toString(); });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          resolve(undefined);
          return;
        }
        try {
          const data = JSON.parse(buffer);
          const content = data.choices?.[0]?.message?.content;
          resolve(content || undefined);
        } catch {
          resolve(undefined);
        }
      });
    });

    req.on('error', () => resolve(undefined));
    req.on('timeout', () => {
      req.destroy();
      resolve(undefined);
    });

    token.onCancellationRequested(() => {
      req.destroy();
      resolve(undefined);
    });

    req.write(postData);
    req.end();
  });
}
