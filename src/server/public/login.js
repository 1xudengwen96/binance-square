const form = document.querySelector('#login-form');
const username = document.querySelector('#username');
const password = document.querySelector('#password');
const submit = document.querySelector('#submit-button');
const submitLabel = document.querySelector('#submit-label');
const error = document.querySelector('#login-error');
const toggle = document.querySelector('#password-toggle');

document.querySelector('#year').textContent = new Date().getFullYear();
// Return to the same workspace tab after a session expires.
const destination = '/' + location.hash;
fetch('/api/auth/session', { credentials: 'same-origin' })
  .then(response => { if (response.ok) location.replace(destination); })
  .catch(() => {});

toggle.addEventListener('click', () => {
  const visible = password.type === 'password';
  password.type = visible ? 'text' : 'password';
  toggle.setAttribute('aria-pressed', String(visible));
  toggle.setAttribute('aria-label', visible ? '隐藏密码' : '显示密码');
  password.focus();
});

const capsWarning = document.querySelector('#caps-warning');
for (const event of ['keydown', 'keyup']) {
  password.addEventListener(event, e => { capsWarning.hidden = !e.getModifierState('CapsLock'); });
}
password.addEventListener('blur', () => { capsWarning.hidden = true; });
const helpToggle = document.querySelector('#help-toggle');
helpToggle.addEventListener('click', () => {
  const help = document.querySelector('#login-help');
  help.hidden = !help.hidden;
  helpToggle.setAttribute('aria-expanded', String(!help.hidden));
});
for (const field of [username, password]) {
  field.addEventListener('input', () => {
    error.textContent = '';
    username.removeAttribute('aria-invalid');
    password.removeAttribute('aria-invalid');
  });
}
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (submit.disabled) return;
  error.textContent = '';
  submit.disabled = true;
  form.setAttribute('aria-busy', 'true');
  submitLabel.textContent = '正在验证';
  let authenticated = false;
  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-squareforge': 'ui' },
      body: JSON.stringify({ username: username.value, password: password.value, remember: document.querySelector('#remember').checked }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) {
        username.setAttribute('aria-invalid', 'true');
        password.setAttribute('aria-invalid', 'true');
        password.focus();
      }
      throw new Error(result.error || '登录暂时不可用，请稍后再试');
    }
    authenticated = true;
    password.value = '';
    submitLabel.textContent = '登录成功';
    location.replace(destination);
  } catch (cause) {
    error.textContent = cause instanceof TypeError ? '连接失败，请检查网络后重试' : cause.message;
  } finally {
    if (!authenticated) {
      submit.disabled = false;
      submitLabel.textContent = '登录工作台';
      form.removeAttribute('aria-busy');
    }
  }
});
