// Assignments.
// Teachers: the Assignments tab (list by week) and the assignment form.
// Students: the My Work tab (To do / Turned in / Returned / Missing).
// Assignment cards are also shown inside each week (weeks.js uses assignmentCardHtml).
import { db } from './supabase.js';
import { esc, errorMessage, showToast, openModal, closeModal } from './ui.js';
import { formatDate, formatDateTime, toTimeString, toZonedInputValue, zonedInputToIso } from './time.js';

const $ = (id) => document.getElementById(id);

const svg = (paths, size = 16, width = 2) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="${width}" aria-hidden="true">${paths}</svg>`;
const ICON = {
  task: svg('<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4h6v3H9zM9 12h6M9 16h4"/>', 18, 1.8),
  plus: svg('<path d="M12 5v14M5 12h14"/>', 16, 2.2),
  edit: svg('<path d="M4 20h4L19 9l-4-4L4 16z"/>', 16, 2),
  eye: svg('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>', 16, 2),
  eyeOff: svg('<path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2"/>', 16, 2),
  trash: svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>', 16, 2),
  // status icons
  todo: svg('<circle cx="12" cy="12" r="9"/>', 14, 2.2),
  draft: svg('<path d="M4 20h4L19 9l-4-4L4 16z"/>', 14, 2.2),
  overdue: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', 14, 2.2),
  missing: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5v.01"/>', 14, 2.2),
  submitted: svg('<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16 9.5"/>', 14, 2.2),
  late: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', 14, 2.2),
  returned: svg('<path d="M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.6 6.6 19.5l1.2-6L3.3 9.3l6.1-.7z"/>', 14, 2),
  reopened: svg('<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>', 14, 2.2),
};

const STATUS = {
  todo: 'To do',
  draft: 'Draft saved',
  reopened: 'Reopened',
  overdue: 'Late — still open',
  missing: 'Missing',
  submitted: 'Turned in',
  late: 'Turned in late',
  returned: 'Returned',
};

const ACCEPTS_LABELS = { text: 'Text', file: 'Files', both: 'Text or files' };

const formatScore = (n) => (Number.isInteger(Number(n)) ? String(Number(n)) : Number(n).toFixed(1));

// ============================================================
// SHARED HELPERS
// ============================================================

// A student's status for one assignment, from the gradebook view
// (the view only shows them a grade once it is returned).
export function studentStatus(assignment, ctx) {
  const row = ctx.work.get(assignment.id);
  const status = row?.status ?? 'not_due';
  if (status === 'returned') return 'returned';
  if (status === 'reopened') return 'reopened';
  if (status === 'late') return 'late';
  if (status === 'submitted' || status === 'graded') return row.is_late ? 'late' : 'submitted';
  if (status === 'missing') return assignment.allow_late ? 'overdue' : 'missing';
  return row?.submission_id ? 'draft' : 'todo';
}

function statusChipHtml(assignment, ctx) {
  const key = studentStatus(assignment, ctx);
  let label = STATUS[key];
  if (key === 'returned') {
    const score = ctx.work.get(assignment.id)?.score;
    if (assignment.points && score != null) label += ` · ${formatScore(score)}/${formatScore(assignment.points)}`;
  }
  return `<span class="status-chip status-chip--${key}">${ICON[key]}${esc(label)}</span>`;
}

function dueText(assignment, ctx) {
  return assignment.due_at ? `Due ${formatDateTime(assignment.due_at, ctx.cls.timezone)}` : 'No due date';
}

function weekLabelOf(assignment, ctx) {
  const w = ctx.weeks.find((x) => x.id === assignment.week_id);
  if (!w) return '';
  return w.is_holiday ? 'Holiday week' : `Week ${w.number}`;
}

// One assignment card. Students get a link to the submission page;
// teachers get edit / hide / delete buttons.
export function assignmentCardHtml(a, ctx, { showWeek = false } = {}) {
  const meta = [showWeek ? weekLabelOf(a, ctx) : '', dueText(a, ctx)].filter(Boolean).join(' · ');

  if (!ctx.isTeacher) {
    return `
      <a class="work-card" href="assignment.html?id=${encodeURIComponent(a.id)}">
        <span class="work-icon">${ICON.task}</span>
        <span class="work-text">
          <span class="work-title">${esc(a.title)}</span>
          <span class="work-meta">${esc(meta)}</span>
        </span>
        ${statusChipHtml(a, ctx)}
      </a>`;
  }

  const details = [ACCEPTS_LABELS[a.accepts], a.points ? `${formatScore(a.points)} points` : 'Check mark'];
  const flags = [
    a.hidden ? '<span class="flag flag--hidden">Hidden</span>' : '',
    a.is_assessment ? '<span class="flag flag--assess">Assessment</span>' : '',
    a.allow_late ? '<span class="flag">Late work OK</span>' : '',
  ].join('');
  const title = esc(a.title);
  return `
    <div class="work-card work-card--teacher${a.hidden ? ' is-hidden' : ''}">
      <span class="work-icon">${ICON.task}</span>
      <span class="work-text">
        <button class="work-title work-title-btn" type="button" data-action="edit-assignment" data-assignment="${a.id}">${title}</button>
        <span class="work-meta">${esc(meta)} · ${esc(details.join(' · '))}</span>
        ${flags ? `<span class="work-flags">${flags}</span>` : ''}
      </span>
      <span class="work-actions">
        <button class="icon-btn icon-btn--sm" type="button" data-action="edit-assignment" data-assignment="${a.id}" aria-label="Edit ${title}">${ICON.edit}</button>
        <button class="icon-btn icon-btn--sm" type="button" data-action="toggle-assignment" data-assignment="${a.id}" aria-label="${a.hidden ? `Show ${title} to students` : `Hide ${title} from students`}">${a.hidden ? ICON.eye : ICON.eyeOff}</button>
        <button class="icon-btn icon-btn--sm icon-btn--danger" type="button" data-action="delete-assignment" data-assignment="${a.id}" aria-label="Delete ${title}">${ICON.trash}</button>
      </span>
    </div>`;
}

// ============================================================
// TAB
// ============================================================
export function createAssignmentsTab(container, ctx, reload) {
  const editing = { id: null };
  let dueTouched = false;

  const weekById = (id) => ctx.weeks.find((w) => w.id === id);
  const assignmentById = (id) => ctx.assignments.find((a) => a.id === id);
  const byDue = (a, b) => (a.due_at ?? '9999').localeCompare(b.due_at ?? '9999');

  function render() {
    container.innerHTML = ctx.isTeacher ? teacherHtml() : studentHtml();
  }

  function teacherHtml() {
    let html = `
      <div class="weeks-toolbar">
        <button class="btn btn--primary btn--sm" type="button" data-action="add-assignment">${ICON.plus}<span>New assignment</span></button>
        <span class="toolbar-note">Students see an assignment when its week opens.</span>
      </div>`;
    if (!ctx.assignments.length) {
      return `${html}<div class="empty-state"><h2>No assignments yet</h2><p>Add one here or inside a week.</p></div>`;
    }
    for (const w of ctx.weeks) {
      const list = ctx.assignments.filter((a) => a.week_id === w.id).sort(byDue);
      if (!list.length) continue;
      const label = w.is_holiday ? 'Holiday' : `Week ${w.number}`;
      html += `
        <section class="work-group">
          <h2 class="work-group-head">${esc(label)} · ${formatDate(w.session_date)}${w.title ? ` · ${esc(w.title)}` : ''}</h2>
          ${list.map((a) => assignmentCardHtml(a, ctx)).join('')}
        </section>`;
    }
    return html;
  }

  function studentHtml() {
    const groups = { todo: [], done: [], returned: [], missing: [] };
    for (const a of ctx.assignments) {
      const key = studentStatus(a, ctx);
      if (['todo', 'draft', 'reopened', 'overdue'].includes(key)) groups.todo.push(a);
      else if (key === 'returned') groups.returned.push(a);
      else if (key === 'missing') groups.missing.push(a);
      else groups.done.push(a);
    }
    if (!ctx.assignments.length) {
      return '<div class="empty-state"><h2>No work yet</h2><p>Your assignments appear here when their week opens.</p></div>';
    }
    const section = (title, list, sort = byDue) => (list.length ? `
      <section class="work-group">
        <h2 class="work-group-head">${title} <span class="work-count">${list.length}</span></h2>
        ${[...list].sort(sort).map((a) => assignmentCardHtml(a, ctx, { showWeek: true })).join('')}
      </section>` : '');
    return section('To do', groups.todo)
      + section('Missing', groups.missing)
      + section('Turned in', groups.done)
      + section('Returned', groups.returned, (a, b) => byDue(b, a));
  }

  // ============================================================
  // FORM (teachers)
  // ============================================================
  function accepts() {
    return $('assignmentForm').querySelector('input[name="assignmentAccepts"]:checked')?.value ?? 'both';
  }

  // When the week opens: its scheduled time, or class time on its date.
  function weekOpensAt(w) {
    if (w.lock_state === 'scheduled' && w.unlock_at) return new Date(w.unlock_at);
    return new Date(zonedInputToIso(`${w.session_date}T${toTimeString(ctx.cls.start)}`, ctx.cls.timezone));
  }

  function updateFormHints() {
    $('assignmentMaxFilesField').hidden = accepts() === 'text';
    const w = weekById($('assignmentWeek').value);
    const due = $('assignmentDue').value;
    const early = w && due && new Date(zonedInputToIso(due, ctx.cls.timezone)) < weekOpensAt(w);
    $('assignmentDueWarning').hidden = !early;
  }

  // Default due date: the start of the next class (skipping holidays).
  async function setDefaultDue() {
    const { data, error } = await db.rpc('next_session_start', { p_week: $('assignmentWeek').value });
    $('assignmentDue').value = !error && data ? toZonedInputValue(data, ctx.cls.timezone) : '';
    updateFormHints();
  }

  function openForm(weekId = null, assignmentId = null) {
    const a = assignmentId ? assignmentById(assignmentId) : null;
    editing.id = assignmentId;
    dueTouched = Boolean(a);

    $('assignmentWeek').innerHTML = ctx.weeks.map((w) => `<option value="${w.id}">${w.is_holiday ? 'Holiday' : `Week ${w.number}`} · ${formatDate(w.session_date)}</option>`).join('');
    $('assignmentFormTitle').textContent = a ? 'Edit assignment' : 'New assignment';
    $('assignmentWeek').value = a?.week_id ?? weekId ?? ctx.currentWeekId ?? ctx.weeks[0].id;
    $('assignmentTitle').value = a?.title ?? '';
    $('assignmentInstructions').value = a?.instructions ?? '';
    $('assignmentForm').querySelector(`input[name="assignmentAccepts"][value="${a?.accepts ?? 'both'}"]`).checked = true;
    $('assignmentMaxFiles').value = String(a?.max_files ?? 5);
    $('assignmentPoints').value = a?.points ?? '';
    $('assignmentDue').value = a?.due_at ? toZonedInputValue(a.due_at, ctx.cls.timezone) : '';
    $('assignmentLate').checked = a?.allow_late ?? false;
    $('assignmentAssessment').checked = a?.is_assessment ?? false;
    $('assignmentHidden').checked = a?.hidden ?? false;
    $('assignmentTzHelp').textContent = `${ctx.cls.timezone.split('/').pop().replace(/_/g, ' ')} time. Leave empty for no due date.`;
    $('assignmentFormError').hidden = true;
    updateFormHints();
    openModal($('assignmentOverlay'));
    if (!a) setDefaultDue();
  }

  function showFormError(message) {
    $('assignmentFormErrorText').textContent = message;
    $('assignmentFormError').hidden = false;
  }

  async function submitForm(event) {
    event.preventDefault();
    $('assignmentFormError').hidden = true;
    const title = $('assignmentTitle').value.trim();
    const pointsRaw = $('assignmentPoints').value.trim();
    const points = pointsRaw === '' ? null : Number(pointsRaw);
    const maxFiles = Number($('assignmentMaxFiles').value);
    const due = $('assignmentDue').value;

    if (!title) return showFormError('Please type a title.');
    if (points !== null && !(points > 0)) return showFormError('Points must be more than 0, or leave it empty for a check mark.');
    if (accepts() !== 'text' && !(maxFiles >= 1 && maxFiles <= 10)) return showFormError('Students can add 1 to 10 files.');

    const payload = {
      week_id: $('assignmentWeek').value,
      title,
      instructions: $('assignmentInstructions').value.trim() || null,
      accepts: accepts(),
      max_files: accepts() === 'text' ? 5 : maxFiles,
      points,
      due_at: due ? zonedInputToIso(due, ctx.cls.timezone) : null,
      allow_late: $('assignmentLate').checked,
      is_assessment: $('assignmentAssessment').checked,
      hidden: $('assignmentHidden').checked,
    };

    const button = $('assignmentFormSubmit');
    button.disabled = true;
    let error;
    if (editing.id) {
      ({ error } = await db.from('assignments').update(payload).eq('id', editing.id));
    } else {
      const inWeek = ctx.assignments.filter((a) => a.week_id === payload.week_id).length;
      ({ error } = await db.from('assignments').insert({ ...payload, class_id: ctx.cls.id, sort_order: inWeek }));
    }
    button.disabled = false;
    if (error) return showFormError(errorMessage(error));

    closeModal($('assignmentOverlay'));
    showToast(editing.id ? 'Assignment saved.' : 'Assignment added.', 'success');
    await reload();
  }

  async function toggleHidden(assignmentId) {
    const a = assignmentById(assignmentId);
    const { error } = await db.from('assignments').update({ hidden: !a.hidden }).eq('id', assignmentId);
    if (error) showToast(errorMessage(error), 'error');
    else showToast(a.hidden ? 'Students can see it now.' : 'Hidden from students.', 'success');
    await reload();
  }

  async function remove(assignmentId) {
    const a = assignmentById(assignmentId);
    if (!window.confirm(`Delete "${a.title}"? All student work and grades for it will be deleted too.`)) return;
    const { error } = await db.from('assignments').delete().eq('id', assignmentId);
    if (error) showToast(errorMessage(error), 'error');
    else showToast('Assignment deleted.', 'success');
    await reload();
  }

  // Handles the assignment buttons wherever they appear (this tab or a week).
  function handleAction(action, assignmentId, weekId) {
    switch (action) {
      case 'add-assignment': openForm(weekId ?? null); return true;
      case 'edit-assignment': openForm(null, assignmentId); return true;
      case 'toggle-assignment': toggleHidden(assignmentId); return true;
      case 'delete-assignment': remove(assignmentId); return true;
      default: return false;
    }
  }

  container.addEventListener('click', (event) => {
    const el = event.target.closest('[data-action]');
    if (el) handleAction(el.dataset.action, el.dataset.assignment, el.dataset.week);
  });

  if (ctx.isTeacher) {
    $('assignmentForm').addEventListener('submit', submitForm);
    $('assignmentForm').addEventListener('change', (e) => {
      if (e.target.id === 'assignmentWeek' && !dueTouched) setDefaultDue();
      else updateFormHints();
    });
    $('assignmentDue').addEventListener('input', () => { dueTouched = true; updateFormHints(); });
  }

  return { render, handleAction };
}
