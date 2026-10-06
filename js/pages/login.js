// Login page: one Google button for everyone. The database decides the role.
// Phones install Folio first (on iPhone the installed app and Safari keep
// separate sign-ins, so signing in inside Safari would not carry over).
import { getSession, signInWithGoogle, goToDashboard, readAuthError } from '../supabase.js';
import { registerServiceWorker } from '../pwa.js';
import { storage, showToast } from '../ui.js';
import { PENDING_JOIN_KEY } from '../join-code.js';
import { isIOS, isInAppBrowser, shouldInstallFirst, installBrowserNeeded } from '../device.js';

registerServiceWorker();

const $ = (id) => document.getElementById(id);
const USE_BROWSER_KEY = 'folio.useBrowser';

// Android/Chrome offers its own install prompt when Folio is installable.
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  installPrompt = event;
  $('installBtn').hidden = false;
  $('installAndroidSteps').hidden = true;
});
window.addEventListener('appinstalled', () => {
  $('installAndroid').hidden = true;
  $('installedNotice').hidden = false;
});

function showSignIn(authError) {
  $('signInArea').hidden = false;
  $('useBrowserBtn').hidden = true;
  if (authError?.wrongAccount) $('wrongAccount').hidden = false;
  else if (authError) $('signInError').hidden = false;
  if (storage.get(PENDING_JOIN_KEY)) $('joinNotice').hidden = false;
  $('signInLabel').textContent = authError ? 'Try again with Google' : 'Sign in with Google';
}

// Phones that haven't installed Folio see the right install steps instead.
function showInstallSteps() {
  const browser = installBrowserNeeded();
  if (isInAppBrowser) {
    $('inAppNotice').hidden = false;
  } else if (browser) {
    document.querySelectorAll('[data-browser-name]').forEach((el) => { el.textContent = browser; });
    $('openInBrowser').hidden = false;
  } else if (isIOS) {
    $('installIOS').hidden = false;
  } else {
    $('installAndroid').hidden = false;
  }
  $('useBrowserBtn').hidden = false;
}

async function start() {
  const authError = readAuthError();

  try {
    if (await getSession()) {
      goToDashboard();
      return;
    }
  } catch {
    $('signInError').hidden = false;
  }

  $('loading').hidden = true;
  // A sign-in error means we're already past installing (e.g. a wrong account).
  if (shouldInstallFirst() && !authError && !storage.get(USE_BROWSER_KEY)) showInstallSteps();
  else showSignIn(authError);
}

$('signInBtn').addEventListener('click', async () => {
  $('signInBtn').disabled = true;
  $('signInLabel').textContent = 'Opening Google…';
  $('wrongAccount').hidden = true;
  $('signInError').hidden = true;

  const { error } = await signInWithGoogle();
  if (error) {
    $('signInError').hidden = false;
    $('signInBtn').disabled = false;
    $('signInLabel').textContent = 'Try again with Google';
  }
});

$('installBtn').addEventListener('click', async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  const { outcome } = await installPrompt.userChoice;
  installPrompt = null;
  if (outcome !== 'accepted') {
    $('installBtn').hidden = true;
    $('installAndroidSteps').hidden = false;
  }
});

// Teachers and laptop users can skip installing.
$('useBrowserBtn').addEventListener('click', () => {
  storage.set(USE_BROWSER_KEY, '1');
  ['installIOS', 'installAndroid', 'openInBrowser', 'inAppNotice'].forEach((id) => { $(id).hidden = true; });
  showSignIn(null);
});

document.querySelectorAll('[data-copy-link]').forEach((button) => {
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      showToast('Link copied. Now paste it in your browser.', 'success', 5000);
    } catch {
      showToast(window.location.href, 'info', 8000);
    }
  });
});

start();
