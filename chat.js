let currentUser = null;
let conversationId = null;
let messagesChannel = null;

const messagesEl = document.getElementById('messages');
const form = document.getElementById('chat-form');
const textInput = document.getElementById('text-input');
const imageInput = document.getElementById('image-input');
const logoutBtn = document.getElementById('logout-btn');
const imagePreview = document.getElementById('image-preview');
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

// 전송 버튼 탭으로 인한 input 블러 방지 (iOS 키보드 유지)
form.querySelector('button[type="submit"]').addEventListener('mousedown', (e) => {
  e.preventDefault();
});

(async function init() {
  currentUser = await requireAuth('client');
  if (!currentUser) return;

  // 본인 대화방을 가져오거나 없으면 생성
  const { data: existing } = await sb
    .from('conversations')
    .select('id')
    .eq('client_id', currentUser.id)
    .maybeSingle();

  if (existing) {
    conversationId = existing.id;
  } else {
    const { data: created, error } = await sb
      .from('conversations')
      .insert({ client_id: currentUser.id })
      .select('id')
      .single();
    if (error) {
      alert('대화방 생성 실패: ' + error.message);
      return;
    }
    conversationId = created.id;
  }

  await loadMessages();
  subscribeMessages();
})();

async function loadMessages() {
  const { data, error } = await sb
    .from('messages')
    .select('*')
    .eq('conversation_id', conversationId)
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
  messagesChannel = sb.channel('msgs-' + conversationId)
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'messages',
      filter: `conversation_id=eq.${conversationId}`
    }, (payload) => {
      addMessage(payload.new);
      scrollToBottom();
    })
    .subscribe();
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
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
        conversation_id: conversationId,
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
        conversation_id: conversationId,
        sender_id: currentUser.id,
        body: null,
        image_url: imageUrl
      });
      if (error) console.error('이미지 메시지 실패:', error);
    }

    await sb.from('conversations')
      .update({ last_message_at: new Date().toISOString() })
      .eq('id', conversationId);
  } finally {
    setFormDisabled(false);
  }
});

function setFormDisabled(b) {
  form.querySelectorAll('button, input[type="file"]').forEach(el => el.disabled = b);
}

logoutBtn.addEventListener('click', async () => {
  if (messagesChannel) sb.removeChannel(messagesChannel);
  await sb.auth.signOut();
  window.location.href = 'index.html';
});
