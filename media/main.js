const vscode = acquireVsCodeApi();
window.vscode = vscode;
window.sendToolAction = function(callId, action, filePath) {
  vscode.postMessage({ type: 'toolAction', callId, action, filePath });
};

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
const startBtn = document.getElementById('start-btn');

// Sessions view elements
const sessionsToggleBtn = document.getElementById('sessions-toggle-btn');
const newSessionBtn = document.getElementById('new-session-btn');
const sessionsView = document.getElementById('sessions-view');
const chatMessagesView = document.getElementById('chat-messages-view');
const chatHeader = document.getElementById('chat-header');
const chatHeaderTitle = document.getElementById('chat-header-title');
const backToSessionsBtn = document.getElementById('back-to-sessions-btn');
const sessionsCloseBtn = document.getElementById('sessions-close-btn');
const sessionsListContainer = document.getElementById('sessions-list');

// Tool configuration elements
const configureToolsBtn = document.getElementById('configure-tools-btn');
const toolConfigModal = document.getElementById('tool-config-modal');
const toolConfigBody = document.getElementById('tool-config-body');
const toolConfigClose = document.getElementById('tool-config-close');
const toolsConfigCount = document.getElementById('tools-config-count');

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

let sessionsList = [];
let currentSessionId = '';

// Mentions state
const mentionsDropdown = document.getElementById('mentions-dropdown');
const attachmentTagsContainer = document.getElementById('attachment-tags');
let workspaceFiles = []; // populated from backend
let attachedFiles = []; // array of { path, basename }
let mentionsState = {
  active: false,
  query: '',
  startIndex: -1,
  selectedIndex: 0,
  filteredFiles: []
};

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
  // Show/hide the configure tools button based on tools enabled state
  if (configureToolsBtn) {
    configureToolsBtn.style.display = toolsEnabled ? 'flex' : 'none';
  }
});

// Configure Tools button
if (configureToolsBtn) {
  configureToolsBtn.addEventListener('click', () => {
    if (!toolConfigModal.classList.contains('hidden')) {
      toolConfigModal.classList.add('hidden');
    } else {
      vscode.postMessage({ type: 'getToolConfig' });
    }
  });
}

// Close tool config modal
if (toolConfigClose) {
  toolConfigClose.addEventListener('click', () => {
    toolConfigModal.classList.add('hidden');
  });
}

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

// ─── Sessions View Listeners ────────────────────────────────────────────────

function showSessionsView() {
  sessionsView.classList.remove('hidden');
  chatMessagesView.classList.add('hidden');
  if (configView) configView.style.display = 'none';
  if (chatView) chatView.style.display = 'flex';
}

function showChatView(title) {
  sessionsView.classList.add('hidden');
  chatMessagesView.classList.remove('hidden');
  if (title) {
    chatHeader.classList.remove('hidden');
    chatHeaderTitle.textContent = title;
  } else {
    chatHeader.classList.add('hidden');
  }
}

if (sessionsToggleBtn) {
  sessionsToggleBtn.addEventListener('click', () => {
    if (sessionsView.classList.contains('hidden')) {
      showSessionsView();
    } else {
      showChatView(chatHistory.length > 0 ? (sessionsList.find(s => s.id === currentSessionId)?.title || 'Chat') : null);
    }
  });
}

if (backToSessionsBtn) {
  backToSessionsBtn.addEventListener('click', () => {
    showSessionsView();
  });
}

if (sessionsCloseBtn) {
  sessionsCloseBtn.addEventListener('click', () => {
    showChatView(chatHistory.length > 0 ? (sessionsList.find(s => s.id === currentSessionId)?.title || 'Chat') : null);
  });
}

if (newSessionBtn) {
  newSessionBtn.addEventListener('click', () => {
    startNewSession();
  });
}

function startNewSession() {
  currentSessionId = Date.now().toString();
  chatHistory = [];
  messagesContainer.innerHTML = `
    <div class="welcome-message">
      <h3>Local LLM Sidebar Chat</h3>
      <p>Choose a model from the dropdown above. The extension will automatically spawn the llama-server command in your VS Code terminal and connect to it.</p>
      <p style="font-size: 11px; margin-top: 10px; color: var(--accent-color);">💡 Tip: Highlight any code in your editor to automatically attach it to your prompts!</p>
    </div>
  `;
  showChatView();
  renderSessions();
}

function renderSessions() {
  if (!sessionsListContainer) return;
  sessionsListContainer.innerHTML = '';

  sessionsList.forEach(session => {
    const item = document.createElement('div');
    item.className = 'session-item';
    if (session.id === currentSessionId) {
      item.classList.add('active');
    }

    const dot = document.createElement('div');
    dot.className = 'session-dot';
    
    const content = document.createElement('div');
    content.className = 'session-content';

    const title = document.createElement('div');
    title.className = 'session-title';
    title.textContent = session.title || 'New Chat';

    const time = document.createElement('div');
    time.className = 'session-time';
    // Format timestamp nicely, or just 'now' if recent
    const diff = Date.now() - session.timestamp;
    if (diff < 60000) {
      time.textContent = 'now';
    } else if (diff < 3600000) {
      time.textContent = Math.floor(diff / 60000) + 'm ago';
    } else if (diff < 86400000) {
      time.textContent = Math.floor(diff / 3600000) + 'h ago';
    } else {
      time.textContent = new Date(session.timestamp).toLocaleDateString();
    }

    content.appendChild(title);
    content.appendChild(time);
    item.appendChild(dot);
    item.appendChild(content);

    item.addEventListener('click', () => {
      loadSession(session);
    });

    sessionsListContainer.appendChild(item);
  });
}

function loadSession(session) {
  currentSessionId = session.id;
  chatHistory = session.messages || [];
  
  // Clear messages container
  messagesContainer.innerHTML = '';
  
  if (chatHistory.length === 0) {
    startNewSession();
    return;
  }
  
  // Render chat history
  chatHistory.forEach(msg => {
    if (msg.role === 'user') {
      appendBubble('user', msg.content);
    } else if (msg.role === 'assistant') {
      // Create a bubble and append content
      const wrapper = document.createElement('div');
      wrapper.className = 'message-wrapper assistant';
      
      const label = document.createElement('div');
      label.className = 'sender-label';
      label.textContent = msg.tool_calls ? 'Agent' : 'Local Assistant';
      wrapper.appendChild(label);
      
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      bubble.innerHTML = parseMarkdown(msg.content || '', true);
      wrapper.appendChild(bubble);
      
      messagesContainer.appendChild(wrapper);
    }
  });
  
  showChatView(session.title);
  renderSessions();
  scrollToBottom();
}

function saveCurrentSession() {
  if (!currentSessionId) {
    currentSessionId = Date.now().toString();
  }
  
  // Generate title from first user message
  let title = 'New Chat';
  const firstUserMsg = chatHistory.find(m => m.role === 'user');
  if (firstUserMsg && firstUserMsg.content) {
    // extract clean text without markdown links/images if possible
    let cleanText = firstUserMsg.content.split('\\n')[0];
    if (cleanText.length > 25) {
      cleanText = cleanText.substring(0, 25) + '...';
    }
    title = cleanText;
  }

  const sessionData = {
    id: currentSessionId,
    title,
    timestamp: Date.now(),
    messages: chatHistory
  };

  if (!chatHeader.classList.contains('hidden') && chatHeaderTitle) {
    chatHeaderTitle.textContent = title;
  }

  vscode.postMessage({ type: 'saveSession', session: sessionData });
}

// ─── Init ───────────────────────────────────────────────────────────────────

vscode.postMessage({ type: 'getModels' });

// ─── Message Handler ────────────────────────────────────────────────────────

window.addEventListener('message', e => {
  const msg = e.data;
  switch (msg.type) {
    case 'sessionsList':
      sessionsList = msg.sessions;
      if (!currentSessionId && sessionsList.length > 0) {
        // Optional: auto-load most recent session if none active
        // But for now, we just start a new session if empty
      }
      renderSessions();
      break;
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
    case 'streamStart':
      handleStreamStart();
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
    case 'turnEditsComplete':
      handleTurnEditsComplete(msg);
      break;
    case 'toolActionComplete':
      const confirmBlockId = document.getElementById(`tool-${msg.callId}`);
      if (confirmBlockId) {
        const cBlock = confirmBlockId.querySelector('.tool-call-confirmation');
        if (cBlock) cBlock.classList.add('hidden');
      }
      break;
    case 'turnActionComplete':
      const worktreeContainer = document.getElementById('worktree-container');
      if (worktreeContainer) {
        worktreeContainer.innerHTML = '';
      }
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
    case 'toolConfig':
      renderToolConfigModal(msg.categories, msg.disabledTools);
      break;
    case 'workspaceFiles':
      workspaceFiles = msg.files || [];
      if (mentionsState.active) {
        renderMentionsDropdown();
      }
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
          <button class="config-edit-btn" data-action="editModel" data-model-id="${model.id}" title="Edit Model">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button class="config-delete-btn" data-action="deleteModel" data-model-id="${model.id}" title="Delete Model">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </div>
      </div>
    `;

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

if (startBtn) {
  startBtn.addEventListener('click', () => {
    if (selectedModelId) {
      vscode.postMessage({ type: 'selectModel', modelId: selectedModelId });
    }
  });
}

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
  if (mentionsState.active) {
    if (e.key === 'Escape') {
      mentionsState.active = false;
      renderMentionsDropdown();
      e.preventDefault();
      return;
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      mentionsState.selectedIndex = (mentionsState.selectedIndex + 1) % mentionsState.filteredFiles.length;
      renderMentionsDropdown();
      return;
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      mentionsState.selectedIndex = (mentionsState.selectedIndex - 1 + mentionsState.filteredFiles.length) % mentionsState.filteredFiles.length;
      renderMentionsDropdown();
      return;
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (mentionsState.filteredFiles.length > 0) {
        addAttachedFile(mentionsState.filteredFiles[mentionsState.selectedIndex]);
      }
      return;
    }
  }

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

  // Mentions logic
  const cursor = chatInput.selectionStart;
  const text = chatInput.value;
  const textBeforeCursor = text.slice(0, cursor);
  
  // Regex to match @ followed by non-whitespace characters at the end of the string
  const match = textBeforeCursor.match(/@([^\s]*)$/);
  
  if (match) {
    mentionsState.active = true;
    mentionsState.query = match[1].toLowerCase();
    mentionsState.startIndex = match.index;
    
    // Fetch files if we haven't already
    if (workspaceFiles.length === 0) {
      vscode.postMessage({ type: 'getWorkspaceFiles' });
    }
    
    filterAndRenderMentions();
  } else {
    mentionsState.active = false;
    renderMentionsDropdown();
  }
});

function filterAndRenderMentions() {
  if (!mentionsState.active) return;
  
  const query = mentionsState.query;
  mentionsState.filteredFiles = workspaceFiles
    .filter(f => f.path.toLowerCase().includes(query) || f.basename.toLowerCase().includes(query))
    .slice(0, 10); // Show max 10
    
  mentionsState.selectedIndex = 0;
  renderMentionsDropdown();
}

function renderMentionsDropdown() {
  if (!mentionsState.active || mentionsState.filteredFiles.length === 0) {
    mentionsDropdown.classList.add('hidden');
    mentionsDropdown.innerHTML = '';
    return;
  }

  let html = '';
  mentionsState.filteredFiles.forEach((file, index) => {
    const isActive = index === mentionsState.selectedIndex ? 'active' : '';
    html += `
      <div class="mention-item ${isActive}" data-index="${index}">
        <svg class="mention-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><polyline points="13 2 13 9 20 9"></polyline></svg>
        <span>${file.basename}</span>
        <span class="mention-path">${file.path}</span>
      </div>
    `;
  });

  mentionsDropdown.innerHTML = html;
  mentionsDropdown.classList.remove('hidden');

  // Scroll active item into view
  const activeItem = mentionsDropdown.querySelector('.active');
  if (activeItem) {
    activeItem.scrollIntoView({ block: 'nearest' });
  }

  // Click handlers
  mentionsDropdown.querySelectorAll('.mention-item').forEach(item => {
    item.addEventListener('click', () => {
      const idx = parseInt(item.dataset.index, 10);
      addAttachedFile(mentionsState.filteredFiles[idx]);
    });
    // Mouse hover updates selected index
    item.addEventListener('mouseenter', () => {
      mentionsState.selectedIndex = parseInt(item.dataset.index, 10);
      renderMentionsDropdown();
    });
  });
}

function addAttachedFile(file) {
  // Check if already attached
  if (!attachedFiles.some(f => f.path === file.path)) {
    attachedFiles.push(file);
  }
  
  // Remove the @query from the input text
  const text = chatInput.value;
  const before = text.slice(0, mentionsState.startIndex);
  const after = text.slice(mentionsState.startIndex + mentionsState.query.length + 1);
  chatInput.value = before + after;
  
  mentionsState.active = false;
  renderMentionsDropdown();
  renderAttachmentTags();
  
  chatInput.focus();
}

function removeAttachedFile(path) {
  attachedFiles = attachedFiles.filter(f => f.path !== path);
  renderAttachmentTags();
}

function renderAttachmentTags() {
  if (attachedFiles.length === 0) {
    attachmentTagsContainer.classList.add('hidden');
    attachmentTagsContainer.innerHTML = '';
    return;
  }
  
  attachmentTagsContainer.classList.remove('hidden');
  let html = '';
  
  attachedFiles.forEach(file => {
    html += `
      <div class="attachment-tag">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><polyline points="13 2 13 9 20 9"></polyline></svg>
        ${file.basename}
        <span class="attachment-tag-remove" data-path="${file.path}">&times;</span>
      </div>
    `;
  });
  
  attachmentTagsContainer.innerHTML = html;
  
  attachmentTagsContainer.querySelectorAll('.attachment-tag-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      removeAttachedFile(e.target.dataset.path);
    });
  });
}

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
  
  if (status === 'starting' || status === 'generating') {
    if (stopBtn) stopBtn.style.display = 'flex';
    if (startBtn) startBtn.style.display = 'none';
  } else if (status === 'idle') {
    if (stopBtn) stopBtn.style.display = 'none';
    if (startBtn) startBtn.style.display = 'flex';
  } else {
    if (stopBtn) stopBtn.style.display = 'flex'; // 'ready'
    if (startBtn) startBtn.style.display = 'none';
  }
  
  openWebUIBtn.style.display = isDisabled ? 'none' : 'flex';
}

function sendMessage() {
  const text = chatInput.value.trim();
  if (!text) return;

  // If typing from the Sessions View, start a new chat automatically
  if (!sessionsView.classList.contains('hidden')) {
    startNewSession();
  }

  chatInput.value = '';
  chatInput.style.height = 'auto';

  const welcome = messagesContainer.querySelector('.welcome-message');
  if (welcome) welcome.remove();

  const includeActiveFile = toggleActiveFileBtn.classList.contains('active') && !toggleActiveFileBtn.disabled;
  const includeWorkspaceMap = toggleWorkspaceBtn.classList.contains('active') && !toggleWorkspaceBtn.disabled;

  appendBubble('user', text);

  chatHistory.push({ role: 'user', content: text });
  saveCurrentSession();

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

  const currentAttachedFiles = [...attachedFiles];

  vscode.postMessage({
    type: 'sendMessage',
    messages: [
      { role: 'system', content: 'You are a helpful coding assistant running locally via llama.cpp. Keep code snippets clean and explain changes clearly.' },
      ...chatHistory
    ],
    includeActiveFile,
    includeWorkspaceMap,
    attachedFiles: currentAttachedFiles,
    temperature,
    maxTokens,
    topP,
    systemPrompt,
    enableTools: toolsEnabled
  });

  // Clear attached files for the next message
  attachedFiles = [];
  renderAttachmentTags();
}

function handleStreamStart() {
  if (!currentAssistantBubble) return;
  currentResponseText = '';
  
  // Remove the '...' if it's the only thing there
  if (currentAssistantBubble.textContent === '...') {
    currentAssistantBubble.innerHTML = '';
  }
  
  // Create a new response container for this chunk of text
  const responseContainer = document.createElement('div');
  responseContainer.className = 'response-text';
  currentAssistantBubble.appendChild(responseContainer);
}

function appendChunk(text) {
  if (!currentAssistantBubble) return;

  currentResponseText += text;
  
  const containers = currentAssistantBubble.querySelectorAll('.response-text');
  let responseContainer = containers.length > 0 ? containers[containers.length - 1] : null;
  
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
  chatHistory.push({
    role: 'assistant',
    content: null,
    tool_calls: [{
      id: msg.callId,
      type: 'function',
      function: {
        name: msg.toolName,
        arguments: JSON.stringify(msg.toolArgs)
      }
    }]
  });

  if (!currentAssistantBubble) return;

  if (currentAssistantBubble.textContent === '...') {
    currentAssistantBubble.innerHTML = '';
  }

  const block = document.createElement('div');
  block.className = 'tool-call-block';
  block.id = `tool-${msg.callId}`;

  const toolIcon = getToolIcon(msg.toolName);
  const argsPreview = formatToolArgs(msg.toolName, msg.toolArgs);

  let badgeText = msg.toolName;
  if (msg.toolName === 'edit_file' || msg.toolName === 'multi_replace_file_content' || msg.toolName === 'replace_file_content') {
    badgeText = 'Edited';
  } else if (msg.toolName === 'read_file' || msg.toolName === 'view_file') {
    badgeText = 'Read';
  }

  // Try to find filename from args
  let fileName = '';
  if (msg.toolArgs && (msg.toolArgs.TargetFile || msg.toolArgs.AbsolutePath || msg.toolArgs.SearchPath)) {
    const fullPath = msg.toolArgs.TargetFile || msg.toolArgs.AbsolutePath || msg.toolArgs.SearchPath;
    fileName = fullPath.split('/').pop().split('\\').pop();
  }

  const badgeHtml = fileName ? `
    <span class="tool-timeline-action">${badgeText}</span>
    <span class="tool-timeline-badge">
      <span class="tool-timeline-file-icon">📝</span>
      <span class="tool-timeline-filename">${fileName}</span>
      <span class="tool-timeline-stats hidden" id="stats-${msg.callId}"></span>
    </span>
  ` : `
    <span class="tool-timeline-action">${badgeText}</span>
  `;

  block.innerHTML = `
    <div class="tool-timeline-row executing" data-action="toggleToolDetails">
      <div class="tool-timeline-icon">
        <span class="tool-call-spinner"></span>
      </div>
      <div class="tool-timeline-content">
        ${badgeHtml}
      </div>
      <svg class="tool-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
    </div>
    <div class="tool-call-details hidden">
      <div class="tool-detail-section">
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
  chatHistory.push({
    role: 'tool',
    tool_call_id: msg.callId,
    content: String(msg.output)
  });

  const block = document.getElementById(`tool-${msg.callId}`);
  if (!block) {
    if (currentAssistantBubble) {
      const fallbackBlock = document.createElement('div');
      fallbackBlock.className = 'tool-call-block';
      fallbackBlock.innerHTML = `
        <div class="tool-call-header ${msg.success ? 'success' : 'error'}">
          <div class="tool-call-status-icon">
            ${msg.success ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>' : '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'}
          </div>
          <div class="tool-call-title">
            <span class="tool-call-name">${msg.toolName}</span>
          </div>
          <svg class="tool-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
        </div>
      `;
      currentAssistantBubble.appendChild(fallbackBlock);
    }
    return;
  }

  const header = block.querySelector('.tool-timeline-row');
  if (header) {
    header.classList.remove('executing');
    header.classList.add(msg.denied ? 'denied' : msg.success ? 'success' : 'error');
    
    const iconContainer = header.querySelector('.tool-timeline-icon');
    if (iconContainer) {
      const statusIcon = msg.denied ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>' : 
                         msg.success ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>' : 
                         '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
      iconContainer.innerHTML = statusIcon;
    }

    const statsContainer = block.querySelector('.tool-timeline-stats');
    if (statsContainer && (msg.addedLines || msg.removedLines)) {
      statsContainer.classList.remove('hidden');
      statsContainer.innerHTML = `<span class="added">+${msg.addedLines || 0}</span> <span class="removed">-${msg.removedLines || 0}</span>`;
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
function handleTurnEditsComplete(msg) {
  if (!msg.edits || msg.edits.length === 0) return;

  const worktreeContainer = document.getElementById('worktree-container');
  if (!worktreeContainer) return;

  const worktreeBlock = document.createElement('div');
  worktreeBlock.className = 'worktree-block';
  
  let totalAdded = 0;
  let totalRemoved = 0;
  
  let filesHtml = msg.edits.map(edit => {
    totalAdded += edit.addedLines || 0;
    totalRemoved += edit.removedLines || 0;
    
    // Safely encode file path for data attribute
    const safePath = escapeHtml(edit.filePath);
    return `
      <div class="worktree-file-row" data-action="reviewFile" data-path="${safePath}">
        <div class="worktree-file-info">
          <span class="worktree-file-icon">📝</span>
          <span class="worktree-file-name">${escapeHtml(edit.fileName)}</span>
        </div>
        <div class="worktree-diff-stats">
          <span class="added">+${edit.addedLines || 0}</span>
          <span class="removed">-${edit.removedLines || 0}</span>
        </div>
      </div>
    `;
  }).join('');

  const firstPath = msg.edits.length > 0 ? escapeHtml(msg.edits[0].filePath) : '';

  worktreeBlock.innerHTML = `
    <div class="worktree-header" data-action="toggleWorktree">
      <div class="worktree-header-left">
        <svg class="worktree-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
        <span class="worktree-title">${msg.edits.length} file${msg.edits.length > 1 ? 's' : ''} changed</span>
        <span class="worktree-diff-stats">
          <span class="added">+${totalAdded}</span>
          <span class="removed">-${totalRemoved}</span>
        </span>
      </div>
      <div class="worktree-actions">
        <button class="worktree-btn primary" data-action="acceptAll">Keep</button>
        <button class="worktree-btn secondary" data-action="rejectAll">Undo</button>
        <button class="worktree-btn icon" title="View Diffs" data-action="reviewFile" data-path="${firstPath}">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" d="M2 2h12v12H2V2zm1.5 1.5v9h9v-9h-9zM8 4h1v3.5H12v1H9V12H8V8.5H4.5v-1H8V4z"/></svg>
        </button>
      </div>
    </div>
    <div class="worktree-files-list hidden">
      ${filesHtml}
    </div>
  `;

  worktreeContainer.innerHTML = '';
  worktreeContainer.appendChild(worktreeBlock);
}

// Event Delegation for dynamically generated elements (CSP prevents inline onclick)
document.addEventListener('click', (e) => {
  // Find closest element with data-action attribute
  const target = e.target.closest('[data-action]');
  if (!target) return;
  
  const action = target.getAttribute('data-action');
  
  if (action === 'approve' || action === 'reject') {
    e.stopPropagation();
    sendToolAction(target.getAttribute('data-callid'), action);
  } else if (action === 'acceptAll' || action === 'rejectAll') {
    e.stopPropagation();
    sendToolAction('', action);
  } else if (action === 'reviewFile') {
    e.stopPropagation();
    const filePath = target.getAttribute('data-path');
    if (filePath) {
      sendToolAction('', 'reviewFile', filePath);
    }
  } else if (action === 'toggleWorktree') {
    e.stopPropagation();
    toggleWorktree(target);
  } else if (action === 'toggleToolDetails') {
    e.stopPropagation();
    toggleToolDetails(target);
  } else if (action === 'editModel') {
    e.stopPropagation();
    const modelId = target.getAttribute('data-model-id');
    const model = modelsList.find(m => m.id === modelId);
    if (model) openModelForm(model);
  } else if (action === 'deleteModel') {
    e.stopPropagation();
    vscode.postMessage({ type: 'deleteModel', modelId: target.getAttribute('data-model-id') });
  }
});

window.toggleWorktree = function(el) {
  const content = el.nextElementSibling;
  const chevron = el.querySelector('.worktree-chevron');
  if (content) {
    content.classList.toggle('hidden');
    if (chevron) {
      chevron.style.transform = content.classList.contains('hidden') ? '' : 'rotate(90deg)';
    }
  }
};

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
    const containers = currentAssistantBubble.querySelectorAll('.response-text');
    let responseContainer = containers.length > 0 ? containers[containers.length - 1] : null;
    if (responseContainer) {
      responseContainer.innerHTML = parseMarkdown(currentResponseText, true);
    }
    chatHistory.push({ role: 'assistant', content: currentResponseText });
    saveCurrentSession();
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

function parseMarkdown(text, isComplete = false) {
  if (!text) return '';
  let html = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  
  // Parse <think> tags (which are now &lt;think&gt;)
  html = html.replace(/&lt;think&gt;/gi, `<details class="think-block" ${isComplete ? '' : 'open'}><summary>Thinking...</summary><div class="think-content">`)
             .replace(/&lt;\/think&gt;/gi, '</div></details>');

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

// ─── Tool Configuration Modal ───────────────────────────────────────────────

function renderToolConfigModal(categories, disabledTools) {
  if (!toolConfigModal || !toolConfigBody) return;

  const disabledSet = new Set(disabledTools || []);
  let totalTools = 0;
  let enabledTools = 0;

  let html = '';
  
  for (const category of categories) {
    const allDisabled = category.tools.every(t => disabledSet.has(t));
    const someDisabled = category.tools.some(t => disabledSet.has(t));
    const categoryChecked = !allDisabled;
    const categoryIndeterminate = someDisabled && !allDisabled;

    html += `
      <div class="tool-config-category">
        <div class="tool-config-category-header">
          <label class="tool-config-checkbox-label">
            <input type="checkbox" class="tool-config-category-checkbox" data-category="${category.id}" 
              ${categoryChecked ? 'checked' : ''} ${categoryIndeterminate ? 'data-indeterminate="true"' : ''}>
            <span class="tool-config-category-icon">${category.icon}</span>
            <span class="tool-config-category-name">${category.name}</span>
          </label>
          <span class="tool-config-category-desc">${category.description}</span>
        </div>
        <div class="tool-config-tools">
    `;

    for (const toolName of category.tools) {
      totalTools++;
      const isEnabled = !disabledSet.has(toolName);
      if (isEnabled) enabledTools++;

      const displayName = toolName.replace(/_/g, ' ');
      html += `
        <label class="tool-config-tool-label">
          <input type="checkbox" class="tool-config-tool-checkbox" data-tool="${toolName}" data-category="${category.id}" ${isEnabled ? 'checked' : ''}>
          <span class="tool-config-tool-name">${displayName}</span>
        </label>
      `;
    }

    html += `
        </div>
      </div>
    `;
  }

  toolConfigBody.innerHTML = html;

  // Update count label
  if (toolsConfigCount) {
    toolsConfigCount.textContent = `${enabledTools}/${totalTools} Tools`;
  }

  // Show the modal
  toolConfigModal.classList.remove('hidden');

  // Set indeterminate state for category checkboxes
  toolConfigBody.querySelectorAll('[data-indeterminate="true"]').forEach(cb => {
    cb.indeterminate = true;
  });

  // Category checkbox click handler
  toolConfigBody.querySelectorAll('.tool-config-category-checkbox').forEach(cb => {
    cb.addEventListener('change', (e) => {
      const categoryId = e.target.dataset.category;
      const isChecked = e.target.checked;
      toolConfigBody.querySelectorAll(`.tool-config-tool-checkbox[data-category="${categoryId}"]`).forEach(toolCb => {
        toolCb.checked = isChecked;
      });
      saveToolConfig();
    });
  });

  // Individual tool checkbox click handler
  toolConfigBody.querySelectorAll('.tool-config-tool-checkbox').forEach(cb => {
    cb.addEventListener('change', () => {
      // Update category checkbox state
      const categoryId = cb.dataset.category;
      const categoryTools = toolConfigBody.querySelectorAll(`.tool-config-tool-checkbox[data-category="${categoryId}"]`);
      const categoryCb = toolConfigBody.querySelector(`.tool-config-category-checkbox[data-category="${categoryId}"]`);
      const allChecked = [...categoryTools].every(t => t.checked);
      const someChecked = [...categoryTools].some(t => t.checked);
      
      if (categoryCb) {
        categoryCb.checked = allChecked;
        categoryCb.indeterminate = someChecked && !allChecked;
      }
      saveToolConfig();
    });
  });
}

function saveToolConfig() {
  if (!toolConfigBody) return;
  
  const disabledTools = [];
  let totalTools = 0;
  let enabledTools = 0;

  toolConfigBody.querySelectorAll('.tool-config-tool-checkbox').forEach(cb => {
    totalTools++;
    if (!cb.checked) {
      disabledTools.push(cb.dataset.tool);
    } else {
      enabledTools++;
    }
  });

  // Update count label
  if (toolsConfigCount) {
    toolsConfigCount.textContent = `${enabledTools}/${totalTools} Tools`;
  }

  // Send to backend
  vscode.postMessage({ type: 'updateDisabledTools', disabledTools });
}
