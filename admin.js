let currentUser = null;
let conversations = [];
let activeConversationId = null;
let messagesChannel = null;
let conversationsChannel = null;
let allMessagesChannel = null;

const conversationsListEl = document.getElementById('conversations-list');
const messagesEl = document.getElementById('admin-messages');
const form = document.getElementById('admin-chat-form');
const textInput = document.getElementById('admin-text-input');
const imageInput = document.getElementById('admin-image-input');
const headerName = document.getElementById('admin-chat-header-name');
const logoutBtn = document.getElementById('admin-logout-btn');
const backBtn = document.getElementById('admin-back-btn');
const emptyEl = document.getElementById('admin-empty-msg');
const imagePreview = document.getElementById('admin-image-preview');
let selectedFiles = [];

function renderPreviews() {
  imagePreview.querySelectorAll('img').forEach(img => {
    if (img.src && img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
  });
  imagePreview.innerHTML = '';

  if (selectedFiles.length === 0) {
    imagePreview.hidden = true;
  } else {
    imagePreview.hidden = false;
    selectedFiles.forEach(file => {
      const wrapper = document.createElement('div');
      wrapper.className = 'preview-item';
      const img = document.createElement('img');
      img.src = URL.createObjectURL(file);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'preview-clear';
      btn.textContent = '×';
      btn.setAttribute('aria-label', '사진 제거');
      btn.addEventListener('click', () => {
        selectedFiles = selectedFiles.filter(f => f !== file);
        renderPreviews();
      });
      wrapper.appendChild(img);
      wrapper.appendChild(btn);
      imagePreview.appendChild(wrapper);
    });
  }
  requestAnimationFrame(scrollToBottom);
}

function clearPreview() {
  imageInput.value = '';
  selectedFiles = [];
  renderPreviews();
}

imageInput.addEventListener('change', () => {
  selectedFiles = Array.from(imageInput.files);
  renderPreviews();
});

(async function init() {
  currentUser = await requireAuth('admin');
  if (!currentUser) return;

  await loadConversations();
  subscribeConversations();
  subscribeAllMessages();
})();

async function loadConversations() {
  const { data, error } = await sb
    .from('conversations')
    .select('id, client_id, last_message_at, profiles!inner(display_name, role)')
    .eq('profiles.role', 'client')
    .order('last_message_at', { ascending: false });
  if (error) { console.error(error); return; }
  conversations = data || [];
  renderConversations();
}

function renderConversations() {
  conversationsListEl.innerHTML = '';
  if (conversations.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'conv-empty';
    empty.textContent = '아직 대화가 없습니다';
    conversationsListEl.appendChild(empty);
    return;
  }
  conversations.forEach(c => {
    const item = document.createElement('div');
    item.className = 'conv-item' + (c.id === activeConversationId ? ' active' : '');
    item.innerHTML = `
      <div class="conv-name">${escapeHtml(c.profiles?.display_name || '익명')}</div>
      <div class="conv-time">${formatRelative(c.last_message_at)}</div>
    `;
    item.addEventListener('click', () => openConversation(c.id));
    conversationsListEl.appendChild(item);
  });
}

async function openConversation(id) {
  activeConversationId = id;
  const conv = conversations.find(c => c.id === id);
  headerName.textContent = conv?.profiles?.display_name || '익명';
  document.body.classList.add('admin-chat-open');
  if (emptyEl) emptyEl.remove();
  renderConversations();
  await loadMessages();
  subscribeMessages();
}

backBtn.addEventListener('click', () => {
  document.body.classList.remove('admin-chat-open');
});

async function loadMessages() {
  const { data, error } = await sb
    .from('messages')
    .select('*')
    .eq('conversation_id', activeConversationId)
    .order('created_at', { ascending: true });
  if (error) { console.error(error); return; }
  messagesEl.innerHTML = '';
  data.forEach(addMessage);
  scrollToBottom();
}

function addMessage(msg) {
  if (document.querySelector(`[data-msg-id="${msg.id}"]`)) return;
  const div = document.createElement('div');
  div.className = 'msg ' + (msg.sender_id === currentUser.id ? 'mine' : 'theirs');
  div.dataset.msgId = msg.id;
  if (msg.body) {
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = msg.body;
    div.appendChild(bubble);
  }
  if (msg.image_url) {
    const img = document.createElement('img');
    img.className = 'msg-img';
    img.src = msg.image_url;
    img.loading = 'lazy';
    img.addEventListener('click', () => window.open(msg.image_url, '_blank'));
    div.appendChild(img);
  }
  const time = document.createElement('div');
  time.className = 'time';
  time.textContent = formatTime(msg.created_at);
  div.appendChild(time);
  messagesEl.appendChild(div);
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function subscribeMessages() {
  if (messagesChannel) sb.removeChannel(messagesChannel);
  messagesChannel = sb.channel('admin-msgs-' + activeConversationId)
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'messages',
      filter: `conversation_id=eq.${activeConversationId}`
    }, (payload) => {
      addMessage(payload.new);
      scrollToBottom();
    })
    .subscribe();
}

function subscribeConversations() {
  conversationsChannel = sb.channel('admin-convs')
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'conversations'
    }, () => loadConversations())
    .subscribe();
}

function subscribeAllMessages() {
  allMessagesChannel = sb.channel('admin-all-msgs')
    .on('postgres_changes', {
      event: 'INSERT', schema: 'public', table: 'messages'
    }, () => loadConversations())
    .subscribe();
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!activeConversationId) return;
  const text = textInput.value.trim();
  const filesToSend = selectedFiles.slice();
  if (!text && filesToSend.length === 0) return;

  textInput.value = '';
  textInput.focus();
  clearPreview();

  setFormDisabled(true);
  try {
    if (text) {
      const { error } = await sb.from('messages').insert({
        conversation_id: activeConversationId,
        sender_id: currentUser.id,
        body: text,
        image_url: null
      });
      if (error) { alert('전송 실패: ' + error.message); return; }
    }

    for (const file of filesToSend) {
      const imageUrl = await uploadImage(file, currentUser.id);
      if (!imageUrl) continue;
      const { error } = await sb.from('messages').insert({
        conversation_id: activeConversationId,
        sender_id: currentUser.id,
        body: null,
        image_url: imageUrl
      });
      if (error) console.error('이미지 메시지 실패:', error);
    }

    await sb.from('conversations')
      .update({ last_message_at: new Date().toISOString() })
      .eq('id', activeConversationId);
  } finally {
    setFormDisabled(false);
  }
});

function setFormDisabled(b) {
  form.querySelectorAll('button, input[type="file"]').forEach(el => el.disabled = b);
}

logoutBtn.addEventListener('click', async () => {
  [messagesChannel, conversationsChannel, allMessagesChannel].forEach(ch => {
    if (ch) sb.removeChannel(ch);
  });
  await sb.auth.signOut();
  window.location.href = 'index.html';
});
