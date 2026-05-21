import * as vscode from 'vscode';
import * as http from 'http';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export class ServerController {
  private terminal: vscode.Terminal | undefined;
  private currentPort = 8080;
  private isStarting = false;

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
          onStatusChange('ready', 'Connected to server');
          this.isStarting = false;
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

  public async stopServer(): Promise<void> {
    if (this.terminal) {
      this.terminal.sendText('\u0003');
      await sleep(500);
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
}
