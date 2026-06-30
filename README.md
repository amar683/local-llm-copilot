# Local LLM Sidebar Chat (VS Code Extension)

Start your local `llama.cpp` model servers directly from VS Code and chat with them in a premium right-side panel interface.

## Features

- **Integrated Server Lifecycle:** Automatically starts and stops your `llama-server` process in a dedicated VS Code terminal (`Llama.cpp Server`) when you select a model.
- **Auto-Kill Previous Models:** Sends a `Ctrl+C` command to terminate the active model server before spinning up a new one to avoid port conflicts and memory leaks.
- **Health Polling:** Monitors the model loading progress (showing percentage status) before enabling chat inputs.
- **Autonomous Agent Mode 🤖:** Provide a high-level goal and watch the agent create a multi-step plan, track progress, maintain a scratchpad in memory, and autonomously read/edit files to achieve the result.
- **Tool Calling (Function Calling):** Extensible tool ecosystem allowing the LLM to inspect directories, view files, edit code, run semantic searches, and more.
- **Inline Editing & Chat (Ctrl+I):** Select code and press `Ctrl+I` (`Cmd+I` on Mac) to bring up the inline chat interface. The LLM edits the code directly in your editor, and you can easily **Accept** or **Reject** the changes.
- **AI Hover Summaries:** Hover over any class, function, or symbol in your code to get instant, AI-generated explanations using your local model. (Can be toggled via settings).
- **Semantic Codebase Search:** Index your entire workspace locally. Use the `Local LLM: Index Codebase` command and let the LLM automatically retrieve the most relevant code chunks for your queries without hitting any external API.
- **Quick Actions (Context Menus & Code Actions):** Right-click or use lightbulb quick actions to instantly **Explain this code** or **Fix this error** based on editor diagnostics.
- **Multimodal / Vision Support:** Configure a multimodal projector (`mmprojPath`) to allow models to analyze images and screenshots!
- **Premium Chat UI & Animations:** Includes a beautiful dark-mode chat panel with responsive layout, code syntax highlighting, copy-to-clipboard buttons, clear chat history, streaming responses, glowing action buttons, and live pulsing animations for agent progress.
- **Rich Context Integration:** Easily attach the active file, workspace overview, or use the semantic search tool to pull relevant codebase snippets directly into your context window.
- **Highly Configurable:** Customize model names, executable paths, GPU layers, context sizes, and ports directly inside your standard VS Code `settings.json`, or via the built-in UI settings panel.

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

Models are easily configured directly within the extension's UI—no need to manually edit JSON files!

1. Open the **Local LLM** panel in your sidebar.
2. Click the **Model Setup** button (the grid icon) in the footer.
3. Click **+ Add Model** and fill in the details:
   - **Model Name:** A friendly name (e.g., "Qwen 2.5 Coder 7B")
   - **Model Path:** The absolute path to your `.gguf` file
   - **Context Size:** The context window (e.g., 8192)
   - **GPU Layers:** The number of layers to offload to the GPU (e.g., 99 for full offload)
   - **Enable Agent Tools:** **Check this box** if the model has strong function-calling capabilities. This is required to unlock Agent Mode and autonomous file interactions!

Once added, select the model from the dropdown in the footer to automatically start the local server and begin chatting.

## How to move Chat to the Right Sidebar
1. Open the Chat view container by clicking the discussion bubble icon in the primary (left) sidebar.
2. Drag the **Local LLM** conversation bubble icon from the left Activity Bar and drop it on the **right-side Secondary Sidebar** (or next to `CHAT` / `CODEX` tabs).
3. VS Code will permanently remember this layout.
