let currentUser = null;
let conversationId = null;
let messagesChannel = null;

const messagesEl = document.getElementById('messages');
const form = document.getElementById('chat-form');
const textInput = document.getElementById('text-input');
const imageInput = document.getElementById('image-input');
const logoutBtn = document.getElementById('logout-btn');
const imagePreview = document.getElementById('image-preview');
const previewImg = document.getElementById('preview-img');
const previewClear = document.getElementById('preview-clear');

function clearPreview() {
  imageInput.value = '';
  if (previewImg.src && previewImg.src.startsWith('blob:')) {
    URL.revokeObjectURL(previewImg.src);
  }
  previewImg.removeAttribute('src');
  imagePreview.hidden = true;
}

imageInput.addEventListener('change', () => {
  const file = imageInput.files[0];
  if (file) {
    if (previewImg.src && previewImg.src.startsWith('blob:')) {
      URL.revokeObjectURL(previewImg.src);
    }
    previewImg.src = URL.createObjectURL(file);
    imagePreview.hidden = false;
  }
});

previewClear.addEventListener('click', clearPreview);

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
  const file = imageInput.files[0];
  if (!text && !file) return;

  textInput.value = '';
  textInput.focus();

  let imageUrl = null;
  if (file) {
    setFormDisabled(true);
    imageUrl = await uploadImage(file, currentUser.id);
    clearPreview();
    setFormDisabled(false);
    if (!imageUrl) return;
  }

  const { error } = await sb.from('messages').insert({
    conversation_id: conversationId,
    sender_id: currentUser.id,
    body: text || null,
    image_url: imageUrl
  });
  if (error) {
    alert('전송 실패: ' + error.message);
    return;
  }

  await sb.from('conversations')
    .update({ last_message_at: new Date().toISOString() })
    .eq('id', conversationId);
});

function setFormDisabled(b) {
  form.querySelectorAll('button, input').forEach(el => el.disabled = b);
}

logoutBtn.addEventListener('click', async () => {
  if (messagesChannel) sb.removeChannel(messagesChannel);
  await sb.auth.signOut();
  window.location.href = 'index.html';
});
