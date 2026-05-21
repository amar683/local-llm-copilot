const vscode = acquireVsCodeApi();

const modelSelect = document.getElementById('model-select');
const statusIndicator = document.getElementById('status-indicator');
const statusText = document.getElementById('status-text');
const stopBtn = document.getElementById('stop-btn');
const messagesContainer = document.getElementById('messages-container');
const chatInput = document.getElementById('chat-input');
const sendBtn = document.getElementById('send-btn');
const clearBtn = document.getElementById('clear-btn');
const sendIcon = document.getElementById('send-icon');
const stopGenIcon = document.getElementById('stop-generation-icon');

// Selection bar elements
const selectionBar = document.getElementById('selection-bar');
const selectionText = document.getElementById('selection-text');

const toggleActiveFileBtn = document.getElementById('toggle-active-file');
const activeFileLabel = document.getElementById('active-file-label');
const toggleWorkspaceBtn = document.getElementById('toggle-workspace');
const workspaceLabel = document.getElementById('workspace-label');

// Settings elements
const settingsToggleBtn = document.getElementById('settings-toggle-btn');
const settingsPanel = document.getElementById('settings-panel');
const tempInput = document.getElementById('settings-temp');
const tempVal = document.getElementById('settings-temp-val');
const toppInput = document.getElementById('settings-topp');
const toppVal = document.getElementById('settings-topp-val');
const maxTokensInput = document.getElementById('settings-max-tokens');
const systemPromptInput = document.getElementById('settings-system-prompt');

let modelsList = [];
let selectedModelId = '';
let chatHistory = [];
let isGenerating = false;
let currentAssistantBubble = null;
let currentResponseText = '';
let nextMessageContext = null; // holds context details for the next sent message
let nextWorkspaceMapAttached = false; // holds workspace attachment flag

// Toggle buttons event listeners
toggleActiveFileBtn.addEventListener('click', () => {
  toggleActiveFileBtn.classList.toggle('active');
});

toggleWorkspaceBtn.addEventListener('click', () => {
  toggleWorkspaceBtn.classList.toggle('active');
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

// Load initial model configuration
vscode.postMessage({ type: 'getModels' });

window.addEventListener('message', e => {
  const msg = e.data;
  switch (msg.type) {
    case 'modelsList':
      modelsList = msg.models;
      updateDropdown(msg.selectedId);
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
  }
});

modelSelect.addEventListener('change', (e) => {
  selectedModelId = e.target.value;
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

function handleContextUpdate(data) {
  const hasActiveFile = data.hasActiveFile;
  const activeFileName = data.activeFileName || '';
  const hasWorkspace = data.hasWorkspace;
  const workspaceName = data.workspaceName || '';

  // Update active file button state
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

  // Update workspace map button state
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

  // Handle selection indicator overlay
  if (data.hasSelection) {
    selectionText.textContent = `Attached selection: ${data.selectionFileName} (${data.selectionLineCount} lines)`;
    selectionBar.classList.remove('hidden');
    // Visually mark active file button as overridden by selection context
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
    opt.text = "No models configured";
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
}

function updateStatus(status, text) {
  statusIndicator.className = `status-indicator ${status}`;
  statusText.textContent = text;

  const isDisabled = status !== 'ready';
  chatInput.disabled = isDisabled;
  sendBtn.disabled = isDisabled;
  stopBtn.style.display = isDisabled ? 'none' : 'flex';
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

  // The 'messageContextAttached' response from the Extension host will load nextMessageContext.
  // We trigger appendBubble right after the message is sent. We wait a tiny tick for postMessage async,
  // or we can handle it synchronously since the host is local.
  // To avoid race conditions, we can query active selection synchronously or use a tiny timeout.
  // Actually, let's just append the bubble. If nextMessageContext is set, it will be added.
  setTimeout(() => {
    appendBubble('user', text);
  }, 10);

  chatHistory.push({ role: 'user', content: text });

  currentAssistantBubble = appendBubble('assistant', '...');
  currentResponseText = '';
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
    systemPrompt
  });
}

function appendChunk(text) {
  if (!currentAssistantBubble) return;

  if (currentResponseText === '') {
    currentAssistantBubble.innerHTML = '';
  }

  currentResponseText += text;
  currentAssistantBubble.innerHTML = parseMarkdown(currentResponseText);
  scrollToBottom();
}

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
    <div class="bubble" style="background-color: var(--status-error); color: #000; border: none;">
      ${err}
    </div>
  `;
  messagesContainer.appendChild(wrapper);
  scrollToBottom();
}

function appendBubble(sender, text) {
  const wrapper = document.createElement('div');
  wrapper.className = `message-wrapper ${sender}`;

  const label = document.createElement('div');
  label.className = 'sender-label';
  label.textContent = sender === 'user' ? 'You' : 'Local Assistant';
  wrapper.appendChild(label);

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  
  if (sender === 'user') {
    // If context was attached, create a tag before user prompt
    if (nextMessageContext) {
      const tag = document.createElement('div');
      tag.className = 'attached-context-tag';
      
      const fileIcon = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="margin-right: 4px;"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
      const selectionIcon = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="margin-right: 4px;"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>`;
      
      const icon = nextMessageContext.type === 'selection' ? selectionIcon : fileIcon;
      const typeLabel = nextMessageContext.type === 'selection' ? 'selection' : 'file';
      
      tag.innerHTML = `
        ${icon}
        <span>${nextMessageContext.fileName} (${typeLabel}, ${nextMessageContext.lineCount} lines)</span>
      `;
      bubble.appendChild(tag);
      nextMessageContext = null; // reset
    }

    if (nextWorkspaceMapAttached) {
      const tag = document.createElement('div');
      tag.className = 'attached-context-tag';
      tag.innerHTML = `
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="margin-right: 4px;"><rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/></svg>
        <span>Workspace Map</span>
      `;
      bubble.appendChild(tag);
      nextWorkspaceMapAttached = false; // reset
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

function parseMarkdown(text) {
  if (!text) return '';
  
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  
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
