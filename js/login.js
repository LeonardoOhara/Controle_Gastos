import { auth, signInWithEmailAndPassword, onAuthStateChanged } from "./firebase-config.js";

const loginForm = document.getElementById('login-form');
const loginError = document.getElementById('login-error');
const emailInput = document.getElementById('email');
const pwdInput = document.getElementById('pwd');

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginError.textContent = '';
  const email = emailInput.value.trim();
  const password = pwdInput.value;
  if (!email || !password) return;
  try {
    await signInWithEmailAndPassword(auth, email, password);
  } catch (err) {
    console.error('Erro no login:', err);
    loginError.textContent = (err.code === 'auth/wrong-password' || err.code === 'auth/user-not-found' || err.code === 'auth/invalid-credential')
      ? 'E-mail ou senha incorretos.'
      : 'Erro ao entrar: ' + (err.message || err.code);
    pwdInput.value = '';
  }
});

onAuthStateChanged(auth, (user) => {
  if (user) {
    window.location.href = 'app.html';
  }
});
