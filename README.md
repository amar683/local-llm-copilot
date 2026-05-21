# Local LLM Sidebar Chat (VS Code Extension)

Start your local `llama.cpp` model servers directly from VS Code and chat with them in a premium right-side panel interface.

## Features

- **Integrated Server Lifecycle:** Automatically starts and stops your `llama-server` process in a dedicated VS Code terminal (`Llama.cpp Server`) when you select a model.
- **Auto-Kill Previous Models:** Sends a `Ctrl+C` command to terminate the active model server before spinning up a new one to avoid port conflicts and memory leaks.
- **Health Polling:** Monitors the model loading progress (showing percentage status) before enabling chat inputs.
- **Premium Chat UI:** Includes a beautiful dark-mode chat panel with code syntax highlighting, copy-to-clipboard buttons, streaming responses, and context history.
- **Highly Configurable:** Customize model names, executable paths, GPU layers, context sizes, and ports directly inside your standard VS Code `settings.json`.

## Installation

### From Source (Development)
1. Clone this repository.
2. Open the folder in VS Code.
3. Press `F5` to start a new **Extension Development Host** window with the extension loaded.

### Package & Install permanently (.VSIX)
To install the extension permanently in your primary VS Code app:
1. Compile the code:
   ```bash
   npm run compile
   ```
2. Build the package file:
   ```bash
   npx -y @vscode/vsce package
   ```
3. Open the Extensions panel (`Cmd+Shift+X`), click `...` in the top right, select **Install from VSIX...**, and choose the generated `.vsix` file.

## Configuration

In your VS Code `settings.json`, you can define your models:

```json
{
  "localLlm.models": [
    {
      "id": "aicoder",
      "name": "Qwen 2.5 Coder 7B (Release)",
      "command": "cd '/Users/amardeeptomar/Coding Space/C++ codes/llama.cpp' && ./build-release/bin/llama-server -m ~/models/Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf -ngl 99 --port 8080 -c 8192",
      "port": 8080
    },
    {
      "id": "ai3b",
      "name": "Llama 3.2 3B (Release)",
      "command": "cd '/Users/amardeeptomar/Coding Space/C++ codes/llama.cpp' && ./build-release/bin/llama-server -m ~/models/Llama-3.2-3B-Instruct-Q4_K_M.gguf -ngl 99 --port 8080",
      "port": 8080
    }
  ]
}
```

## How to move Chat to the Right Sidebar
1. Open the Chat view container by clicking the discussion bubble icon in the primary (left) sidebar.
2. Drag the **Local LLM** conversation bubble icon from the left Activity Bar and drop it on the **right-side Secondary Sidebar** (or next to `CHAT` / `CODEX` tabs).
3. VS Code will permanently remember this layout.
