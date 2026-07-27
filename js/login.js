import { auth, signInWithEmailAndPassword, onAuthStateChanged } from "./firebase-config.js";

const loginForm = document.getElementById('login-form');
const loginError = document.getElementById('login-error');
const emailInput = document.getElementById('email');
const pwdInput = document.getElementById('pwd');
const loginBtn = document.getElementById('login-btn');
const togglePwd = document.getElementById('toggle-pwd');
const eyeOpen = togglePwd ? togglePwd.querySelector('.eye-open') : null;
const eyeClosed = togglePwd ? togglePwd.querySelector('.eye-closed') : null;

// ========== MOSTRAR / OCULTAR SENHA ==========
if (togglePwd){
  togglePwd.addEventListener('click', () => {
    const isHidden = pwdInput.type === 'password';
    pwdInput.type = isHidden ? 'text' : 'password';
    togglePwd.setAttribute('aria-pressed', String(isHidden));
    togglePwd.setAttribute('aria-label', isHidden ? 'Ocultar senha' : 'Mostrar senha');
    if (eyeOpen) eyeOpen.style.display = isHidden ? 'none' : '';
    if (eyeClosed) eyeClosed.style.display = isHidden ? '' : 'none';
    // Re-foca no input para UX (evita perder posição do cursor)
    pwdInput.focus({ preventScroll: true });
    try {
      const len = pwdInput.value.length;
      pwdInput.setSelectionRange(len, len);
    } catch (_) {}
  });
}

// ========== FLOATING LABELS (estado is-filled para inputs) ==========
for (const input of [emailInput, pwdInput]){
  const update = () => input.classList.toggle('is-filled', Boolean(input.value));
  input.addEventListener('input', update);
  input.addEventListener('change', update);
  input.addEventListener('blur', update);
  update();
}

// ========== REDIRECIONA AUTOMATICAMENTE SE JÁ ESTIVER LOGADO ==========
let alreadyRedirecting = false;
onAuthStateChanged(auth, (user) => {
  if (user && !alreadyRedirecting){
    alreadyRedirecting = true;
    // Feedback curto para o usuário visualizar o sucesso
    if (loginBtn){
      loginBtn.classList.add('loading');
      const label = loginBtn.querySelector('.btn-label');
      if (label) label.textContent = 'Entrando...';
    }
    window.setTimeout(() => { window.location.href = 'app.html'; }, 260);
  }
});

// ========== SUBMIT DO LOGIN (COM LOADING + TRATAMENTO DE ERRO) ==========
function setLoading(loading){
  if (!loginBtn) return;
  const label = loginBtn.querySelector('.btn-label');
  loginBtn.classList.toggle('loading', Boolean(loading));
  loginBtn.disabled = Boolean(loading);
  if (label){
    if (loading) label.textContent = 'Entrando...';
    else label.textContent = 'Entrar';
  }
}

function showError(msg){
  if (!loginError) return;
  loginError.textContent = msg || '';
  // Trigger de animação de shake: remove e recoloca o texto no próximo frame
  loginError.style.animation = 'none';
  void loginError.offsetWidth;
  loginError.style.animation = '';
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  showError('');

  const email = emailInput.value.trim();
  const password = pwdInput.value;

  if (!email || !password){
    showError('Preencha e-mail e senha para continuar.');
    return;
  }

  setLoading(true);
  try {
    await signInWithEmailAndPassword(auth, email, password);
    // onAuthStateChanged vai cuidar do redirecionamento
  } catch (err) {
    console.error('Erro no login:', err);
    setLoading(false);

    let msg;
    const code = err && err.code ? String(err.code) : '';
    switch (code){
      case 'auth/invalid-email':
        msg = 'Formato de e-mail inválido.';
        break;
      case 'auth/user-disabled':
        msg = 'Esta conta está desativada. Entre em contato com o suporte.';
        break;
      case 'auth/user-not-found':
      case 'auth/wrong-password':
      case 'auth/invalid-credential':
      case 'auth/invalid-login-credentials':
        msg = 'E-mail ou senha incorretos.';
        break;
      case 'auth/operation-not-allowed':
        msg = 'Login com e-mail/senha não habilitado no Firebase Console.';
        break;
      case 'auth/network-request-failed':
        msg = 'Falha de conexão. Verifique sua internet e tente novamente.';
        break;
      case 'auth/too-many-requests':
        msg = 'Muitas tentativas. Aguarde alguns instantes ou recupere sua senha.';
        break;
      default:
        msg = 'Erro ao entrar: ' + (err && err.message ? err.message : code || 'desconhecido');
    }
    showError(msg);
    pwdInput.value = '';
    pwdInput.focus({ preventScroll: true });
  }
});

// ========== TWEAK DE UX: Ctrl/Cmd + Enter submete, Tab visual dos labels ==========
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && (e.key === 'Enter' || e.keyCode === 13)){
    if (document.activeElement === emailInput || document.activeElement === pwdInput){
      loginForm.requestSubmit();
    }
  }
});
