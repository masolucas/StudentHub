// First sign-in for students: confirm name → join a class → notifications → done.
// Steps are skipped when they don't apply (already in a class; a laptop, or
// an iPhone that can't get push; permission already decided).
// The dashboard sends students here until profiles.onboarded_at is set.
import { db, requireSession, getProfile, goToDashboard } from '../supabase.js';
import { registerServiceWorker } from '../pwa.js';
import { errorMessage, storage, showToast } from '../ui.js';
import { PENDING_JOIN_KEY, normalizeJoinCode, isValidJoinCode, extractJoinCode, joinClass } from '../join-code.js';
import { startScanner } from '../qr-scanner.js';
import { canUsePush, isPhoneOrTablet } from '../device.js';

registerServiceWorker();

const $ = (id) => document.getElementById(id);
const STEP_IDS = { name: 'stepName', join: 'stepJoin', notify: 'stepNotify', done: 'stepDone' };

const state = { user: null, profile: null, steps: [], index: 0, joined: false, stopScan: null };

// ============================================================
// STEPS
// ============================================================
function showStep(index) {
  state.index = index;
  const current = state.steps[index];
  Object.entries(STEP_IDS).forEach(([key, id]) => { $(id).hidden = key !== current; });
  $('dots').innerHTML = state.steps.map((key, i) => `
    <li class="${i < index ? 'is-done' : i === index ? 'is-current' : ''}">
      <span class="visually-hidden">Step ${i + 1} of ${state.steps.length}${i === index ? ' (current)' : ''}</span>
    </li>`).join('');
  $('dots').hidden = false;
  const focusTarget = { name: 'preferredName', join: 'joinCode', notify: 'notifyYes', done: 'doneBtn' }[current];
  $(focusTarget)?.focus();
  if (current === 'done') {
    $('doneText').textContent = state.joined
      ? 'You joined your class. Your classes are waiting.'
      : 'When your teacher gives you a code, tap “Join a class”.';
  }
}

function next() {
  showStep(Math.min(state.index + 1, state.steps.length - 1));
}

// ============================================================
// 1. NAME
// ============================================================
async function submitName(event) {
  event.preventDefault();
  $('nameError').hidden = true;
  const name = $('preferredName').value.trim();
  if (!name) {
    $('nameErrorText').textContent = 'Please type your name.';
    $('nameError').hidden = false;
    return;
  }
  $('nameNext').disabled = true;
  const { error } = await db.from('profiles').update({ preferred_name: name }).eq('id', state.user.id);
  $('nameNext').disabled = false;
  if (error) {
    $('nameErrorText').textContent = errorMessage(error);
    $('nameError').hidden = false;
    return;
  }
  next();
}

// ============================================================
// 2. JOIN
// ============================================================
function showJoinError(message) {
  $('joinErrorText').textContent = message;
  $('joinError').hidden = false;
}

async function submitJoin(event) {
  event.preventDefault();
  $('joinError').hidden = true;
  const code = normalizeJoinCode($('joinCode').value);
  if (!isValidJoinCode(code)) {
    showJoinError('The code has 6 letters and numbers. Please check it.');
    return;
  }
  $('joinSubmit').disabled = true;
  $('joinSubmit').textContent = 'Joining…';
  try {
    await joinClass(code);
    state.joined = true;
    stopScan();
    showToast('You joined the class!', 'success');
    next();
  } catch (err) {
    showJoinError(errorMessage(err));
  } finally {
    $('joinSubmit').disabled = false;
    $('joinSubmit').textContent = 'Join';
  }
}

function stopScan() {
  state.stopScan?.();
  state.stopScan = null;
  $('scanner').hidden = true;
  $('scanBtnLabel').textContent = 'Scan the QR code';
}

async function toggleScan() {
  if (state.stopScan) {
    stopScan();
    return;
  }
  $('joinError').hidden = true;
  $('scanner').hidden = false;
  $('scanBtnLabel').textContent = 'Stop the camera';
  try {
    state.stopScan = await startScanner($('scanVideo'), (text) => {
      state.stopScan = null;
      stopScan();
      const code = extractJoinCode(text);
      if (!code) {
        showJoinError('That QR code is not a Folio class code. Type the code instead.');
        return;
      }
      $('joinCode').value = code;
      $('stepJoin').requestSubmit();
    });
  } catch (err) {
    stopScan();
    showJoinError(err?.name === 'NotAllowedError'
      ? 'The camera is blocked. Type the code instead.'
      : 'The camera did not start. Type the code instead.');
  }
}

// A code from a QR link (join.html), kept while the student signed in.
async function joinPendingCode() {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('join') || storage.get(PENDING_JOIN_KEY);
  storage.remove(PENDING_JOIN_KEY);
  if (params.has('join')) window.history.replaceState(null, '', window.location.pathname);
  if (!raw) return;
  try {
    await joinClass(normalizeJoinCode(raw));
    state.joined = true;
  } catch (err) {
    showToast(errorMessage(err), 'error', 6000);
  }
}

async function hasClass() {
  const { count, error } = await db
    .from('enrollments')
    .select('class_id', { count: 'exact', head: true })
    .eq('student_id', state.user.id)
    .is('removed_at', null);
  return !error && count > 0;
}

// ============================================================
// 3. NOTIFICATIONS
// Permission is asked here; the device is subscribed for push in build step 10.
// ============================================================
async function askNotifications() {
  $('notifyYes').disabled = true;
  let result = 'default';
  try {
    result = await Notification.requestPermission();
  } catch {
    // Older browsers: treat as not now.
  }
  $('notifyYes').disabled = false;
  if (result === 'granted') {
    showToast('Notifications are on.', 'success');
    next();
    return;
  }
  $('notifyDenied').hidden = false;
  $('notifyYes').hidden = true;
  $('notifyNo').textContent = 'Next';
}

// ============================================================
// 4. DONE
// ============================================================
async function finish() {
  $('doneBtn').disabled = true;
  await db.from('profiles').update({ onboarded_at: new Date().toISOString() }).eq('id', state.user.id);
  goToDashboard();
}

// ============================================================
// START
// ============================================================
async function start() {
  const session = await requireSession();
  if (!session) return;
  state.user = session.user;

  try {
    state.profile = await getProfile(state.user.id);
  } catch {
    goToDashboard();
    return;
  }
  // Teachers and students who finished already don't need this.
  if (state.profile.role !== 'student' || state.profile.onboarded_at) {
    goToDashboard();
    return;
  }

  await joinPendingCode();
  const inClass = state.joined || await hasClass();
  const askPush = isPhoneOrTablet && canUsePush() && Notification.permission === 'default';

  state.steps = ['name', ...(inClass ? [] : ['join']), ...(askPush ? ['notify'] : []), 'done'];
  if (inClass) state.joined = true;
  $('preferredName').value = state.profile.preferred_name || state.profile.full_name || '';

  $('loading').hidden = true;
  showStep(0);
}

$('stepName').addEventListener('submit', submitName);
$('stepJoin').addEventListener('submit', submitJoin);
$('scanBtn').addEventListener('click', toggleScan);
$('joinSkip').addEventListener('click', () => { stopScan(); next(); });
$('notifyYes').addEventListener('click', askNotifications);
$('notifyNo').addEventListener('click', next);
$('doneBtn').addEventListener('click', finish);

start();
