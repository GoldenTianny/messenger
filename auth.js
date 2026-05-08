const form = document.getElementById('auth-form');
const nameField = document.getElementById('name-field');
const submitBtn = document.getElementById('submit-btn');
const title = document.getElementById('auth-title');
const toggleText = document.getElementById('toggle-text');
const toggleLink = document.getElementById('toggle-link');
const errorMsg = document.getElementById('error-msg');
const emailInput = document.getElementById('email');
const passwordInput = document.getElementById('password');
const nameInput = document.getElementById('display-name');

let isSignup = false;

(async () => {
  const user = await getCurrentUser();
  if (user) {
    window.location.href = 'app.html' + window.location.search;
  }
})();

toggleLink.addEventListener('click', (e) => {
  e.preventDefault();
  isSignup = !isSignup;
  errorMsg.textContent = '';
  errorMsg.className = 'error';
  if (isSignup) {
    title.textContent = '회원가입';
    submitBtn.textContent = '회원가입';
    nameField.style.display = '';
    nameInput.required = true;
    toggleText.textContent = '이미 계정이 있으신가요?';
    toggleLink.textContent = '로그인';
    passwordInput.autocomplete = 'new-password';
  } else {
    title.textContent = '로그인';
    submitBtn.textContent = '로그인';
    nameField.style.display = 'none';
    nameInput.required = false;
    toggleText.textContent = '계정이 없으신가요?';
    toggleLink.textContent = '회원가입';
    passwordInput.autocomplete = 'current-password';
  }
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorMsg.textContent = '';
  errorMsg.className = 'error';
  submitBtn.disabled = true;

  const email = emailInput.value.trim();
  const password = passwordInput.value;

  try {
    if (isSignup) {
      const display_name = nameInput.value.trim();
      if (!display_name) throw new Error('닉네임을 입력해주세요.');

      const { data, error } = await sb.auth.signUp({
        email,
        password,
        options: { data: { display_name } }
      });
      if (error) throw error;

      if (data.user && !data.session) {
        errorMsg.textContent = '가입 완료. 이메일에서 인증 링크를 클릭한 뒤 로그인해주세요.';
        errorMsg.classList.add('info');
      } else if (data.session) {
        await routeUser();
      }
    } else {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
      await routeUser();
    }
  } catch (err) {
    errorMsg.textContent = err.message || '오류가 발생했습니다.';
  } finally {
    submitBtn.disabled = false;
  }
});

async function routeUser() {
  const user = await getCurrentUser();
  if (!user) return;
  window.location.href = 'app.html' + window.location.search;
}
