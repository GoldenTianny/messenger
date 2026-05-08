let currentUser = null;
let conversations = [];
let activeConversationId = null;
let messagesChannel = null;
let conversationsChannel = null;
let allMessagesChannel = null;
let selectedFiles = [];

const conversationsListEl = document.getElementById('conversations-list');
const messagesEl = document.getElementById('messages');
const form = document.getElementById('chat-form');
const textInput = document.getElementById('text-input');
const imageInput = document.getElementById('image-input');
const headerName = document.getElementById('chat-header-name');
const logoutBtn = document.getElementById('logout-btn');
const backBtn = document.getElementById('back-btn');
const emptyStateEl = document.getElementById('empty-state');
const imagePreview = document.getElementById('image-preview');
const inviteBtn = document.getElementById('invite-btn');
const inviteModal = document.getElementById('invite-modal');
const inviteModalBackdrop = document.getElementById('invite-modal-backdrop');
const inviteLinkInput = document.getElementById('invite-link');
const copyInviteBtn = document.getElementById('copy-invite-btn');
const closeInviteModalBtn = document.getElementById('close-invite-modal');

(async function init() {
  currentUser = await getCurrentUser();
  if (!currentUser) {
    window.location.href = 'index.html' + window.location.search;
    return;
  }

  // URL에 초대 토큰이 있으면 처리
  const params = new URLSearchParams(window.location.search);
  const inviteToken = params.get('invite');
  if (inviteToken) {
    const convId = await redeemInvite(inviteToken);
    // URL 정리 (초대 토큰 제거)
    window.history.replaceState({}, '', window.location.pathname);
    await loadConversations();
    if (convId) await openConversation(convId);
  } else {
    await loadConversations();
  }

  subscribeConversations();
  subscribeAllMessages();
})();

async function redeemInvite(token) {
  const { data, error } = await sb.rpc('redeem_invitation', { invite_token: token });
  if (error) {
    alert('초대 사용 실패: ' + error.message);
    return null;
  }
  return data;
}

async function loadConversations() {
  // 내가 멤버인 대화방 목록
  const { data: myMemberships, error: memErr } = await sb
    .from('conversation_members')
    .select('conversation_id')
    .eq('user_id', currentUser.id);
  if (memErr) { console.error(memErr); return; }

  if (!myMemberships || myMemberships.length === 0) {
    conversations = [];
    renderConversations();
    return;
  }

  const convIds = myMemberships.map(m => m.conversation_id);

  const { data: convs, error: convErr } = await sb
    .from('conversations')
    .select('id, last_message_at, conversation_members(user_id, profiles(display_name))')
    .in('id', convIds)
    .order('last_message_at', { ascending: false });
  if (convErr) { console.error(convErr); return; }

  conversations = (convs || []).map(c => {
    const partner = (c.conversation_members || []).find(m => m.user_id !== currentUser.id);
    return {
      id: c.id,
      last_message_at: c.last_message_at,
      partner_name: partner?.profiles?.display_name || null,
      is_pending: !partner
    };
  });

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
    const displayName = c.is_pending ? '(상대방 대기 중)' : c.partner_name;
    item.innerHTML = `
      <div class="conv-name">${escapeHtml(displayName)}</div>
      <div class="conv-time">${formatRelative(c.last_message_at)}</div>
    `;
    item.addEventListener('click', () => openConversation(c.id));
    conversationsListEl.appendChild(item);
  });
}

async function openConversation(id) {
  activeConversationId = id;
  const conv = conversations.find(c => c.id === id);
  headerName.textContent = conv?.is_pending ? '(상대방 대기 중)' : (conv?.partner_name || '');
  document.body.classList.add('chat-open');
  if (emptyStateEl && emptyStateEl.parentNode) emptyStateEl.remove();
  renderConversations();
  await loadMessages();
  subscribeMessages();
}

backBtn.addEventListener('click', () => {
  document.body.classList.remove('chat-open');
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
  messagesChannel = sb.channel('msgs-' + activeConversationId)
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
  conversationsChannel = sb.channel('all-convs')
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'conversations'
    }, () => loadConversations())
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'conversation_members'
    }, () => loadConversations())
    .subscribe();
}

function subscribeAllMessages() {
  allMessagesChannel = sb.channel('all-msgs')
    .on('postgres_changes', {
      event: 'INSERT', schema: 'public', table: 'messages'
    }, () => loadConversations())
    .subscribe();
}

// === 사진 미리보기 ===
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

// === 메시지 전송 ===
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
  } finally {
    setFormDisabled(false);
  }
});

function setFormDisabled(b) {
  form.querySelectorAll('button, input[type="file"]').forEach(el => el.disabled = b);
}

// === 초대 링크 생성 ===
inviteBtn.addEventListener('click', async () => {
  inviteBtn.disabled = true;
  try {
    // 새 대화방 생성
    const { data: newConv, error: convErr } = await sb
      .from('conversations')
      .insert({})
      .select('id')
      .single();
    if (convErr) { alert('대화방 생성 실패: ' + convErr.message); return; }

    // 본인을 멤버로 추가
    const { error: memErr } = await sb
      .from('conversation_members')
      .insert({ conversation_id: newConv.id, user_id: currentUser.id });
    if (memErr) { alert('멤버 등록 실패: ' + memErr.message); return; }

    // 초대 토큰 생성
    const { data: inv, error: invErr } = await sb
      .from('invitations')
      .insert({ conversation_id: newConv.id, created_by: currentUser.id })
      .select('token')
      .single();
    if (invErr) { alert('초대 링크 생성 실패: ' + invErr.message); return; }

    // 링크 표시
    const baseUrl = window.location.origin + window.location.pathname.replace(/[^/]*$/, '');
    inviteLinkInput.value = `${baseUrl}?invite=${inv.token}`;
    inviteModal.hidden = false;

    await loadConversations();
  } finally {
    inviteBtn.disabled = false;
  }
});

copyInviteBtn.addEventListener('click', async () => {
  inviteLinkInput.select();
  try {
    await navigator.clipboard.writeText(inviteLinkInput.value);
    copyInviteBtn.textContent = '복사됨';
    setTimeout(() => { copyInviteBtn.textContent = '복사'; }, 2000);
  } catch (e) {
    document.execCommand('copy');
    copyInviteBtn.textContent = '복사됨';
    setTimeout(() => { copyInviteBtn.textContent = '복사'; }, 2000);
  }
});

closeInviteModalBtn.addEventListener('click', () => {
  inviteModal.hidden = true;
});
inviteModalBackdrop.addEventListener('click', () => {
  inviteModal.hidden = true;
});

// === 로그아웃 ===
logoutBtn.addEventListener('click', async () => {
  [messagesChannel, conversationsChannel, allMessagesChannel].forEach(ch => {
    if (ch) sb.removeChannel(ch);
  });
  await sb.auth.signOut();
  window.location.href = 'index.html';
});
