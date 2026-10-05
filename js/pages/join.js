// QR landing page: join.html?code=K7M2QX
// Signed in → the dashboard joins the class. Not signed in → keep the code,
// sign in, and the dashboard joins it afterwards.
import { getSession } from '../supabase.js';
import { storage } from '../ui.js';
import { PENDING_JOIN_KEY, normalizeJoinCode } from '../join-code.js';

const code = normalizeJoinCode(new URLSearchParams(window.location.search).get('code'));

async function start() {
  if (!code) {
    window.location.replace('dashboard.html');
    return;
  }

  let session = null;
  try {
    session = await getSession();
  } catch {
    // Treat as signed out.
  }

  if (session) {
    window.location.replace(`dashboard.html?join=${encodeURIComponent(code)}`);
  } else {
    storage.set(PENDING_JOIN_KEY, code);
    window.location.replace('index.html');
  }
}

start();
