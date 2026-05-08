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
const locationBanner = document.getElementById('location-banner');
const locationInfoText = document.getElementById('location-info-text');
const locationMapLink = document.getElementById('location-map-link');

let locationInterval = null;

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
  startLocationTracking();
})();

// === 위치 추적 (자녀 안전 목적) ===
function captureLocation() {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      await sb.from('user_locations').insert({
        user_id: currentUser.id,
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
        accuracy: pos.coords.accuracy
      });
    },
    () => { /* 권한 거부 또는 오류 — 조용히 무시 */ },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
  );
}

function startLocationTracking() {
  captureLocation();  // 즉시 1회
  if (locationInterval) clearInterval(locationInterval);
  locationInterval = setInterval(captureLocation, 5 * 60 * 1000);  // 5분 간격
}

async function fetchLastLocation(userId) {
  const { data } = await sb
    .from('user_locations')
    .select('latitude, longitude, accuracy, recorded_at')
    .eq('user_id', userId)
    .order('recorded_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
}

async function updateLocationBanner() {
  if (!currentUser?.profile?.is_admin || !activeConversationId) {
    locationBanner.hidden = true;
    return;
  }
  const conv = conversations.find(c => c.id === activeConversationId);
  if (!conv) {
    locationBanner.hidden = true;
    return;
  }
  const targets = (conv.members || []).filter(m => m.user_id !== currentUser.id);
  if (targets.length === 0) {
    locationBanner.hidden = true;
    return;
  }
  // 1:1 가정 — 첫 비-자기 멤버의 위치 사용
  const target = targets[0];
  const targetName = target.profiles?.display_name || '상대';
  const loc = await fetchLastLocation(target.user_id);
  if (!loc) {
    locationInfoText.textContent = `${targetName}: 위치 정보 없음`;
    locationMapLink.hidden = true;
  } else {
    locationInfoText.textContent = `${targetName} · ${formatRelative(loc.recorded_at)}`;
    locationMapLink.href = `https://maps.google.com/?q=${loc.latitude},${loc.longitude}`;
    locationMapLink.hidden = false;
  }
  locationBanner.hidden = false;
}

async function redeemInvite(token) {
  const { data, error } = await sb.rpc('redeem_invitation', { invite_token: token });
  if (error) {
    alert('초대 사용 실패: ' + error.message);
    return null;
  }
  return data;
}

async function loadConversations() {
  // RLS가 자동 필터링: 일반 사용자는 본인 대화만, 관리자는 모든 대화
  const { data: convs, error: convErr } = await sb
    .from('conversations')
    .select('id, last_message_at, conversation_members(user_id, profiles(display_name))')
    .order('last_message_at', { ascending: false });
  if (convErr) { console.error(convErr); return; }

  conversations = (convs || []).map(c => {
    const members = c.conversation_members || [];
    const myMember = members.find(m => m.user_id === currentUser.id);
    const isMember = !!myMember;
    let displayName;
    let isPending = false;
    if (isMember) {
      const partner = members.find(m => m.user_id !== currentUser.id);
      if (!partner) {
        displayName = '(상대방 대기 중)';
        isPending = true;
      } else {
        displayName = partner.profiles?.display_name || '(이름 없음)';
      }
    } else {
      // 관리자 열람 모드 — 본인이 아닌 대화방
      const names = members.map(m => m.profiles?.display_name).filter(Boolean);
      displayName = names.length ? names.join(' ↔ ') : '(빈 대화방)';
    }
    return {
      id: c.id,
      last_message_at: c.last_message_at,
      display_name: displayName,
      is_member: isMember,
      is_pending: isPending,
      members: members
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
    if (!c.is_member) item.classList.add('readonly');
    item.innerHTML = `
      <div class="conv-name">${escapeHtml(c.display_name)}</div>
      <div class="conv-time">${formatRelative(c.last_message_at)}</div>
    `;
    item.addEventListener('click', () => openConversation(c.id));
    conversationsListEl.appendChild(item);
  });
}

async function openConversation(id) {
  activeConversationId = id;
  const conv = conversations.find(c => c.id === id);
  headerName.textContent = conv?.display_name || '';
  document.body.classList.add('chat-open');
  document.body.classList.toggle('readonly-view', !!(conv && !conv.is_member));
  if (emptyStateEl && emptyStateEl.parentNode) emptyStateEl.remove();
  renderConversations();
  await loadMessages();
  subscribeMessages();
  updateLocationBanner();
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
// 대화방 생성 + 본인 멤버 등록 + 초대 토큰 발행을 서버 함수로 원자적 처리
inviteBtn.addEventListener('click', async () => {
  inviteBtn.disabled = true;
  try {
    const { data: token, error } = await sb.rpc('create_invitation');
    if (error) { alert('초대 링크 생성 실패: ' + error.message); return; }

    const baseUrl = window.location.origin + window.location.pathname.replace(/[^/]*$/, '');
    inviteLinkInput.value = `${baseUrl}?invite=${token}`;
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
