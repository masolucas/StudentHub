// Submission page (phone-first): assignment.html?id=…
// Before turning in, the answer autosaves as a draft. After turning in,
// changes need "Save changes", because any change counts as a new turn-in
// time (and is marked late after the due date). The database enforces the
// submission window; this page only explains it.
import { db, requireSession, getProfile } from '../supabase.js';
import { registerServiceWorker } from '../pwa.js';
import { renderNavbar } from '../nav.js';
import { esc, errorMessage, showToast } from '../ui.js';
import { formatDateTime, relativeTime } from '../time.js';
import { ACCEPT, uploadFile, deleteFile, hydrateFiles, openFileLink } from '../files.js';

registerServiceWorker();

const $ = (id) => document.getElementById(id);
const assignmentId = new URLSearchParams(window.location.search).get('id');
const AUTOSAVE_MS = 1500;
const SUBMISSION_FIELDS = 'id, status, text_response, submitted_at, reopened_at';

const state = {
  user: null,
  a: null,            // the assignment, with its week and class
  isTeacher: false,
  sub: null,          // the student's submission (null until the first save)
  grade: null,        // only present once returned
  canEdit: false,
  savedText: '',
  files: [],          // submission_files rows, in order
  busy: false,        // an upload or file change is running
};

let saveTimer = null;
let saveChain = Promise.resolve();
let syncAnswer = true;  // copy the saved answer into the text box on the next render

const FILE_ICONS = {
  remove: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  replace: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/></svg>',
  left: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>',
  right: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>',
  doc: '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M6 2h9l5 5v15H6z"/><path d="M15 2v5h5"/></svg>',
};

const formatScore = (n) => (Number.isInteger(Number(n)) ? String(Number(n)) : Number(n).toFixed(1));
const tz = () => state.a.classes.timezone;

// Escape first, then turn https links into real links.
function linkify(text) {
  return esc(text).replace(/https:\/\/[^\s<]+/g, (url) => `<a href="${url}" target="_blank" rel="noopener">${url}</a>`);
}

async function query(request) {
  const { data, error } = await request;
  if (error) throw error;
  return data;
}

// ============================================================
// LOADING
// ============================================================
async function loadAssignment() {
  state.a = await query(db
    .from('assignments')
    .select(`id, class_id, week_id, title, instructions, accepts, max_files, points, due_at, allow_late, hidden,
             weeks(number, session_date, title, is_holiday, classes!weeks_class_id_fkey(name, timezone))`)
    .eq('id', assignmentId)
    .maybeSingle());
  if (!state.a) return false;
  // Assignments reach their class through their week (there is no direct link).
  // weeks_class_id_fkey is named because classes also points back at weeks
  // (current_week_override), which makes a plain "classes(...)" ambiguous.
  state.a.classes = state.a.weeks.classes;
  state.isTeacher = Boolean(await query(db.rpc('teaches_class', { p_class: state.a.class_id })));
  document.title = `Folio · ${state.a.title}`;
  return true;
}

async function loadMyWork() {
  const [sub, grade, canEdit] = await Promise.all([
    query(db.from('submissions').select(SUBMISSION_FIELDS)
      .eq('assignment_id', assignmentId).eq('student_id', state.user.id).maybeSingle()),
    // RLS only returns a grade once it is returned.
    query(db.from('grades').select('score, comment, returned_at')
      .eq('assignment_id', assignmentId).eq('student_id', state.user.id).maybeSingle()),
    query(db.rpc('student_can_edit', { p_assignment: assignmentId })),
  ]);
  state.sub = sub;
  state.grade = grade;
  state.canEdit = Boolean(canEdit);
  state.savedText = sub?.text_response ?? '';
  state.files = sub
    ? await query(db.from('submission_files')
      .select('id, file_key, file_name, mime_type, size_bytes, sort_order')
      .eq('submission_id', sub.id)
      .order('sort_order').order('created_at'))
    : [];
}

// ============================================================
// STATE → SCREEN
// ============================================================
const isTurnedIn = () => state.sub?.status === 'submitted';
const isReopened = () => state.sub?.status === 'draft' && Boolean(state.sub?.reopened_at);
const isPastDue = () => Boolean(state.a.due_at) && new Date() > new Date(state.a.due_at);
const isLate = () => isTurnedIn() && Boolean(state.a.due_at) && new Date(state.sub.submitted_at) > new Date(state.a.due_at);
const acceptsText = () => state.a.accepts !== 'file';
const acceptsFiles = () => state.a.accepts !== 'text';

function statusKey() {
  if (state.isTeacher) return null;
  if (isReopened()) return 'reopened';
  if (state.grade?.returned_at) return 'returned';
  if (isTurnedIn()) return isLate() ? 'late' : 'submitted';
  if (isPastDue()) return state.a.allow_late ? 'overdue' : 'missing';
  return state.sub ? 'draft' : 'todo';
}

const STATUS_LABELS = {
  todo: 'To do', draft: 'Draft saved', reopened: 'Reopened', overdue: 'Late — still open',
  missing: 'Missing', submitted: 'Turned in', late: 'Turned in late', returned: 'Returned',
};

function banner(type, title, text) {
  return `<div class="alert alert--${type}" role="status"><div><b>${esc(title)}</b>${esc(text)}</div></div>`;
}

function render() {
  const a = state.a;
  const week = a.weeks;
  $('backLink').href = `class.html?id=${encodeURIComponent(a.class_id)}#work`;
  $('backLabel').textContent = `${a.classes.name}${week && !week.is_holiday ? ` · Week ${week.number}` : ''}`;
  $('title').textContent = a.title;

  const key = statusKey();
  $('statusChip').innerHTML = key ? `<span class="status-chip status-chip--${key}">${esc(STATUS_LABELS[key])}</span>` : '';

  $('dueLine').textContent = a.due_at
    ? `Due ${formatDateTime(a.due_at, tz())} (${relativeTime(a.due_at)})`
    : 'No due date';
  $('pointsLine').textContent = a.points ? `${formatScore(a.points)} points` : '';
  $('pointsLine').hidden = !a.points;

  $('instructionsSection').hidden = !a.instructions;
  $('instructions').innerHTML = a.instructions ? linkify(a.instructions) : '';

  if (state.isTeacher) {
    $('teacherNote').hidden = false;
    $('answerSection').hidden = !acceptsText();
    $('answer').disabled = true;
    $('filesSection').hidden = !acceptsFiles();
    return;
  }

  renderBanner();
  renderGrade();

  $('answerSection').hidden = !acceptsText();
  // Only copy the saved answer in on load and after turning in / saving,
  // so typing is never overwritten by a file change.
  if (acceptsText() && syncAnswer) $('answer').value = state.sub?.text_response ?? '';
  syncAnswer = false;
  $('answer').disabled = !state.canEdit;

  renderFiles();
  renderActions();
}

// ------------------------------------------------------------
// Photos and files
// ------------------------------------------------------------
const isImage = (f) => f.mime_type.startsWith('image/');

function fileTileHtml(f, index) {
  const count = state.files.length;
  const label = isImage(f) ? `Photo ${index + 1}` : f.file_name;
  const preview = isImage(f)
    ? `<img data-file-src="${esc(f.file_key)}" alt="${esc(label)}">`
    : `<span class="file-doc">${FILE_ICONS.doc}<span class="file-name">${esc(f.file_name)}</span></span>`;
  const actions = state.canEdit ? `
    <div class="file-tile-actions">
      <button class="icon-btn icon-btn--sm" type="button" data-file-action="left" data-file="${f.id}" aria-label="Move ${esc(label)} left"${index === 0 || state.busy ? ' disabled' : ''}>${FILE_ICONS.left}</button>
      <button class="icon-btn icon-btn--sm" type="button" data-file-action="right" data-file="${f.id}" aria-label="Move ${esc(label)} right"${index === count - 1 || state.busy ? ' disabled' : ''}>${FILE_ICONS.right}</button>
      <button class="icon-btn icon-btn--sm" type="button" data-file-action="replace" data-file="${f.id}" aria-label="Replace ${esc(label)}"${state.busy ? ' disabled' : ''}>${FILE_ICONS.replace}</button>
      <button class="icon-btn icon-btn--sm icon-btn--danger" type="button" data-file-action="remove" data-file="${f.id}" aria-label="Remove ${esc(label)}"${state.busy ? ' disabled' : ''}>${FILE_ICONS.remove}</button>
    </div>` : '';
  return `
    <div class="file-tile">
      <a class="file-thumb" href="#" data-file-key="${esc(f.file_key)}" target="_blank" rel="noopener" aria-label="Open ${esc(label)}">${preview}</a>
      ${actions}
    </div>`;
}

function renderFiles() {
  $('filesSection').hidden = !acceptsFiles() || state.isTeacher;
  if (!acceptsFiles() || state.isTeacher) return;

  const max = state.a.max_files;
  const count = state.files.length;
  $('filesCount').textContent = `(${count} of ${max})`;
  $('fileTiles').innerHTML = state.files.map(fileTileHtml).join('');
  $('filesEmpty').hidden = count > 0 || state.canEdit;
  hydrateFiles($('fileTiles'));

  const canAdd = state.canEdit && count < max && !state.busy;
  $('fileButtons').hidden = !state.canEdit;
  ['takePhotoBtn', 'chooseFileBtn'].forEach((id) => $(id).classList.toggle('is-disabled', !canAdd));
  $('cameraInput').disabled = !canAdd;
  $('fileInput').disabled = !canAdd;
  $('filesHelp').textContent = state.canEdit
    ? (count >= max ? `You added the most files (${max}).` : 'Photos, PDF or Word files. Photos are made smaller before upload.')
    : '';
}

// Uploading tile with a progress bar; returns a function to update it.
function addUploadingTile(name) {
  const tile = document.createElement('div');
  tile.className = 'file-tile is-uploading';
  tile.innerHTML = `<span class="file-doc"><span class="spinner" aria-hidden="true"></span><span class="file-name">${esc(name)}</span></span><span class="file-progress"><span></span></span>`;
  $('fileTiles').appendChild(tile);
  const bar = tile.querySelector('.file-progress span');
  return {
    progress: (p) => bar.style.setProperty('--progress', `${Math.round(p * 100)}%`),
    remove: () => tile.remove(),
  };
}

// After turning in, changing files counts as a new turn-in time.
function confirmLateChange() {
  if (!isTurnedIn() || !isPastDue()) return true;
  return window.confirm('The due date has passed. If you change your files now, your work will be marked late. Continue?');
}

// Files belong to a submission, so create a draft first if needed.
async function ensureSubmission() {
  clearTimeout(saveTimer);
  await saveChain;
  if (state.sub) return;
  const text = acceptsText() ? $('answer').value : '';
  const { data, error } = await db.from('submissions')
    .insert({ assignment_id: assignmentId, student_id: state.user.id, status: 'draft', text_response: text || null })
    .select(SUBMISSION_FIELDS).single();
  if (error) throw error;
  state.sub = data;
  state.savedText = data.text_response ?? '';
}

async function insertFileRow(upload, sortOrder) {
  const { error } = await db.from('submission_files').insert({
    submission_id: state.sub.id,
    file_key: upload.key,
    file_name: upload.fileName.slice(-255),
    mime_type: upload.mimeType,
    size_bytes: upload.size,
    sort_order: sortOrder,
  });
  if (error) throw error;
}

async function addFiles(fileList) {
  let files = [...fileList];
  if (!files.length || state.busy) return;
  $('submitError').hidden = true;
  if (!confirmLateChange()) return;

  const room = state.a.max_files - state.files.length;
  if (files.length > room) {
    showError(room ? `You can add ${room} more ${room === 1 ? 'file' : 'files'}. The others were not added.` : 'You added the most files already.');
    files = files.slice(0, room);
    if (!files.length) return;
  }

  state.busy = true;
  renderFiles();
  try {
    await ensureSubmission();
    let order = state.files.length ? Math.max(...state.files.map((f) => f.sort_order)) + 1 : 0;
    for (const file of files) {
      const tile = addUploadingTile(file.name);
      try {
        const upload = await uploadFile({ purpose: 'submission', assignmentId, file, onProgress: tile.progress });
        try {
          await insertFileRow(upload, order);
          order += 1;
        } catch (err) {
          await deleteFile(upload.key);  // don't leave an orphan in B2
          throw err;
        }
      } catch (err) {
        showError(errorMessage(err));
      } finally {
        tile.remove();
      }
    }
  } catch (err) {
    showError(errorMessage(err));
  }
  state.busy = false;
  await refresh();
}

async function removeFile(fileId) {
  const f = state.files.find((x) => x.id === fileId);
  if (!f || !confirmLateChange()) return;
  $('submitError').hidden = true;
  state.busy = true;
  renderFiles();
  const { error } = await db.from('submission_files').delete().eq('id', fileId);
  if (error) showError(errorMessage(error));
  else await deleteFile(f.file_key);
  state.busy = false;
  await refresh();
}

// Replace = upload the new file, swap the rows, delete the old file.
async function replaceFile(fileId, newFile) {
  const old = state.files.find((x) => x.id === fileId);
  if (!old || !newFile || !confirmLateChange()) return;
  $('submitError').hidden = true;
  state.busy = true;
  renderFiles();
  const tile = addUploadingTile(newFile.name);
  try {
    const upload = await uploadFile({ purpose: 'submission', assignmentId, file: newFile, onProgress: tile.progress });
    const atLimit = state.files.length >= state.a.max_files;
    try {
      // At the file limit the old row must go first to make room.
      if (atLimit) {
        const { error } = await db.from('submission_files').delete().eq('id', old.id);
        if (error) throw error;
      }
      await insertFileRow(upload, old.sort_order);
      if (!atLimit) {
        const { error } = await db.from('submission_files').delete().eq('id', old.id);
        if (error) throw error;
      }
    } catch (err) {
      await deleteFile(upload.key);
      throw err;
    }
    await deleteFile(old.file_key);
  } catch (err) {
    showError(errorMessage(err));
  } finally {
    tile.remove();
  }
  state.busy = false;
  await refresh();
}

async function moveFile(fileId, direction) {
  const list = [...state.files];
  const i = list.findIndex((f) => f.id === fileId);
  const j = i + direction;
  if (i < 0 || j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  state.busy = true;
  renderFiles();
  const results = await Promise.all(list
    .map((f, index) => (f.sort_order !== index ? db.from('submission_files').update({ sort_order: index }).eq('id', f.id) : null))
    .filter(Boolean));
  const failed = results.find((r) => r.error);
  if (failed) showError(errorMessage(failed.error));
  state.busy = false;
  await refresh();
}

let replacingId = null;

$('cameraInput').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
$('fileInput').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
$('replaceInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (replacingId && file) replaceFile(replacingId, file);
  replacingId = null;
});
$('fileTiles').addEventListener('click', (e) => {
  const button = e.target.closest('[data-file-action]');
  if (!button) {
    openFileLink(e);
    return;
  }
  const { fileAction, file } = button.dataset;
  if (fileAction === 'remove') removeFile(file);
  if (fileAction === 'left') moveFile(file, -1);
  if (fileAction === 'right') moveFile(file, 1);
  if (fileAction === 'replace') {
    replacingId = file;
    $('replaceInput').click();
  }
});

function renderBanner() {
  const a = state.a;
  let html = '';
  if (isReopened()) {
    html = banner('info', 'Your teacher reopened this.', ' Make your changes and turn it in again.');
  } else if (state.grade?.returned_at) {
    html = banner('success', 'Your work was returned.', ' See your grade below.');
  } else if (isTurnedIn()) {
    const when = formatDateTime(state.sub.submitted_at, tz());
    html = isLate()
      ? banner('warning', `Turned in late · ${when}`, '')
      : banner('success', `Turned in · ${when}`, ' ✓');
  } else if (!state.canEdit) {
    html = banner('error', 'This assignment is closed.', isPastDue() ? ' The due date has passed.' : '');
  } else if (isPastDue() && a.allow_late) {
    html = banner('warning', 'The due date has passed.', ' You can still turn it in, but it will be marked late.');
  }
  $('banner').innerHTML = html;
}

function renderGrade() {
  const g = state.grade;
  $('gradeCard').hidden = !g?.returned_at;
  if (!g?.returned_at) return;
  if (state.a.points) {
    $('gradeScore').textContent = g.score != null ? `${formatScore(g.score)} / ${formatScore(state.a.points)}` : '✓';
  } else {
    $('gradeScore').textContent = g.score != null ? formatScore(g.score) : '✓';
  }
  $('gradeComment').hidden = !g.comment;
  $('gradeComment').textContent = g.comment ?? '';
}

function renderActions() {
  const canTurnIn = state.canEdit && !isTurnedIn();
  const canSaveChanges = state.canEdit && isTurnedIn();
  $('actions').hidden = !(canTurnIn || canSaveChanges);
  $('turnInBtn').hidden = !canTurnIn;
  $('turnInBtn').disabled = state.busy;
  $('saveChangesBtn').hidden = !canSaveChanges;
  updateSaveChangesButton();

  const until = state.a.due_at ? formatDateTime(state.a.due_at, tz()) : null;
  let help = '';
  if (canTurnIn && until && !isPastDue()) help = `You can change it until ${until}.`;
  if (canSaveChanges) {
    help = isPastDue()
      ? 'The due date has passed. Saving changes now marks your work as late.'
      : (until ? `You can change it until ${until}.` : 'You can still change it.');
  }
  $('actionHelp').textContent = help;
  $('actionHelp').hidden = !help;
}

function updateSaveChangesButton() {
  $('saveChangesBtn').disabled = !isTurnedIn() || $('answer').value === state.savedText;
}

function showError(message) {
  $('submitErrorText').textContent = message;
  $('submitError').hidden = false;
}

// ============================================================
// SAVING
// ============================================================
function setSaveState(text, kind = '') {
  $('saveState').textContent = text;
  $('saveState').className = `save-state${kind ? ` save-state--${kind}` : ''}`;
}

// Draft autosave (only before turning in).
async function saveDraft() {
  const text = $('answer').value;
  if (text === state.savedText || isTurnedIn() || !state.canEdit) return;
  setSaveState('Saving…');

  const request = state.sub
    ? db.from('submissions').update({ text_response: text || null }).eq('id', state.sub.id)
    : db.from('submissions').insert({ assignment_id: assignmentId, student_id: state.user.id, status: 'draft', text_response: text || null });
  const { data, error } = await request.select(SUBMISSION_FIELDS).single();

  if (error) {
    setSaveState('Not saved. Check your connection.', 'error');
    return;
  }
  state.sub = data;
  state.savedText = data.text_response ?? '';
  setSaveState('✓ Saved', 'ok');
  $('statusChip').innerHTML = `<span class="status-chip status-chip--${statusKey()}">${esc(STATUS_LABELS[statusKey()])}</span>`;
}

function queueSave() {
  saveChain = saveChain.then(saveDraft).catch(() => {});
  return saveChain;
}

function onAnswerInput() {
  $('submitError').hidden = true;
  if (isTurnedIn()) {
    updateSaveChangesButton();
    return;
  }
  setSaveState('');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(queueSave, AUTOSAVE_MS);
}

async function turnIn() {
  $('submitError').hidden = true;
  clearTimeout(saveTimer);
  await saveChain;

  const text = acceptsText() ? $('answer').value.trim() : '';
  if (state.a.accepts === 'text' && !text) {
    showError('Write your answer before you turn it in.');
    return;
  }
  if (state.a.accepts === 'file' && !state.files.length) {
    showError('Add a photo or a file before you turn it in.');
    return;
  }
  if (state.a.accepts === 'both' && !text && !state.files.length) {
    showError('Write your answer or add a file before you turn it in.');
    return;
  }

  const button = $('turnInBtn');
  button.disabled = true;
  const request = state.sub
    ? db.from('submissions').update({ status: 'submitted', text_response: text || null }).eq('id', state.sub.id)
    : db.from('submissions').insert({ assignment_id: assignmentId, student_id: state.user.id, status: 'submitted', text_response: text || null });
  const { error } = await request;
  button.disabled = false;
  if (error) {
    showError(errorMessage(error));
    return;
  }

  showToast('Turned in! ✓', 'success');
  setSaveState('');
  syncAnswer = true;
  await refresh();
}

async function saveChanges() {
  $('submitError').hidden = true;
  if (isPastDue() && !window.confirm('The due date has passed. If you save now, your work will be marked late. Save anyway?')) return;

  const button = $('saveChangesBtn');
  button.disabled = true;
  const { error } = await db.from('submissions')
    .update({ text_response: $('answer').value.trim() || null })
    .eq('id', state.sub.id);
  if (error) {
    showError(errorMessage(error));
    updateSaveChangesButton();
    return;
  }
  showToast('Changes saved.', 'success');
  syncAnswer = true;
  await refresh();
}

async function refresh() {
  try {
    await loadMyWork();
  } catch (err) {
    showError(errorMessage(err));
  }
  render();
}

// ============================================================
// START
// ============================================================
$('fileInput').accept = ACCEPT.submission;
$('replaceInput').accept = ACCEPT.submission;
$('answer').addEventListener('input', onAnswerInput);
$('turnInBtn').addEventListener('click', turnIn);
$('saveChangesBtn').addEventListener('click', saveChanges);

// Warn before leaving with unsaved changes.
window.addEventListener('beforeunload', (event) => {
  if (state.isTeacher || !state.a || !acceptsText()) return;
  if ($('answer').value !== state.savedText) event.preventDefault();
});

async function start() {
  const session = await requireSession();
  if (!session) return;
  state.user = session.user;

  try {
    const profile = await getProfile(state.user.id);
    renderNavbar($('navbar'), profile);
    if (!assignmentId || !(await loadAssignment())) {
      $('loading').hidden = true;
      $('notFound').hidden = false;
      return;
    }
    if (!state.isTeacher) await loadMyWork();
  } catch (err) {
    // Show the real problem instead of a misleading "not found".
    $('notFoundTitle').textContent = 'Something went wrong';
    $('notFoundText').textContent = errorMessage(err);
    $('loading').hidden = true;
    $('notFound').hidden = false;
    return;
  }

  render();
  $('loading').hidden = true;
  $('page').hidden = false;
}

start();
