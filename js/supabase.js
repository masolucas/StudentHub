// Supabase client and auth helpers shared by every page.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_KEY, SCHOOL_DOMAIN } from './config.js';

export const db = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    flowType: 'pkce',
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});

// Pages live side by side, so relative URLs work on localhost and on GitHub Pages.
const pageUrl = (page) => new URL(page, window.location.href).href;

export async function getSession() {
  const { data, error } = await db.auth.getSession();
  if (error) throw error;
  return data.session;
}

// For signed-in pages: send visitors without a session to the login page.
export async function requireSession() {
  const session = await getSession();
  if (!session) {
    window.location.replace(pageUrl('index.html'));
    return null;
  }
  return session;
}

export async function getProfile(userId) {
  const { data, error } = await db
    .from('profiles')
    .select('id, email, full_name, preferred_name, avatar_url, role, onboarded_at')
    .eq('id', userId)
    .single();
  if (error) throw error;
  return data;
}

export function displayName(profile) {
  return profile?.preferred_name || profile?.full_name || profile?.email || '';
}

// hd pre-selects school accounts in Google's picker. It is a convenience,
// not security: the database rejects every other domain.
export function signInWithGoogle() {
  return db.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: pageUrl('index.html'),
      queryParams: { hd: SCHOOL_DOMAIN, prompt: 'select_account' },
    },
  });
}

export async function signOut() {
  await db.auth.signOut();
  window.location.replace(pageUrl('index.html'));
}

// One dashboard for every role; the dashboard decides what to show.
export function goToDashboard() {
  window.location.replace(pageUrl('dashboard.html'));
}

// Supabase sends errors back in the query string or the hash.
// Returns { wrongAccount, description } or null, and cleans the URL.
export function readAuthError() {
  const params = new URLSearchParams(window.location.search);
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const error = params.get('error') || hash.get('error');
  if (!error) return null;

  const description = params.get('error_description') || hash.get('error_description') || '';
  window.history.replaceState(null, '', window.location.pathname);

  // The signup trigger rejects non-school accounts; Supabase reports it as this message.
  const wrongAccount = /database error saving new user/i.test(description);
  return { wrongAccount, description };
}
