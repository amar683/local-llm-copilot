const vscode = acquireVsCodeApi();

// ─── Element References ─────────────────────────────────────────────────────

const modelSelect = document.getElementById('model-select');
const statusIndicator = document.getElementById('status-indicator');
const stopBtn = document.getElementById('stop-btn');
const messagesContainer = document.getElementById('messages-container');
const chatInput = document.getElementById('chat-input');
const sendBtn = document.getElementById('send-btn');
const clearBtn = document.getElementById('clear-btn');
const sendIcon = document.getElementById('send-icon');
const stopGenIcon = document.getElementById('stop-generation-icon');

const selectionBar = document.getElementById('selection-bar');
const selectionText = document.getElementById('selection-text');

const toggleActiveFileBtn = document.getElementById('toggle-active-file');
const activeFileLabel = document.getElementById('active-file-label');
const toggleWorkspaceBtn = document.getElementById('toggle-workspace');
const workspaceLabel = document.getElementById('workspace-label');

const toolsToggleRow = document.getElementById('tools-toggle-row');
const toggleToolsBtn = document.getElementById('toggle-tools');

const settingsToggleBtn = document.getElementById('settings-toggle-btn');
const settingsPanel = document.getElementById('settings-panel');
const tempInput = document.getElementById('settings-temp');
const tempVal = document.getElementById('settings-temp-val');
const toppInput = document.getElementById('settings-topp');
const toppVal = document.getElementById('settings-topp-val');
const maxTokensInput = document.getElementById('settings-max-tokens');
const systemPromptInput = document.getElementById('settings-system-prompt');

const openWebUIBtn = document.getElementById('open-webui-btn');
const tokenCountBtn = document.getElementById('token-count-btn');
const tokenCountLabel = document.getElementById('token-count-label');

// Config view elements
const configToggleBtn = document.getElementById('config-toggle-btn');
const configView = document.getElementById('config-view');
const chatView = document.getElementById('chat-view');
const llamaCppPathInput = document.getElementById('llamacpp-path-input');
const llamaCppBrowseBtn = document.getElementById('llamacpp-browse-btn');
const configModelsList = document.getElementById('config-models-list');
const configAddModelBtn = document.getElementById('config-add-model-btn');
const configAddForm = document.getElementById('config-add-form');
const configSaveModelBtn = document.getElementById('config-save-model-btn');
const configCancelBtn = document.getElementById('config-cancel-btn');
const formBrowseModelBtn = document.getElementById('form-browse-model-btn');

// ─── State ──────────────────────────────────────────────────────────────────

let modelsList = [];
let selectedModelId = '';
let chatHistory = [];
let isGenerating = false;
let currentAssistantBubble = null;
let currentResponseText = '';
let nextMessageContext = null;
let nextWorkspaceMapAttached = false;
let currentModelHasTools = false;
let toolsEnabled = false;
let isConfigView = false;
let pendingToolCalls = [];
let editingModelId = null; // null = adding new, string = editing existing

// ─── Event Listeners ────────────────────────────────────────────────────────

toggleActiveFileBtn.addEventListener('click', () => {
  toggleActiveFileBtn.classList.toggle('active');
});

toggleWorkspaceBtn.addEventListener('click', () => {
  toggleWorkspaceBtn.classList.toggle('active');
});

toggleToolsBtn.addEventListener('click', () => {
  toggleToolsBtn.classList.toggle('active');
  toolsEnabled = toggleToolsBtn.classList.contains('active');
});

settingsToggleBtn.addEventListener('click', () => {
  settingsToggleBtn.classList.toggle('active');
  settingsPanel.classList.toggle('hidden');
});

tempInput.addEventListener('input', (e) => {
  tempVal.textContent = parseFloat(e.target.value).toFixed(2);
});

toppInput.addEventListener('input', (e) => {
  toppVal.textContent = parseFloat(e.target.value).toFixed(2);
});

openWebUIBtn.addEventListener('click', () => {
  vscode.postMessage({ type: 'openWebUI' });
});

tokenCountBtn.addEventListener('click', () => {
  const text = chatInput.value.trim();
  if (!text) {
    tokenCountLabel.textContent = '0 tokens';
    return;
  }
  tokenCountLabel.textContent = '...';
  vscode.postMessage({ type: 'tokenize', text });
});

// ─── Config View Listeners ──────────────────────────────────────────────────

configToggleBtn.addEventListener('click', () => {
  isConfigView = !isConfigView;
  if (isConfigView) {
    configView.classList.remove('hidden');
    chatView.classList.add('hidden');
    configToggleBtn.classList.add('active');
    // Hide the generation settings panel when in config view
    settingsPanel.classList.add('hidden');
    settingsToggleBtn.classList.remove('active');
    vscode.postMessage({ type: 'getLlamaCppPath' });
  } else {
    configView.classList.add('hidden');
    chatView.classList.remove('hidden');
    configToggleBtn.classList.remove('active');
  }
});

// llamaCpp path — save on blur
llamaCppPathInput.addEventListener('change', () => {
  vscode.postMessage({ type: 'saveLlamaCppPath', path: llamaCppPathInput.value.trim() });
});

llamaCppBrowseBtn.addEventListener('click', () => {
  vscode.postMessage({ type: 'browseLlamaCppPath' });
});

configAddModelBtn.addEventListener('click', () => {
  openModelForm(null); // null = adding new model
});

/** Open the model form for adding or editing */
function openModelForm(model) {
  editingModelId = model ? model.id : null;
  configAddForm.classList.remove('hidden');
  configAddModelBtn.classList.add('hidden');

  // Update form title
  const formTitle = configAddForm.querySelector('.config-section-label');
  if (formTitle) formTitle.textContent = model ? 'EDIT MODEL' : 'ADD MODEL';

  // Update save button text
  configSaveModelBtn.textContent = model ? 'Save Changes' : 'Save Model';

  // Fill or reset form fields
  document.getElementById('form-model-name').value = model ? model.name : '';
  document.getElementById('form-model-path').value = model ? (model.modelPath || '') : '';
  document.getElementById('form-context-size').value = model ? (model.contextSize || 4096) : '4096';
  document.getElementById('form-port').value = model ? (model.port || 8080) : '8080';
  document.getElementById('form-gpu-layers').value = model ? (model.gpuLayers ?? 99) : '99';
  document.getElementById('form-enable-tools').checked = model ? (model.enableTools || false) : false;

  setTimeout(() => document.getElementById('form-model-name').focus(), 100);
}

configCancelBtn.addEventListener('click', () => {
  configAddForm.classList.add('hidden');
  configAddModelBtn.classList.remove('hidden');
  editingModelId = null;
});

formBrowseModelBtn.addEventListener('click', () => {
  vscode.postMessage({ type: 'browseModelFile' });
});

configSaveModelBtn.addEventListener('click', () => {
  const name = document.getElementById('form-model-name').value.trim();
  const modelPath = document.getElementById('form-model-path').value.trim();
  const contextSize = parseInt(document.getElementById('form-context-size').value, 10) || 4096;
  const port = parseInt(document.getElementById('form-port').value, 10) || 8080;
  const gpuLayers = parseInt(document.getElementById('form-gpu-layers').value, 10);
  const enableTools = document.getElementById('form-enable-tools').checked;

  if (!name) {
    document.getElementById('form-model-name').style.borderColor = '#f38ba8';
    setTimeout(() => document.getElementById('form-model-name').style.borderColor = '', 2000);
    return;
  }
  if (!modelPath) {
    document.getElementById('form-model-path').style.borderColor = '#f38ba8';
    setTimeout(() => document.getElementById('form-model-path').style.borderColor = '', 2000);
    return;
  }

  if (editingModelId) {
    // Update existing model
    vscode.postMessage({
      type: 'updateModel',
      modelId: editingModelId,
      model: {
        name,
        modelPath,
        contextSize,
        port,
        gpuLayers: isNaN(gpuLayers) ? 99 : gpuLayers,
        enableTools
      }
    });
  } else {
    // Add new model
    vscode.postMessage({
      type: 'addModel',
      model: {
        name,
        modelPath,
        contextSize,
        port,
        gpuLayers: isNaN(gpuLayers) ? 99 : gpuLayers,
        enableTools
      }
    });
  }
});

// ─── Init ───────────────────────────────────────────────────────────────────

vscode.postMessage({ type: 'getModels' });

// ─── Message Handler ────────────────────────────────────────────────────────

window.addEventListener('message', e => {
  const msg = e.data;
  switch (msg.type) {
    case 'modelsList':
      modelsList = msg.models;
      updateDropdown(msg.selectedId);
      renderConfigModelCards();
      // Auto-show config if no models configured
      if (modelsList.length === 0 && !isConfigView) {
        configToggleBtn.click();
      }
      break;
    case 'statusUpdate':
      updateStatus(msg.status, msg.message);
      break;
    case 'streamChunk':
      appendChunk(msg.text);
      break;
    case 'streamEnd':
      stopStreaming();
      break;
    case 'error':
      showError(msg.text);
      break;
    case 'contextUpdate':
      handleContextUpdate(msg);
      break;
    case 'messageContextAttached':
      nextMessageContext = msg.context;
      nextWorkspaceMapAttached = msg.workspaceMapAttached;
      break;
    case 'serverProps':
      // Server props event intentionally ignored for now
      break;
    case 'tokenizeResult':
      handleTokenizeResult(msg.count);
      break;
    case 'toolCallStart':
      handleToolCallStart(msg);
      break;
    case 'toolCallResult':
      handleToolCallResult(msg);
      break;
    case 'tokenUsage':
      handleTokenUsage(msg);
      break;
    case 'llamaCppPath':
      llamaCppPathInput.value = msg.path || '';
      break;
    case 'browseModelResult':
      document.getElementById('form-model-path').value = msg.path || '';
      // Auto-extract model name from filename
      if (msg.path) {
        const nameInput = document.getElementById('form-model-name');
        if (!nameInput.value.trim()) {
          const filename = msg.path.split('/').pop().split('\\').pop() || '';
          // Clean up filename to make a nice display name
          const displayName = filename
            .replace(/\.gguf$/i, '')
            .replace(/[-_]/g, ' ')
            .replace(/Q\d+.*/i, '') // Remove quantization suffix
            .trim();
          nameInput.value = displayName || filename.replace('.gguf', '');
        }
      }
      break;
    case 'modelAdded':
    case 'modelUpdated':
      configAddForm.classList.add('hidden');
      configAddModelBtn.classList.remove('hidden');
      editingModelId = null;
      break;
    case 'modelDeleted':
      break;
  }
});

// ─── Config View Functions ──────────────────────────────────────────────────

function renderConfigModelCards() {
  configModelsList.innerHTML = '';

  if (modelsList.length === 0) {
    configModelsList.innerHTML = `
      <div class="config-empty-state">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="margin-bottom: 8px; opacity: 0.4;"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
        <span>No models configured yet</span>
        <span style="font-size: 10px; color: var(--text-muted); margin-top: 2px;">Click "Add New Model" below to get started</span>
      </div>
    `;
    return;
  }

  modelsList.forEach(model => {
    const card = document.createElement('div');
    card.className = 'config-model-card';

    // Build detail chips
    const chips = [];
    if (model.contextSize) chips.push(`${(model.contextSize / 1024).toFixed(0)}K ctx`);
    if (model.enableTools) chips.push('🔧 Tools');
    if (model.hasCustomCommand) chips.push('⚡ Custom cmd');
    chips.push(`Port ${model.port || 8080}`);

    // Get filename from path
    const modelFileName = model.modelPath ? model.modelPath.split('/').pop().split('\\').pop() : '';

    card.innerHTML = `
      <div class="config-card-header">
        <div class="config-card-info">
          <div class="config-card-name">${escapeHtml(model.name)}</div>
          ${modelFileName ? `<div class="config-card-file" title="${escapeHtml(model.modelPath)}">${escapeHtml(modelFileName)}</div>` : ''}
          <div class="config-card-chips">${chips.map(c => `<span class="config-chip">${c}</span>`).join('')}</div>
        </div>
        <div class="config-card-actions">
          <button class="config-edit-btn" data-model-id="${model.id}" title="Edit Model">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button class="config-delete-btn" data-model-id="${model.id}" title="Delete Model">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </div>
      </div>
    `;

    // Edit handler
    card.querySelector('.config-edit-btn').addEventListener('click', () => {
      openModelForm(model);
    });

    // Delete handler
    card.querySelector('.config-delete-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: 'deleteModel', modelId: model.id });
    });

    configModelsList.appendChild(card);
  });
}

// ─── Chat View Functions ────────────────────────────────────────────────────

modelSelect.addEventListener('change', (e) => {
  selectedModelId = e.target.value;
  updateToolsToggleVisibility();
  vscode.postMessage({ type: 'selectModel', modelId: selectedModelId });
});

stopBtn.addEventListener('click', () => {
  vscode.postMessage({ type: 'stopServer' });
});

sendBtn.addEventListener('click', () => {
  if (isGenerating) {
    vscode.postMessage({ type: 'abortMessage' });
    stopStreaming();
  } else {
    sendMessage();
  }
});

clearBtn.addEventListener('click', () => {
  messagesContainer.innerHTML = `
    <div class="welcome-message">
      <h3>Local LLM Sidebar Chat</h3>
      <p>Choose a model from the dropdown above. The extension will automatically spawn the llama-server command in your VS Code terminal and connect to it.</p>
      <p style="font-size: 11px; margin-top: 10px; color: var(--accent-color);">💡 Tip: Highlight any code in your editor to automatically attach it to your prompts!</p>
    </div>
  `;
  chatHistory = [];
  pendingToolCalls = [];
});

chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (!isGenerating && chatInput.value.trim() && !chatInput.disabled) {
      sendMessage();
    }
  }
});

chatInput.addEventListener('input', () => {
  chatInput.style.height = 'auto';
  chatInput.style.height = `${chatInput.scrollHeight}px`;
});

function updateToolsToggleVisibility() {
  const model = modelsList.find(m => m.id === selectedModelId);
  currentModelHasTools = model?.enableTools || false;
  
  if (currentModelHasTools) {
    toolsToggleRow.style.display = 'flex';
    toggleToolsBtn.classList.add('active');
    toolsEnabled = true;
  } else {
    toolsToggleRow.style.display = 'none';
    toggleToolsBtn.classList.remove('active');
    toolsEnabled = false;
  }
}

function handleContextUpdate(data) {
  const hasActiveFile = data.hasActiveFile;
  const activeFileName = data.activeFileName || '';
  const hasWorkspace = data.hasWorkspace;
  const workspaceName = data.workspaceName || '';

  if (hasActiveFile) {
    toggleActiveFileBtn.removeAttribute('disabled');
    activeFileLabel.textContent = `File: ${activeFileName}`;
    toggleActiveFileBtn.title = `Attach full file: ${activeFileName} (${data.activeFileLineCount} lines)`;
  } else {
    toggleActiveFileBtn.setAttribute('disabled', 'true');
    toggleActiveFileBtn.classList.remove('active');
    activeFileLabel.textContent = 'No Active File';
    toggleActiveFileBtn.title = 'Attach full active file';
  }

  if (hasWorkspace) {
    toggleWorkspaceBtn.removeAttribute('disabled');
    workspaceLabel.textContent = `Map: ${workspaceName}`;
    toggleWorkspaceBtn.title = `Attach files list for project: ${workspaceName}`;
  } else {
    toggleWorkspaceBtn.setAttribute('disabled', 'true');
    toggleWorkspaceBtn.classList.remove('active');
    workspaceLabel.textContent = 'No Workspace';
    toggleWorkspaceBtn.title = 'Attach list of files in project';
  }

  if (data.hasSelection) {
    selectionText.textContent = `Attached selection: ${data.selectionFileName} (${data.selectionLineCount} lines)`;
    selectionBar.classList.remove('hidden');
    toggleActiveFileBtn.classList.add('overridden');
    toggleActiveFileBtn.title = `Highlight selection in ${activeFileName} takes priority over full file`;
  } else {
    selectionBar.classList.add('hidden');
    toggleActiveFileBtn.classList.remove('overridden');
  }
}

function updateDropdown(selectedId) {
  modelSelect.innerHTML = '';
  
  if (modelsList.length === 0) {
    const opt = document.createElement('option');
    opt.text = "No models — click ⊞ to setup";
    opt.disabled = true;
    modelSelect.add(opt);
    return;
  }

  if (!selectedId) {
    const opt = document.createElement('option');
    opt.text = "Select a local LLM...";
    opt.value = "";
    opt.disabled = true;
    opt.selected = true;
    modelSelect.add(opt);
  }

  modelsList.forEach(m => {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.text = m.name;
    if (m.id === selectedId) {
      opt.selected = true;
      selectedModelId = selectedId;
    }
    modelSelect.add(opt);
  });

  updateToolsToggleVisibility();
}

function updateStatus(status, text) {
  statusIndicator.className = `status-indicator ${status}`;
  if (text) {
    statusIndicator.title = text;
  }

  const isDisabled = status !== 'ready';
  chatInput.disabled = isDisabled;
  sendBtn.disabled = isDisabled;
  tokenCountBtn.disabled = isDisabled;
  stopBtn.style.display = isDisabled ? 'none' : 'flex';
  openWebUIBtn.style.display = isDisabled ? 'none' : 'flex';

}

function sendMessage() {
  const text = chatInput.value.trim();
  if (!text) return;

  chatInput.value = '';
  chatInput.style.height = 'auto';

  const welcome = messagesContainer.querySelector('.welcome-message');
  if (welcome) welcome.remove();

  const includeActiveFile = toggleActiveFileBtn.classList.contains('active') && !toggleActiveFileBtn.disabled;
  const includeWorkspaceMap = toggleWorkspaceBtn.classList.contains('active') && !toggleWorkspaceBtn.disabled;

  appendBubble('user', text);

  chatHistory.push({ role: 'user', content: text });

  currentAssistantBubble = appendBubble('assistant', '...');
  currentResponseText = '';
  pendingToolCalls = [];
  isGenerating = true;

  sendIcon.classList.add('hidden');
  stopGenIcon.classList.remove('hidden');

  const temperature = parseFloat(tempInput.value);
  const maxTokens = parseInt(maxTokensInput.value, 10);
  const topP = parseFloat(toppInput.value);
  const systemPrompt = systemPromptInput.value;

  vscode.postMessage({
    type: 'sendMessage',
    messages: [
      { role: 'system', content: 'You are a helpful coding assistant running locally via llama.cpp. Keep code snippets clean and explain changes clearly.' },
      ...chatHistory
    ],
    includeActiveFile,
    includeWorkspaceMap,
    temperature,
    maxTokens,
    topP,
    systemPrompt,
    enableTools: toolsEnabled
  });
}

function appendChunk(text) {
  if (!currentAssistantBubble) return;

  if (currentResponseText === '') {
    const toolBlocks = currentAssistantBubble.querySelectorAll('.tool-call-block');
    if (toolBlocks.length === 0) {
      currentAssistantBubble.innerHTML = '';
    } else {
      const nodes = currentAssistantBubble.childNodes;
      for (let i = nodes.length - 1; i >= 0; i--) {
        if (nodes[i].nodeType === Node.TEXT_NODE || 
            (nodes[i].nodeType === Node.ELEMENT_NODE && !nodes[i].classList?.contains('tool-call-block'))) {
          if (nodes[i].textContent === '...' || nodes[i].classList?.contains('response-text')) {
            nodes[i].remove();
          }
        }
      }
    }
  }

  currentResponseText += text;
  
  let responseContainer = currentAssistantBubble.querySelector('.response-text');
  if (!responseContainer) {
    responseContainer = document.createElement('div');
    responseContainer.className = 'response-text';
    currentAssistantBubble.appendChild(responseContainer);
  }
  responseContainer.innerHTML = parseMarkdown(currentResponseText);
  scrollToBottom();
}

// ─── Tool Call UI ───────────────────────────────────────────────────────────

function handleToolCallStart(msg) {
  if (!currentAssistantBubble) return;

  if (currentAssistantBubble.textContent === '...') {
    currentAssistantBubble.innerHTML = '';
  }

  const block = document.createElement('div');
  block.className = 'tool-call-block';
  block.id = `tool-${msg.callId}`;

  const toolIcon = getToolIcon(msg.toolName);
  const argsPreview = formatToolArgs(msg.toolName, msg.toolArgs);

  block.innerHTML = `
    <div class="tool-call-header executing" onclick="toggleToolDetails(this)">
      <div class="tool-call-status-icon"><span class="tool-call-spinner"></span></div>
      <div class="tool-call-title">
        <span class="tool-call-name">${msg.toolName}</span>
        <span class="tool-call-args-inline">${escapeHtml(truncateOutput(argsPreview))}</span>
      </div>
      <svg class="tool-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
    </div>
    <div class="tool-call-details hidden">
      <div class="tool-detail-section">
        <div class="tool-detail-label">Arguments</div>
        <pre class="tool-call-args-content"><code>${escapeHtml(argsPreview)}</code></pre>
      </div>
      <div class="tool-detail-section tool-result-container hidden">
        <div class="tool-detail-label">Result</div>
        <pre class="tool-call-result-content"><code></code></pre>
      </div>
    </div>
  `;

  currentAssistantBubble.appendChild(block);
  scrollToBottom();
}

function handleToolCallResult(msg) {
  const block = document.getElementById(`tool-${msg.callId}`);
  if (!block) {
    if (currentAssistantBubble) {
      const fallbackBlock = document.createElement('div');
      fallbackBlock.className = 'tool-call-block';
      fallbackBlock.innerHTML = `
        <div class="tool-call-header ${msg.success ? 'success' : 'error'}">
          <span class="tool-call-icon">${getToolIcon(msg.toolName)}</span>
          <span class="tool-call-name">${msg.toolName}</span>
          <span class="tool-call-status">${msg.denied ? 'denied' : msg.success ? 'done' : 'failed'}</span>
        </div>
        <div class="tool-call-result">
          <div class="tool-call-result-toggle" onclick="toggleToolDetails(this)">
            <svg class="tool-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
            <span>Result</span>
          </div>
          <pre class="tool-call-result-content hidden"><code>${escapeHtml(truncateOutput(msg.output))}</code></pre>
        </div>
      `;
      currentAssistantBubble.appendChild(fallbackBlock);
    }
    return;
  }

  const header = block.querySelector('.tool-call-header');
  if (header) {
    header.classList.remove('executing');
    header.classList.add(msg.denied ? 'denied' : msg.success ? 'success' : 'error');
    
    const iconContainer = header.querySelector('.tool-call-status-icon');
    if (iconContainer) {
      const statusIcon = msg.denied ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>' : 
                         msg.success ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>' : 
                         '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
      iconContainer.innerHTML = statusIcon;
    }
  }

  const resultContainer = block.querySelector('.tool-result-container');
  const resultContent = block.querySelector('.tool-call-result-content code');
  
  if (resultContainer && resultContent) {
    resultContainer.classList.remove('hidden');
    resultContent.innerHTML = escapeHtml(truncateOutput(msg.output));
  }
  scrollToBottom();
}

window.toggleToolDetails = function(el) {
  const content = el.nextElementSibling;
  const chevron = el.querySelector('.tool-chevron');
  if (content) {
    content.classList.toggle('hidden');
    if (chevron) {
      chevron.style.transform = content.classList.contains('hidden') ? '' : 'rotate(90deg)';
    }
  }
};

function getToolIcon(toolName) {
  const icons = {
    'read_file': '📖', 'write_file': '✍️', 'edit_file': '✏️',
    'list_directory': '📁', 'search_files': '🔍', 'run_command': '⚡',
    'open_file': '👁️', 'system': '⚙️'
  };
  return icons[toolName] || '🔧';
}

function formatToolArgs(toolName, args) {
  if (!args) return '{}';
  try { return JSON.stringify(args, null, 2); } catch { return String(args); }
}

function truncateOutput(output) {
  if (!output) return '(no output)';
  const maxLen = 2000;
  if (output.length > maxLen) {
    return output.substring(0, maxLen) + `\n\n... [truncated ${output.length - maxLen} characters]`;
  }
  return output;
}

function escapeHtml(text) {
  if (!text) return '';
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

// ─── Chat UI Functions ──────────────────────────────────────────────────────

function stopStreaming() {
  if (!isGenerating) return;
  isGenerating = false;
  if (currentAssistantBubble && currentResponseText) {
    chatHistory.push({ role: 'assistant', content: currentResponseText });
  }
  sendIcon.classList.remove('hidden');
  stopGenIcon.classList.add('hidden');
  scrollToBottom();
}

function showError(err) {
  const wrapper = document.createElement('div');
  wrapper.className = 'message-wrapper assistant';
  wrapper.innerHTML = `
    <div class="sender-label">System Error</div>
    <div class="bubble" style="background-color: var(--status-error); color: #000; border: none;">${err}</div>
  `;
  messagesContainer.appendChild(wrapper);
  scrollToBottom();
}

function appendBubble(sender, text) {
  const wrapper = document.createElement('div');
  wrapper.className = `message-wrapper ${sender}`;

  const label = document.createElement('div');
  label.className = 'sender-label';
  label.textContent = sender === 'user' ? 'You' : (toolsEnabled ? 'Agent' : 'Local Assistant');
  wrapper.appendChild(label);

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  
  if (sender === 'user') {
    if (nextMessageContext) {
      const tag = document.createElement('div');
      tag.className = 'attached-context-tag';
      const fileIcon = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="margin-right: 4px;"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
      const selectionIcon = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="margin-right: 4px;"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>`;
      const icon = nextMessageContext.type === 'selection' ? selectionIcon : fileIcon;
      const typeLabel = nextMessageContext.type === 'selection' ? 'selection' : 'file';
      tag.innerHTML = `${icon}<span>${nextMessageContext.fileName} (${typeLabel}, ${nextMessageContext.lineCount} lines)</span>`;
      bubble.appendChild(tag);
      nextMessageContext = null;
    }
    if (nextWorkspaceMapAttached) {
      const tag = document.createElement('div');
      tag.className = 'attached-context-tag';
      tag.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="margin-right: 4px;"><rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/></svg><span>Workspace Map</span>`;
      bubble.appendChild(tag);
      nextWorkspaceMapAttached = false;
    }
    const textNode = document.createElement('div');
    textNode.textContent = text;
    bubble.appendChild(textNode);
  } else {
    bubble.innerHTML = parseMarkdown(text);
  }
  
  wrapper.appendChild(bubble);
  messagesContainer.appendChild(wrapper);
  scrollToBottom();
  return bubble;
}

function scrollToBottom() {
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

window.copyToClipboard = function(nonce) {
  const codeEl = document.getElementById(`code-${nonce}`);
  const btnEl = document.getElementById(`copy-${nonce}`);
  if (codeEl && btnEl) {
    navigator.clipboard.writeText(codeEl.innerText).then(() => {
      btnEl.textContent = 'Copied!';
      btnEl.style.backgroundColor = 'rgba(166, 227, 161, 0.2)';
      btnEl.style.color = '#a6e3a1';
      btnEl.style.borderColor = '#a6e3a1';
      setTimeout(() => {
        btnEl.textContent = 'Copy';
        btnEl.style.backgroundColor = 'transparent';
        btnEl.style.color = 'var(--text-muted)';
        btnEl.style.borderColor = 'rgba(255, 255, 255, 0.15)';
      }, 2000);
    });
  }
};



function handleTokenizeResult(count) {
  if (count < 0) {
    tokenCountLabel.textContent = 'Error';
    setTimeout(() => { tokenCountLabel.textContent = 'Tokens'; }, 2000);
  } else {
    tokenCountLabel.textContent = `${count} tokens`;
    setTimeout(() => { tokenCountLabel.textContent = 'Tokens'; }, 5000);
  }
}

function parseMarkdown(text) {
  if (!text) return '';
  let html = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (m, lang, code) => {
    const language = lang || 'code';
    const nonce = Math.random().toString(36).substring(7);
    return `<pre><div class="code-header"><span>${language}</span><button class="copy-btn" onclick="copyToClipboard('${nonce}')" id="copy-${nonce}">Copy</button></div><code id="code-${nonce}">${code.trim()}</code></pre>`;
  });
  html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>')
             .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
             .replace(/\*([^*]+)\*/g, '<em>$1</em>');
  html = html.replace(/^### (.*$)/gim, '<h3>$1</h3>')
             .replace(/^## (.*$)/gim, '<h2>$1</h2>')
             .replace(/^# (.*$)/gim, '<h1>$1</h1>');
  const lines = html.split('\n');
  let inList = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('- ') || line.startsWith('* ')) {
      const content = line.substring(2);
      lines[i] = (inList ? '' : '<ul>') + '<li>' + content + '</li>';
      inList = true;
    } else if (inList) {
      lines[i] = '</ul>' + lines[i];
      inList = false;
    }
  }
  if (inList) lines.push('</ul>');
  html = lines.join('\n');
  html = html.split('\n\n').map(p => {
    const trimmed = p.trim();
    if (!trimmed) return '';
    if (trimmed.match(/^(<pre|<ul|<li|<h1|<h2|<h3)/)) return trimmed;
    return `<p>${trimmed.replace(/\n/g, '<br>')}</p>`;
  }).join('');
  return html;
}
// ─── Utility ───────────────────────────────────────────────────────────────

function handleTokenUsage(msg) {
  const usageLabel = document.getElementById('context-usage-label');
  if (usageLabel && msg.usage) {
    const total = msg.usage.prompt_tokens + msg.usage.completion_tokens;
    usageLabel.textContent = `${total} / ${msg.contextSize} ctx`;
    usageLabel.style.display = 'inline-flex';
    if (total > msg.contextSize * 0.9) {
      usageLabel.style.color = 'var(--status-error)';
    } else if (total > msg.contextSize * 0.75) {
      usageLabel.style.color = 'var(--status-starting)';
    } else {
      usageLabel.style.color = 'var(--text-muted)';
    }
  }
}
