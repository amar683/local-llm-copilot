import * as vscode from 'vscode';
import * as http from 'http';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export class ServerController {
  private terminal: vscode.Terminal | undefined;
  private currentPort = 8080;
  private isStarting = false;
  private isReady = false;

  public isServerReady(): boolean {
    return this.isReady;
  }

  // Kill old process if running, then boot new llama-server
  public async startServer(
    command: string, 
    port: number, 
    onStatusChange: (status: 'idle' | 'starting' | 'ready' | 'error', message?: string) => void
  ): Promise<boolean> {
    if (this.isStarting) {
      vscode.window.showWarningMessage("Server is already starting, please wait...");
      return false;
    }

    this.isStarting = true;
    this.isReady = false;
    this.currentPort = port;
    onStatusChange('starting', 'Stopping previous server...');

    try {
      // Find or spin up our server terminal
      if (!this.terminal) {
        this.terminal = vscode.window.terminals.find(t => t.name === 'Llama.cpp Server') 
          || vscode.window.createTerminal({
              name: 'Llama.cpp Server',
              iconPath: new vscode.ThemeIcon('server')
            });
      }

      this.terminal.show(true);

      // Send SIGINT (Ctrl+C) to terminate whatever is running
      this.terminal.sendText('\u0003');
      await sleep(1000); // Wait for shell prompt to return

      onStatusChange('starting', 'Starting llama-server...');
      this.terminal.sendText(command);

      // Poll health endpoint
      const maxAttempts = 60;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        await sleep(500);
        
        if (await this.checkServerHealth(port)) {
          this.isStarting = false;
          this.isReady = true;
          onStatusChange('ready', 'Server is running and ready for chat.');
          return true;
        }

        const progress = Math.round((attempt / maxAttempts) * 100);
        onStatusChange('starting', `Loading model... (${progress}%)`);
      }

      onStatusChange('error', 'Server launch timed out. Please check the terminal logs.');
      this.isStarting = false;
      return false;

    } catch (err: any) {
      onStatusChange('error', `Error launching server: ${err.message}`);
      this.isStarting = false;
      return false;
    }
  }

  public async stopServer(onStatusChange?: (status: 'idle') => void): Promise<void> {
    if (this.terminal) {
      this.terminal.sendText('\u0003');
    }
    this.isReady = false;
    if (onStatusChange) {
      onStatusChange('idle');
    }
  }

  // Check if server is running and model is loaded
  private checkServerHealth(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/health',
        method: 'GET',
        timeout: 800
      }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            if (res.statusCode === 200) {
              const resJson = JSON.parse(body);
              resolve(resJson && resJson.status === 'ok');
            } else {
              resolve(false);
            }
          } catch {
            resolve(res.statusCode === 200);
          }
        });
      });

      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
      req.end();
    });
  }

  public getPort(): number {
    return this.currentPort;
  }

  public getServerUrl(): string {
    return `http://127.0.0.1:${this.currentPort}`;
  }

  // Fetch /props from running llama-server (model info, context size, etc.)
  public fetchServerProps(port: number): Promise<any> {
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/props',
        method: 'GET',
        timeout: 3000
      }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve({ raw: body });
          }
        });
      });

      req.on('error', (err) => reject(err));
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Timeout fetching /props'));
      });
      req.end();
    });
  }

  // Tokenize text via the /tokenize endpoint — returns token array
  public tokenizeText(port: number, text: string): Promise<{ tokens: number[] }> {
    return new Promise((resolve, reject) => {
      const postData = JSON.stringify({ content: text });

      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/tokenize',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        },
        timeout: 3000
      }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve({ tokens: [] });
          }
        });
      });

      req.on('error', (err) => reject(err));
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Timeout calling /tokenize'));
      });
      req.write(postData);
      req.end();
    });
  }

  // Get embeddings via the /v1/embeddings endpoint
  public embedText(port: number, text: string | string[]): Promise<number[][]> {
    return new Promise((resolve, reject) => {
      const postData = JSON.stringify({
        input: text,
        model: 'local' // usually ignored by llama.cpp
      });

      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/v1/embeddings',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        },
        timeout: 60000 // embeddings can take a while for large texts
      }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            const data = JSON.parse(body);

            // llama.cpp returns { error: { message: "..." } } when embeddings are not supported
            if (data.error) {
              const errMsg = data.error.message || data.error || JSON.stringify(data.error);
              reject(new Error(`Embedding server error: ${errMsg}. Hint: Make sure llama-server was started with the --embedding flag.`));
              return;
            }

            if (res.statusCode !== 200) {
              reject(new Error(`Embedding request failed with HTTP ${res.statusCode}: ${body.substring(0, 200)}`));
              return;
            }

            if (data.data && Array.isArray(data.data)) {
              // Return array of embedding vectors
              const embeddings = data.data.map((d: any) => d.embedding);
              // Validate that we actually got vectors
              if (embeddings.length > 0 && Array.isArray(embeddings[0]) && embeddings[0].length > 0) {
                resolve(embeddings);
              } else {
                reject(new Error('Embedding vectors are empty. The model may not support embeddings. Try starting with --embedding flag or use a dedicated embedding model.'));
              }
            } else {
              reject(new Error(`Unexpected embedding response: ${body.substring(0, 300)}. Make sure llama-server was started with --embedding flag.`));
            }
          } catch (e) {
            reject(new Error(`Failed to parse embedding response: ${body.substring(0, 200)}`));
          }
        });
      });

      req.on('error', (err) => reject(new Error(`Embedding request failed: ${err.message}. Is the server running?`)));
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Timeout calling /v1/embeddings (60s). Try smaller batch sizes or a faster model.'));
      });
      req.write(postData);
      req.end();
    });
  }
}
