// Login page: one Google button for everyone. The database decides the role.
import { getSession, signInWithGoogle, goToDashboard, readAuthError } from '../supabase.js';
import { registerServiceWorker } from '../pwa.js';
import { storage } from '../ui.js';
import { PENDING_JOIN_KEY } from '../join-code.js';

registerServiceWorker();

const loading = document.getElementById('loading');
const signInBtn = document.getElementById('signInBtn');
const signInLabel = document.getElementById('signInLabel');
const wrongAccount = document.getElementById('wrongAccount');
const signInError = document.getElementById('signInError');
const inAppNotice = document.getElementById('inAppNotice');

// Instagram, Facebook, WhatsApp, Line, Snapchat and Android web views.
const IN_APP_BROWSER = /FBAN|FBAV|Instagram|WhatsApp|Line\/|Snapchat|; wv\)/i;

function showButton(label) {
  loading.hidden = true;
  signInLabel.textContent = label;
  signInBtn.disabled = false;
  signInBtn.hidden = false;
}

async function start() {
  const authError = readAuthError();

  try {
    const session = await getSession();
    if (session) {
      goToDashboard();
      return;
    }
  } catch {
    signInError.hidden = false;
  }

  if (authError) {
    if (authError.wrongAccount) wrongAccount.hidden = false;
    else signInError.hidden = false;
  }
  if (IN_APP_BROWSER.test(navigator.userAgent)) inAppNotice.hidden = false;
  if (storage.get(PENDING_JOIN_KEY)) document.getElementById('joinNotice').hidden = false;

  showButton(authError ? 'Try again with Google' : 'Sign in with Google');
}

signInBtn.addEventListener('click', async () => {
  signInBtn.disabled = true;
  signInLabel.textContent = 'Opening Google…';
  wrongAccount.hidden = true;
  signInError.hidden = true;

  const { error } = await signInWithGoogle();
  if (error) {
    signInError.hidden = false;
    showButton('Try again with Google');
  }
});

start();
