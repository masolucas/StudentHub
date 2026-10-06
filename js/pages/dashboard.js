// Dashboard for every role: the selected term's classes as a weekly calendar.
// Teachers: create classes, show join codes. Students: join classes.
import { db, requireSession, getProfile } from '../supabase.js';
import { registerServiceWorker } from '../pwa.js';
import { renderNavbar } from '../nav.js';
import { esc, errorMessage, storage, showToast, openModal, closeModal } from '../ui.js';
import { renderCalendar, updateNowLine } from '../calendar.js';
import { DAYS, toMinutes, toTimeString, formatTime, formatRange, durationLabel, timeOptions } from '../time.js';
import { PENDING_JOIN_KEY, normalizeJoinCode, isValidJoinCode, extractJoinCode, joinUrl } from '../join-code.js';
import { qrSvg } from '../qr.js';
import { startScanner } from '../qr-scanner.js';
import { swatchesHtml, checkSwatch, checkedSwatch, nextFreeColor } from '../palette.js';
import { shouldInstallFirst, installBrowserNeeded } from '../device.js';

const INSTALL_REMINDER_KEY = 'folio.installReminderHidden';

// Students signed in on a phone browser: suggest installing (in the right browser).
function showInstallReminder() {
  if (!shouldInstallFirst() || storage.get(INSTALL_REMINDER_KEY)) return;
  const browser = installBrowserNeeded();
  if (browser) $('installReminderText').textContent = `Open Folio in ${browser} to install it. You’ll get notifications, and it opens faster.`;
  $('installReminder').hidden = false;
}

registerServiceWorker();

const TERM_KEY = 'folio.term';
const STATUS_LABELS = { upcoming: 'Upcoming', active: 'Current term', closed: 'Closed' };

const $ = (id) => document.getElementById(id);

const state = {
  user: null,
  profile: null,
  isTeacher: false,
  terms: [],
  termId: null,
  classes: [],
  ghost: null,         // preview card while the create form is open
  codeClassId: null,   // class shown in the code view
  stopScan: null,      // stops the camera
};

// ============================================================
// START
// ============================================================
async function start() {
  const session = await requireSession();
  if (!session) return;
  state.user = session.user;

  try {
    state.profile = await getProfile(state.user.id);
    // First sign-in: students confirm their name, join, and set up notifications.
    if (state.profile.role === 'student' && !state.profile.onboarded_at) {
      window.location.replace(`welcome.html${window.location.search}`);
      return;
    }
    state.isTeacher = ['teacher', 'academic'].includes(state.profile.role);
    if (!state.isTeacher) showInstallReminder();
    renderNavbar($('navbar'), state.profile, 'dashboard');
    $('newClassBtn').hidden = !state.isTeacher;
    $('joinBtn').hidden = state.isTeacher;

    await joinPendingCode();
    await loadTerms();
    await loadClasses();
  } catch (err) {
    showPageError(errorMessage(err));
  }

  $('loading').hidden = true;
  $('page').hidden = false;
  setInterval(() => updateNowLine($('calendar')), 60_000);
}

function showPageError(message) {
  $('pageErrorText').textContent = ` ${message}`;
  $('pageError').hidden = false;
}

// ============================================================
// TERMS
// Teachers see every term. Students see terms where they have a class,
// plus the active term.
// ============================================================
async function loadTerms() {
  const { data: terms, error } = await db
    .from('terms')
    .select('id, name, start_date, end_date, status')
    .order('start_date', { ascending: false });
  if (error) throw error;

  let list = terms;
  if (!state.isTeacher) {
    const { data: rows, error: enrollError } = await db
      .from('enrollments')
      .select('classes!inner(term_id)')
      .eq('student_id', state.user.id)
      .is('removed_at', null);
    if (enrollError) throw enrollError;
    const mine = new Set(rows.map((r) => r.classes.term_id));
    list = terms.filter((t) => mine.has(t.id) || t.status === 'active');
  }
  state.terms = list;

  const saved = storage.get(TERM_KEY);
  const pick = list.find((t) => t.id === state.termId)
    || list.find((t) => t.id === saved)
    || list.find((t) => t.status === 'active')
    || list[0];
  state.termId = pick?.id ?? null;
  renderTermPicker();
}

function currentTerm() {
  return state.terms.find((t) => t.id === state.termId) ?? null;
}

function renderTermPicker() {
  const term = currentTerm();
  $('termEyebrow').textContent = term ? `${term.name} · ${STATUS_LABELS[term.status]}` : '';

  const select = $('termSelect');
  select.innerHTML = state.terms
    .map((t) => `<option value="${esc(t.id)}">${esc(t.name)}${t.status === 'active' ? '' : ` (${STATUS_LABELS[t.status]})`}</option>`)
    .join('');
  select.value = state.termId ?? '';
  $('termSelectWrap').hidden = state.terms.length < 2;

  const noTerms = !state.terms.length && state.isTeacher;
  $('noTerms').hidden = !noTerms;
  $('noTermsText').textContent = state.profile.role === 'academic'
    ? ' Create the first term to start adding classes. (The Terms screen comes in the next build step.)'
    : ' An academic account needs to create a term before you can add classes.';
  $('newClassBtn').disabled = noTerms;
}

async function changeTerm(termId) {
  state.termId = termId;
  storage.set(TERM_KEY, termId);
  renderTermPicker();
  try {
    await loadClasses();
  } catch (err) {
    showToast(errorMessage(err), 'error');
  }
}

// ============================================================
// CLASSES
// ============================================================
const baseClass = (c) => ({
  id: c.id,
  name: c.name,
  dow: c.day_of_week,
  start: toMinutes(c.start_time),
  end: toMinutes(c.end_time),
  color: c.color,
});

async function loadClasses() {
  if (!state.termId) {
    state.classes = [];
  } else {
    state.classes = state.isTeacher ? await loadTeacherClasses() : await loadStudentClasses();
  }
  render();
}

// Classes I teach (academics see every class in the database, but the
// dashboard shows only their own so cards never overlap).
async function loadTeacherClasses() {
  const { data, error } = await db
    .from('classes')
    .select('id, name, day_of_week, start_time, end_time, color, class_teachers!inner(teacher_id)')
    .eq('term_id', state.termId)
    .eq('class_teachers.teacher_id', state.user.id);
  if (error) throw error;

  const counts = {};
  const ids = data.map((c) => c.id);
  if (ids.length) {
    const { data: rows, error: countError } = await db
      .from('enrollments')
      .select('class_id')
      .in('class_id', ids)
      .is('removed_at', null);
    if (countError) throw countError;
    rows.forEach((r) => { counts[r.class_id] = (counts[r.class_id] || 0) + 1; });
  }
  return data.map((c) => ({ ...baseClass(c), students: counts[c.id] || 0 }));
}

async function loadStudentClasses() {
  const { data, error } = await db
    .from('enrollments')
    .select('classes!inner(id, name, day_of_week, start_time, end_time, color, term_id, class_teachers(role, profiles(full_name, preferred_name)))')
    .eq('student_id', state.user.id)
    .is('removed_at', null)
    .eq('classes.term_id', state.termId);
  if (error) throw error;

  const classes = data.map((r) => r.classes);
  const ids = classes.map((c) => c.id);
  const [due, feedback] = await Promise.all([dueCounts(ids), feedbackCounts(ids)]);

  return classes.map((c) => {
    const owner = c.class_teachers.find((t) => t.role === 'owner') ?? c.class_teachers[0];
    const teacher = owner?.profiles ? (owner.profiles.preferred_name || owner.profiles.full_name) : '';
    return { ...baseClass(c), teacher, due: due[c.id] || 0, feedback: feedback[c.id] || 0 };
  });
}

// Open assignments not turned in yet. Badges are a bonus: errors just hide them.
async function dueCounts(classIds) {
  if (!classIds.length) return {};
  const { data: assignments, error } = await db
    .from('assignments')
    .select('id, class_id')
    .in('class_id', classIds)
    .gt('due_at', new Date().toISOString());
  if (error || !assignments.length) return {};

  const { data: done } = await db
    .from('submissions')
    .select('assignment_id')
    .eq('student_id', state.user.id)
    .eq('status', 'submitted')
    .in('assignment_id', assignments.map((a) => a.id));
  const turnedIn = new Set((done ?? []).map((s) => s.assignment_id));

  const counts = {};
  assignments.forEach((a) => {
    if (!turnedIn.has(a.id)) counts[a.class_id] = (counts[a.class_id] || 0) + 1;
  });
  return counts;
}

async function feedbackCounts(classIds) {
  if (!classIds.length) return {};
  const { data, error } = await db
    .from('notifications')
    .select('class_id')
    .eq('type', 'work_returned')
    .is('read_at', null)
    .in('class_id', classIds);
  if (error) return {};
  const counts = {};
  data.forEach((n) => { counts[n.class_id] = (counts[n.class_id] || 0) + 1; });
  return counts;
}

function render() {
  const hasClasses = state.classes.length > 0;
  renderCalendar($('calendar'), state.classes, {
    role: state.isTeacher ? 'teacher' : 'student',
    ghost: state.ghost,
  });
  $('emptyTeacher').hidden = !(state.isTeacher && state.termId && !hasClasses && !state.ghost);
  $('emptyStudent').hidden = state.isTeacher || hasClasses;
}

// ============================================================
// CREATE CLASS (teachers)
// The calendar stays visible and shows a dashed preview card.
// ============================================================
function fillCreateSelects() {
  $('classDay').innerHTML = [1, 2, 3, 4, 5, 6]
    .map((d) => `<option value="${d}">${DAYS[d]}</option>`).join('');
  const times = timeOptions().map((t) => `<option value="${t}">${formatTime(t)}</option>`).join('');
  $('classStart').innerHTML = times;
  $('classEnd').innerHTML = times;
  $('classColors').innerHTML = swatchesHtml('classColor');
}

function openCreate() {
  const openTerms = state.terms.filter((t) => t.status !== 'closed');
  if (!openTerms.length) {
    showToast('There is no open term yet.', 'error');
    return;
  }

  $('classTerm').innerHTML = openTerms
    .map((t) => `<option value="${esc(t.id)}">${esc(t.name)}${t.status === 'upcoming' ? ' (Upcoming)' : ''}</option>`)
    .join('');
  const defaultTerm = openTerms.find((t) => t.id === state.termId)
    ?? openTerms.find((t) => t.status === 'active')
    ?? openTerms[0];

  $('createForm').reset();
  $('classTerm').value = defaultTerm.id;
  $('classDay').value = '1';
  $('classStart').value = String(9 * 60);
  $('classEnd').value = String(13 * 60);
  checkSwatch($('classColors'), nextFreeColor(state.classes.map((c) => c.color)));
  $('createError').hidden = true;

  openModal($('createOverlay'), {
    bodyClass: 'panel-open',
    onClose: () => { state.ghost = null; render(); },
  });

  if (defaultTerm.id !== state.termId) changeTerm(defaultTerm.id).then(updatePreview);
  else updatePreview();
}

function readCreateForm() {
  return {
    termId: $('classTerm').value,
    name: $('className').value.trim(),
    dow: Number($('classDay').value),
    start: Number($('classStart').value),
    end: Number($('classEnd').value),
    color: checkedSwatch($('classColors')),
    hasLibrary: $('classLibrary').checked,
  };
}

// A teacher never has two classes at the same time.
function findConflict(form) {
  return state.classes.find((c) => c.dow === form.dow && form.start < c.end && c.start < form.end);
}

function updatePreview() {
  const form = readCreateForm();
  const valid = form.end > form.start;
  $('ghostSummary').textContent = valid
    ? `${DAYS[form.dow]}s · ${formatRange(form.start, form.end)} · ${durationLabel(form.end - form.start)}`
    : 'The end time must be after the start time.';
  state.ghost = valid
    ? { name: form.name || 'New class', dow: form.dow, start: form.start, end: form.end, color: form.color }
    : null;
  render();
}

function showCreateError(message) {
  $('createErrorText').textContent = message;
  $('createError').hidden = false;
}

async function submitCreate(event) {
  event.preventDefault();
  const form = readCreateForm();
  $('createError').hidden = true;

  const conflict = findConflict(form);
  if (!form.name) return showCreateError('Please type a class name.');
  if (form.end <= form.start) return showCreateError('The end time must be after the start time.');
  if (conflict) return showCreateError(`You already teach ${conflict.name} at that time.`);

  const button = $('createSubmit');
  button.disabled = true;
  button.textContent = 'Creating…';

  const { data: classId, error } = await db.rpc('create_class', {
    p_term_id: form.termId,
    p_name: form.name,
    p_day_of_week: form.dow,
    p_start_time: toTimeString(form.start),
    p_end_time: toTimeString(form.end),
    p_color: form.color,
    p_has_library: form.hasLibrary,
  });

  button.disabled = false;
  button.textContent = 'Create class';
  if (error) return showCreateError(errorMessage(error));

  closeModal($('createOverlay'));
  showToast('Class created.', 'success');
  try {
    await loadClasses();
  } catch (err) {
    showToast(errorMessage(err), 'error');
  }
  showCode(classId);
}

// ============================================================
// SHOW CODE (teachers) — big code, QR, copy, new code
// ============================================================
async function showCode(classId) {
  const { data, error } = await db
    .from('class_join_codes')
    .select('code')
    .eq('class_id', classId)
    .single();
  if (error) {
    showToast(errorMessage(error), 'error');
    return;
  }

  state.codeClassId = classId;
  $('codeClassName').textContent = state.classes.find((c) => c.id === classId)?.name ?? '';
  $('onboardingLink').href = `onboarding.html?class=${encodeURIComponent(classId)}`;
  await renderCode(data.code);
  openModal($('codeOverlay'), { onClose: () => { state.codeClassId = null; } });
}

async function renderCode(code) {
  const url = joinUrl(code);
  $('codeValue').textContent = code;
  $('codeLink').textContent = url;
  try {
    $('codeQr').innerHTML = await qrSvg(url, 'QR code to join this class');
  } catch {
    $('codeQr').textContent = 'The QR code could not load.';
  }
}

async function copyText(text, message) {
  try {
    await navigator.clipboard.writeText(text);
    showToast(message, 'success');
  } catch {
    showToast('Could not copy. Select the text and copy it instead.', 'error');
  }
}

async function newCode() {
  if (!state.codeClassId) return;
  if (!window.confirm('Make a new code? The old code and QR will stop working.')) return;
  const { data: code, error } = await db.rpc('regenerate_join_code', { p_class: state.codeClassId });
  if (error) {
    showToast(errorMessage(error), 'error');
    return;
  }
  await renderCode(code);
  showToast('New code ready.', 'success');
}

// ============================================================
// JOIN (students) — typed code, in-app scanner, or a QR link
// ============================================================
function openJoin() {
  $('joinForm').reset();
  $('joinError').hidden = true;
  openModal($('joinOverlay'), { onClose: stopScan });
}

function showJoinError(message) {
  $('joinErrorText').textContent = message;
  $('joinError').hidden = false;
}

async function joinWithCode(code) {
  const { data: classId, error } = await db.rpc('join_class', { p_code: code });
  if (error) throw error;
  return classId;
}

// Joining always happens in the active term, so show that term afterwards.
async function afterJoin() {
  state.termId = state.terms.find((t) => t.status === 'active')?.id ?? null;
  showToast('You joined the class!', 'success');
  await loadTerms();
  await loadClasses();
}

async function submitJoin(event) {
  event.preventDefault();
  $('joinError').hidden = true;
  const code = normalizeJoinCode($('joinCode').value);
  if (!isValidJoinCode(code)) {
    showJoinError('The code has 6 letters and numbers. Please check it.');
    return;
  }

  const button = $('joinSubmit');
  button.disabled = true;
  button.textContent = 'Joining…';
  try {
    await joinWithCode(code);
    closeModal($('joinOverlay'));
    await afterJoin();
  } catch (err) {
    showJoinError(errorMessage(err));
  } finally {
    button.disabled = false;
    button.textContent = 'Join';
  }
}

function resetScanUI() {
  $('scanner').hidden = true;
  $('scanBtnLabel').textContent = 'Scan the QR code';
}

function stopScan() {
  state.stopScan?.();
  state.stopScan = null;
  resetScanUI();
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
      resetScanUI();
      const code = extractJoinCode(text);
      if (!code) {
        showJoinError('That QR code is not a Folio class code.');
        return;
      }
      $('joinCode').value = code;
      $('joinForm').requestSubmit();
    });
  } catch (err) {
    stopScan();
    showJoinError(err?.name === 'NotAllowedError'
      ? 'The camera is blocked. Type the code instead.'
      : 'The camera did not start. Type the code instead.');
  }
}

// A code from a QR link (join.html): in the URL if already signed in,
// or saved in storage while the student signed in.
async function joinPendingCode() {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('join') || storage.get(PENDING_JOIN_KEY);
  storage.remove(PENDING_JOIN_KEY);
  if (params.has('join')) window.history.replaceState(null, '', window.location.pathname);
  if (!raw) return;

  if (state.isTeacher) {
    showToast('Only student accounts can join classes.', 'error', 6000);
    return;
  }
  try {
    await joinWithCode(normalizeJoinCode(raw));
    showToast('You joined the class!', 'success');
  } catch (err) {
    showToast(errorMessage(err), 'error', 6000);
  }
}

// ============================================================
// EVENTS
// ============================================================
fillCreateSelects();

$('termSelect').addEventListener('change', (e) => changeTerm(e.target.value));
$('installReminderClose').addEventListener('click', () => {
  storage.set(INSTALL_REMINDER_KEY, '1');
  $('installReminder').hidden = true;
});

$('newClassBtn').addEventListener('click', openCreate);
$('emptyNewClassBtn').addEventListener('click', openCreate);
$('createForm').addEventListener('input', updatePreview);
$('classTerm').addEventListener('change', (e) => changeTerm(e.target.value).then(updatePreview));
$('createForm').addEventListener('submit', submitCreate);

$('calendar').addEventListener('click', (e) => {
  const button = e.target.closest('[data-show-code]');
  if (button) showCode(button.dataset.showCode);
});
$('copyCodeBtn').addEventListener('click', () => copyText($('codeValue').textContent, 'Code copied.'));
$('copyLinkBtn').addEventListener('click', () => copyText($('codeLink').textContent, 'Link copied.'));
$('newCodeBtn').addEventListener('click', newCode);

$('joinBtn').addEventListener('click', openJoin);
$('emptyJoinBtn').addEventListener('click', openJoin);
$('joinForm').addEventListener('submit', submitJoin);
$('scanBtn').addEventListener('click', toggleScan);

start();
