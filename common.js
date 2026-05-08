// 모든 페이지에서 공통으로 사용하는 함수와 supabase 클라이언트
// (window.supabase 는 CDN SDK 네임스페이스 — 충돌 피하려고 클라이언트는 sb 로 명명)
const sb = window.supabase.createClient(
  window.SUPABASE_CONFIG.url,
  window.SUPABASE_CONFIG.anonKey
);

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
}

function formatRelative(iso) {
  const d = new Date(iso);
  const diffMin = Math.floor((Date.now() - d.getTime()) / 60000);
  if (diffMin < 1) return '방금';
  if (diffMin < 60) return diffMin + '분 전';
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return diffH + '시간 전';
  return d.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' });
}

function escapeHtml(s) {
  if (!s) return '';
  return s.replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));
}

async function resizeImage(file, maxSize = 1600, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const objUrl = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(objUrl);
      let { width, height } = img;
      if (width > maxSize || height > maxSize) {
        const ratio = Math.min(maxSize / width, maxSize / height);
        width = Math.round(width * ratio);
        height = Math.round(height * ratio);
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      canvas.toBlob(
        blob => blob ? resolve(blob) : reject(new Error('이미지 변환 실패')),
        'image/jpeg', quality
      );
    };
    img.onerror = (e) => { URL.revokeObjectURL(objUrl); reject(e); };
    img.src = objUrl;
  });
}

async function uploadImage(file, userId) {
  let blob;
  try {
    blob = await resizeImage(file);
  } catch (e) {
    alert('이미지 처리 실패: ' + (e.message || e));
    return null;
  }
  const rand = Math.random().toString(36).slice(2, 10);
  const path = `${userId}/${Date.now()}-${rand}.jpg`;
  const { error } = await sb.storage
    .from('chat-images')
    .upload(path, blob, { contentType: 'image/jpeg' });
  if (error) {
    alert('업로드 실패: ' + error.message);
    return null;
  }
  const { data } = sb.storage.from('chat-images').getPublicUrl(path);
  return data.publicUrl;
}

async function getCurrentUser() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return null;
  const { data: profile, error } = await sb
    .from('profiles')
    .select('*')
    .eq('id', session.user.id)
    .single();
  if (error || !profile) return null;
  return { id: session.user.id, email: session.user.email, profile };
}

async function requireAuth() {
  const user = await getCurrentUser();
  if (!user) {
    window.location.href = 'index.html' + window.location.search;
    return null;
  }
  return user;
}
