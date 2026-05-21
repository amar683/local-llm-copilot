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

let modelsList = [];
let selectedModelId = '';
let chatHistory = [];
let isGenerating = false;
let currentAssistantBubble = null;
let currentResponseText = '';

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

// Auto-expand input height as text wraps
chatInput.addEventListener('input', () => {
  chatInput.style.height = 'auto';
  chatInput.style.height = `${chatInput.scrollHeight}px`;
});

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

  appendBubble('user', text);
  chatHistory.push({ role: 'user', content: text });

  currentAssistantBubble = appendBubble('assistant', '...');
  currentResponseText = '';
  isGenerating = true;

  sendIcon.classList.add('hidden');
  stopGenIcon.classList.remove('hidden');

  vscode.postMessage({
    type: 'sendMessage',
    messages: [
      { role: 'system', content: 'You are a helpful coding assistant running locally via llama.cpp. Keep code snippets clean and explain changes clearly.' },
      ...chatHistory
    ]
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
    bubble.textContent = text;
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

// Quick regex-based parser for markdown syntax and code blocks
function parseMarkdown(text) {
  if (!text) return '';
  
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  
  // Fenced code blocks
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (m, lang, code) => {
    const language = lang || 'code';
    const nonce = Math.random().toString(36).substring(7);
    return `<pre><div class="code-header"><span>${language}</span><button class="copy-btn" onclick="copyToClipboard('${nonce}')" id="copy-${nonce}">Copy</button></div><code id="code-${nonce}">${code.trim()}</code></pre>`;
  });
  
  // Inline code, bold, italics
  html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>')
             .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
             .replace(/\*([^*]+)\*/g, '<em>$1</em>');
  
  // Headers
  html = html.replace(/^### (.*$)/gim, '<h3>$1</h3>')
             .replace(/^## (.*$)/gim, '<h2>$1</h2>')
             .replace(/^# (.*$)/gim, '<h1>$1</h1>');
  
  // Lists
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
  
  // Clean paragraphs
  html = html.split('\n\n').map(p => {
    const trimmed = p.trim();
    if (!trimmed) return '';
    if (trimmed.match(/^(<pre|<ul|<li|<h1|<h2|<h3)/)) return trimmed;
    return `<p>${trimmed.replace(/\n/g, '<br>')}</p>`;
  }).join('');
  
  return html;
}
