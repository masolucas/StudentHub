// Students & Grades tab (teachers).
// Students as rows, assignments as columns in due-date order. The student
// column stays put; assignments scroll sideways. It is also the roster:
// join code, remove/restore students, "Show removed students".
// Clicking a cell opens the grading panel (answer, files, score, comment,
// save / return / reopen, arrows to the next student).
// Graded and Returned are separate: grade privately, then return.
import { db } from './supabase.js';
import { esc, errorMessage, showToast, openModal, loadScript } from './ui.js';
import { formatDateTime } from './time.js';
import { isOpenToClass } from './week-access.js';
import { hydrateFiles, openFileLink } from './files.js';
import { joinUrl } from './join-code.js';

const $ = (id) => document.getElementById(id);
const EXCELJS = 'https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js';

const svg = (paths, size = 15, width = 2.2) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="${width}" aria-hidden="true">${paths}</svg>`;
const ICON = {
  missing: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5v.01"/>'),
  submitted: svg('<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16 9.5"/>'),
  late: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  reopened: svg('<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>'),
  remove: svg('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 11h6"/>', 16, 2),
  restore: svg('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M19 8v6M16 11h6"/>', 16, 2),
  copy: svg('<rect x="9" y="9" width="11" height="11" rx="1.5"/><path d="M5 15V5a1 1 0 0 1 1-1h10"/>', 16, 2),
  excel: svg('<path d="M6 2h9l5 5v15H6z"/><path d="M15 2v5h5M9 12l5 6M14 12l-5 6"/>', 16, 2),
};

const STATUS_TEXT = {
  not_due: 'Not due yet', missing: 'Missing', submitted: 'Submitted', late: 'Late',
  graded: 'Graded, not returned', returned: 'Returned', reopened: 'Reopened',
};

// Excel fills (ARGB), matching the status colors in folio.css.
const EXCEL_FILLS = {
  missing: 'FFF8D7DA', submitted: 'FFF5EED2', late: 'FFFEF3C7',
  graded: 'FFEDF2F9', returned: 'FFD4EDDA', reopened: 'FFD9E2F1',
};

const formatScore = (n) => (Number.isInteger(Number(n)) ? String(Number(n)) : Number(n).toFixed(1));
const isTurnedIn = (status) => ['submitted', 'late', 'graded', 'returned'].includes(status);

export function createGradebookTab(container, ctx) {
  const data = { roster: [], cells: new Map(), code: null };
  let showRemoved = false;
  const panel = { studentId: null, assignmentId: null, sub: null, grade: null, open: false };

  const cellKey = (studentId, assignmentId) => `${studentId}:${assignmentId}`;
  const cellOf = (studentId, assignmentId) => data.cells.get(cellKey(studentId, assignmentId)) ?? { status: 'not_due' };
  const assignmentById = (id) => ctx.assignments.find((a) => a.id === id);
  const studentById = (id) => data.roster.find((s) => s.id === id);

  function columns() {
    const weekDate = (a) => ctx.weeks.find((w) => w.id === a.week_id)?.session_date ?? '';
    return [...ctx.assignments].sort((a, b) =>
      (a.due_at ?? '9999').localeCompare(b.due_at ?? '9999') || weekDate(a).localeCompare(weekDate(b)));
  }

  function visibleStudents() {
    return data.roster.filter((s) => showRemoved || !s.removed);
  }

  function weekOpen(a) {
    const week = ctx.weeks.find((w) => w.id === a.week_id);
    return week ? isOpenToClass(week) : true;
  }

  // ============================================================
  // DATA
  // ============================================================
  async function query(request) {
    const { data: rows, error } = await request;
    if (error) throw error;
    return rows;
  }

  async function refresh() {
    try {
      const [roster, rows, code] = await Promise.all([
        query(db.from('enrollments')
          .select('student_id, removed_at, profiles!enrollments_student_id_fkey(full_name, preferred_name, email)')
          .eq('class_id', ctx.cls.id)),
        query(db.from('gradebook')
          .select('assignment_id, student_id, status, is_late, score, comment, returned_at, submission_id, submitted_at')
          .eq('class_id', ctx.cls.id)),
        query(db.from('class_join_codes').select('code').eq('class_id', ctx.cls.id).maybeSingle()),
      ]);
      data.roster = roster
        .map((r) => ({
          id: r.student_id,
          name: r.profiles?.preferred_name || r.profiles?.full_name || r.profiles?.email || 'Student',
          email: r.profiles?.email ?? '',
          removed: Boolean(r.removed_at),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      data.cells = new Map(rows.map((r) => [cellKey(r.student_id, r.assignment_id), r]));
      data.code = code?.code ?? null;
    } catch (err) {
      showToast(errorMessage(err), 'error');
    }
    render();
  }

  // ============================================================
  // TABLE
  // ============================================================
  function cellHtml(cell) {
    const s = cell.status;
    const scoreText = cell.score != null ? formatScore(cell.score) : '✓';
    switch (s) {
      case 'missing': return `${ICON.missing}<span>Missing</span>`;
      case 'submitted': return `${ICON.submitted}<span>Submitted</span>`;
      case 'late': return `${ICON.late}<span>Late</span>`;
      case 'reopened': return `${ICON.reopened}<span>Reopened</span>`;
      case 'graded':
        return `<span class="g-score">${scoreText}</span><span class="g-pending" title="Graded, not returned yet" aria-hidden="true">●</span>`;
      case 'returned':
        return `<span class="g-score">${scoreText}</span>${cell.is_late ? '<span class="g-late" title="Turned in late">late</span>' : ''}`;
      default:
        return '<span class="g-none" aria-hidden="true">—</span>';
    }
  }

  function studentAverage(studentId, cols) {
    let got = 0;
    let possible = 0;
    for (const a of cols) {
      const cell = cellOf(studentId, a.id);
      if (a.points && cell.score != null && ['graded', 'returned'].includes(cell.status)) {
        got += Number(cell.score);
        possible += Number(a.points);
      }
    }
    return possible ? Math.round((got / possible) * 100) : null;
  }

  function render() {
    const cols = columns();
    const students = visibleStudents();
    const active = data.roster.filter((s) => !s.removed);
    const removedCount = data.roster.length - active.length;

    let html = `
      <div class="grades-toolbar">
        <p class="grades-summary">
          <strong>${active.length} ${active.length === 1 ? 'student' : 'students'}</strong>
          ${data.code ? `<span class="grades-code">Join code <span class="mono code-pill">${esc(data.code)}</span></span>
            <button class="btn btn--ghost btn--sm" type="button" data-action="copy-link">${ICON.copy}<span>Copy join link</span></button>` : ''}
        </p>
        <div class="grades-tools">
          <label class="check-row check-row--compact grades-removed-toggle">
            <input type="checkbox" data-action="toggle-removed"${showRemoved ? ' checked' : ''}>
            <span>Show removed students${removedCount ? ` (${removedCount})` : ''}</span>
          </label>
          <button class="btn btn--secondary btn--sm" type="button" data-action="export"${students.length && cols.length ? '' : ' disabled'}>${ICON.excel}<span>Export to Excel</span></button>
        </div>
      </div>`;

    if (!students.length) {
      container.innerHTML = `${html}<div class="empty-state"><h2>No students yet</h2><p>Share the join code so students can join.</p></div>`;
      return;
    }
    if (!cols.length) {
      container.innerHTML = `${html}<div class="empty-state"><h2>No assignments yet</h2><p>Add an assignment and it appears here as a column.</p></div>`;
      return;
    }

    // Header: one column per assignment, with "Return N" when graded work is waiting.
    html += '<div class="grades-wrap"><table class="grades"><thead><tr><th class="g-student" scope="col">Student</th>';
    for (const a of cols) {
      const waiting = active.filter((s) => cellOf(s.id, a.id).status === 'graded').length;
      const classes = ['g-col'];
      if (!weekOpen(a)) classes.push('is-locked');
      if (a.hidden) classes.push('is-hidden');
      html += `
        <th class="${classes.join(' ')}" scope="col">
          <div class="g-head">
            <span class="g-title" title="${esc(a.title)}">${esc(a.title)}</span>
            <span class="g-meta">${a.due_at ? `Due ${esc(formatDateTime(a.due_at, ctx.cls.timezone).split(' · ')[0])}` : 'No due date'}</span>
            <span class="g-meta">${a.points ? `${formatScore(a.points)} pts` : '✓ only'}${a.hidden ? ' · Hidden' : ''}${weekOpen(a) ? '' : ' · Locked'}</span>
            ${waiting ? `<button class="btn btn--gold btn--xs" type="button" data-action="return-all" data-assignment="${a.id}">Return ${waiting}</button>` : ''}
          </div>
        </th>`;
    }
    html += '<th class="g-sum" scope="col">Missing</th><th class="g-sum" scope="col">Average</th></tr></thead><tbody>';

    for (const s of students) {
      const missing = cols.filter((a) => cellOf(s.id, a.id).status === 'missing').length;
      const average = studentAverage(s.id, cols);
      html += `<tr${s.removed ? ' class="is-removed"' : ''}>
        <th class="g-student" scope="row">
          <span class="g-name">${esc(s.name)}</span>
          ${s.removed ? '<span class="chip chip--closed">Removed</span>' : ''}
          <button class="icon-btn icon-btn--sm g-row-btn" type="button" data-action="${s.removed ? 'restore-student' : 'remove-student'}" data-student="${s.id}"
                  aria-label="${s.removed ? `Restore ${esc(s.name)}` : `Remove ${esc(s.name)} from the class`}" title="${s.removed ? 'Restore' : 'Remove from class'}">
            ${s.removed ? ICON.restore : ICON.remove}
          </button>
        </th>`;
      for (const a of cols) {
        const cell = cellOf(s.id, a.id);
        const classes = ['g-cell', `g-cell--${cell.status}`];
        if (!weekOpen(a)) classes.push('is-locked');
        html += `
          <td class="${classes.join(' ')}">
            <button class="g-btn" type="button" data-action="open-cell" data-student="${s.id}" data-assignment="${a.id}"
                    aria-label="${esc(s.name)}, ${esc(a.title)}: ${esc(STATUS_TEXT[cell.status] ?? '')}${cell.score != null ? `, ${formatScore(cell.score)}` : ''}">
              ${cellHtml(cell)}
            </button>
          </td>`;
      }
      html += `<td class="g-sum${missing ? ' g-sum--missing' : ''}">${missing || '—'}</td>
               <td class="g-sum">${average == null ? '—' : `${average}%`}</td></tr>`;
    }

    // Footer: how many active students turned each assignment in.
    html += '</tbody><tfoot><tr><th class="g-student" scope="row">Turned in</th>';
    for (const a of cols) {
      const done = active.filter((s) => isTurnedIn(cellOf(s.id, a.id).status)).length;
      html += `<td class="g-foot">${done} / ${active.length}</td>`;
    }
    html += '<td class="g-foot"></td><td class="g-foot"></td></tr></tfoot></table></div>';

    html += `
      <p class="grades-key">
        <span class="g-key g-cell--missing">Missing</span>
        <span class="g-key g-cell--submitted">Submitted</span>
        <span class="g-key g-cell--late">Late</span>
        <span class="g-key g-cell--graded">8 ● graded, not returned</span>
        <span class="g-key g-cell--returned">8 returned</span>
      </p>`;

    container.innerHTML = html;
  }

  // ============================================================
  // GRADING PANEL
  // ============================================================
  async function loadCell(studentId, assignmentId) {
    const [sub, grade] = await Promise.all([
      query(db.from('submissions').select('id, status, text_response, submitted_at, reopened_at')
        .eq('assignment_id', assignmentId).eq('student_id', studentId).maybeSingle()),
      query(db.from('grades').select('score, comment, graded_at, returned_at')
        .eq('assignment_id', assignmentId).eq('student_id', studentId).maybeSingle()),
    ]);
    const files = sub
      ? await query(db.from('submission_files').select('id, file_key, file_name, mime_type')
        .eq('submission_id', sub.id).order('sort_order').order('created_at'))
      : [];
    Object.assign(panel, { studentId, assignmentId, sub, grade, files });
  }

  function statusLine() {
    const a = assignmentById(panel.assignmentId);
    const cell = cellOf(panel.studentId, panel.assignmentId);
    const tz = ctx.cls.timezone;
    if (panel.sub?.status === 'submitted') {
      const late = a.due_at && new Date(panel.sub.submitted_at) > new Date(a.due_at);
      return `Turned in ${formatDateTime(panel.sub.submitted_at, tz)}${late ? ' · Late' : ''}`;
    }
    if (panel.sub?.reopened_at && panel.sub.status === 'draft') return `Reopened ${formatDateTime(panel.sub.reopened_at, tz)} · not turned in again yet`;
    if (cell.status === 'missing') return 'Missing · nothing turned in';
    if (panel.sub) return 'Draft started · not turned in';
    return 'Nothing turned in yet';
  }

  function renderPanel() {
    const a = assignmentById(panel.assignmentId);
    const s = studentById(panel.studentId);
    const students = visibleStudents();
    const index = students.findIndex((x) => x.id === panel.studentId);

    $('gradeAssignment').textContent = a.title;
    $('gradeStudent').textContent = s?.name ?? '';
    $('gradePosition').textContent = index >= 0 ? `${index + 1} of ${students.length}` : '';
    $('gradePrev').disabled = index <= 0;
    $('gradeNext').disabled = index < 0 || index >= students.length - 1;
    $('gradeStatus').textContent = statusLine();

    const text = panel.sub?.text_response;
    $('gradeAnswerSection').hidden = a.accepts === 'file';
    $('gradeAnswer').textContent = text || 'No written answer.';
    $('gradeAnswer').classList.toggle('is-empty', !text);

    $('gradeFilesSection').hidden = a.accepts === 'text';
    $('gradeFiles').innerHTML = panel.files.length
      ? panel.files.map((f, i) => `
          <div class="file-tile">
            <a class="file-thumb" href="#" data-file-key="${esc(f.file_key)}" target="_blank" rel="noopener" aria-label="Open ${esc(f.file_name)}">
              ${f.mime_type.startsWith('image/')
                ? `<img data-file-src="${esc(f.file_key)}" alt="Photo ${i + 1}">`
                : `<span class="file-doc"><span class="file-name">${esc(f.file_name)}</span></span>`}
            </a>
          </div>`).join('')
      : '<p class="field-help">No files.</p>';
    hydrateFiles($('gradeFiles'));

    // Grade fields
    $('gradeScoreField').hidden = !a.points;
    $('gradeOutOf').textContent = a.points ? `/ ${formatScore(a.points)}` : '';
    $('gradeScore').value = panel.grade?.score ?? '';
    $('gradeComment').value = panel.grade?.comment ?? '';
    $('gradeCheckNote').hidden = Boolean(a.points);

    const returned = Boolean(panel.grade?.returned_at);
    $('gradeSaveReturn').hidden = returned;
    $('gradeSave').textContent = returned ? 'Save changes' : 'Save (don’t return yet)';
    $('gradeClear').hidden = !panel.grade;
    $('gradeReopen').hidden = panel.sub?.status === 'draft' && Boolean(panel.sub?.reopened_at);
    $('gradeVisibility').textContent = returned
      ? `Returned ${formatDateTime(panel.grade.returned_at, ctx.cls.timezone)}. The student sees changes right away.`
      : panel.grade ? 'Graded, not returned. The student can’t see this grade yet.' : 'Not graded yet.';
    $('gradeError').hidden = true;
  }

  async function openCell(studentId, assignmentId) {
    try {
      await loadCell(studentId, assignmentId);
    } catch (err) {
      showToast(errorMessage(err), 'error');
      return;
    }
    renderPanel();
    if (!panel.open) {
      panel.open = true;
      openModal($('gradeOverlay'), {
        bodyClass: 'panel-open',
        onClose: () => { panel.open = false; },
      });
    }
    // Keep the edited cell visible.
    container.querySelector(`[data-student="${studentId}"][data-assignment="${assignmentId}"]`)
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function moveStudent(step) {
    const students = visibleStudents();
    const index = students.findIndex((s) => s.id === panel.studentId);
    const next = students[index + step];
    if (next) openCell(next.id, panel.assignmentId);
  }

  function showPanelError(message) {
    $('gradeErrorText').textContent = message;
    $('gradeError').hidden = false;
  }

  async function saveGrade(andReturn) {
    const a = assignmentById(panel.assignmentId);
    const raw = $('gradeScore').value.trim();
    const score = a.points && raw !== '' ? Number(raw) : null;
    const comment = $('gradeComment').value.trim() || null;

    if (a.points && raw === '') return showPanelError('Type a score first.');
    if (a.points && !(score >= 0)) return showPanelError('The score must be 0 or more.');

    const returnNow = andReturn && !panel.grade?.returned_at;
    const buttons = [$('gradeSave'), $('gradeSaveReturn')];
    buttons.forEach((b) => { b.disabled = true; });

    // No upsert: teachers may only update score, comment and returned_at.
    const request = panel.grade
      ? db.from('grades').update({ score, comment, ...(returnNow ? { returned_at: new Date().toISOString() } : {}) })
        .eq('assignment_id', panel.assignmentId).eq('student_id', panel.studentId)
      : db.from('grades').insert({
        assignment_id: panel.assignmentId,
        student_id: panel.studentId,
        score,
        comment,
        ...(returnNow ? { returned_at: new Date().toISOString() } : {}),
      });
    const { error } = await request;
    buttons.forEach((b) => { b.disabled = false; });
    if (error) return showPanelError(errorMessage(error));

    showToast(returnNow ? 'Saved and returned.' : 'Saved.', 'success');
    await refresh();
    await openCell(panel.studentId, panel.assignmentId);
  }

  async function clearGrade() {
    const msg = panel.grade?.returned_at
      ? 'Clear this grade? The student will no longer see it.'
      : 'Clear this grade?';
    if (!window.confirm(msg)) return;
    const { error } = await db.from('grades').delete()
      .eq('assignment_id', panel.assignmentId).eq('student_id', panel.studentId);
    if (error) return showPanelError(errorMessage(error));
    showToast('Grade cleared.', 'success');
    await refresh();
    await openCell(panel.studentId, panel.assignmentId);
  }

  async function reopen() {
    const s = studentById(panel.studentId);
    if (!window.confirm(`Reopen this for ${s?.name ?? 'the student'}? They can change their work and turn it in again, even after the due date.`)) return;
    const { error } = await db.rpc('reopen_submission', { p_assignment: panel.assignmentId, p_student: panel.studentId });
    if (error) return showPanelError(errorMessage(error));
    showToast('Reopened.', 'success');
    await refresh();
    await openCell(panel.studentId, panel.assignmentId);
  }

  // ============================================================
  // TABLE ACTIONS
  // ============================================================
  async function returnAll(assignmentId) {
    const a = assignmentById(assignmentId);
    const waiting = data.roster.filter((s) => !s.removed && cellOf(s.id, assignmentId).status === 'graded').length;
    if (!window.confirm(`Return ${waiting} graded ${waiting === 1 ? 'assignment' : 'assignments'} for "${a.title}"? Students will see their grades and comments.`)) return;
    const { data: count, error } = await db.rpc('return_all_graded', { p_assignment: assignmentId });
    if (error) showToast(errorMessage(error), 'error');
    else showToast(`Returned ${count}.`, 'success');
    await refresh();
  }

  async function setRemoved(studentId, removed) {
    const s = studentById(studentId);
    if (removed && !window.confirm(`Remove ${s.name} from this class? Their work and grades are kept, and they can rejoin with the class code.`)) return;
    const { error } = await db.from('enrollments')
      .update({ removed_at: removed ? new Date().toISOString() : null })
      .eq('class_id', ctx.cls.id).eq('student_id', studentId);
    if (error) showToast(errorMessage(error), 'error');
    else showToast(removed ? `${s.name} was removed.` : `${s.name} is back in the class.`, 'success');
    await refresh();
  }

  async function copyJoinLink() {
    try {
      await navigator.clipboard.writeText(joinUrl(data.code));
      showToast('Join link copied.', 'success');
    } catch {
      showToast(`Couldn't copy. The code is ${data.code}.`, 'error');
    }
  }

  // ============================================================
  // EXCEL EXPORT (colors + comments as cell notes)
  // ============================================================
  async function exportExcel() {
    try {
      await loadScript(EXCELJS);
    } catch {
      showToast('The Excel tool could not load. Check your connection.', 'error');
      return;
    }
    const cols = columns();
    const students = visibleStudents();
    const workbook = new window.ExcelJS.Workbook();
    workbook.creator = 'Folio';
    const sheet = workbook.addWorksheet('Grades', { views: [{ state: 'frozen', xSplit: 1, ySplit: 1 }] });

    const header = sheet.addRow([
      'Student', 'Email',
      ...cols.map((a) => (a.points ? `${a.title} (${formatScore(a.points)} pts)` : `${a.title} (✓)`)),
      'Missing', 'Average',
    ]);
    header.font = { bold: true, color: { argb: 'FFEFE9D9' } };
    header.alignment = { vertical: 'middle', wrapText: true };
    header.height = 42;
    header.eachCell((cell) => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0C2340' } }; });

    for (const s of students) {
      const values = [s.removed ? `${s.name} (removed)` : s.name, s.email];
      const notes = [];
      for (const a of cols) {
        const cell = cellOf(s.id, a.id);
        let value = '';
        if (['graded', 'returned'].includes(cell.status)) value = cell.score != null ? Number(cell.score) : '✓';
        else if (cell.status !== 'not_due') value = STATUS_TEXT[cell.status];
        values.push(value);
        const note = [
          cell.comment,
          cell.is_late ? 'Turned in late.' : '',
          cell.status === 'graded' ? 'Not returned yet.' : '',
        ].filter(Boolean).join('\n');
        notes.push({ status: cell.status, note });
      }
      const missing = cols.filter((a) => cellOf(s.id, a.id).status === 'missing').length;
      const average = studentAverage(s.id, cols);
      values.push(missing, average == null ? '' : average / 100);

      const row = sheet.addRow(values);
      notes.forEach(({ status, note }, i) => {
        const cell = row.getCell(i + 3);
        if (EXCEL_FILLS[status]) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: EXCEL_FILLS[status] } };
        if (note) cell.note = note;
        cell.alignment = { horizontal: 'center' };
      });
      row.getCell(cols.length + 4).numFmt = '0%';
    }

    sheet.getColumn(1).width = 26;
    sheet.getColumn(2).width = 30;
    cols.forEach((_, i) => { sheet.getColumn(i + 3).width = 16; });
    sheet.getColumn(cols.length + 3).width = 10;
    sheet.getColumn(cols.length + 4).width = 10;

    // A key for the colors.
    const key = workbook.addWorksheet('Key');
    key.addRow(['Color', 'Meaning']).font = { bold: true };
    Object.entries(EXCEL_FILLS).forEach(([status, argb]) => {
      const row = key.addRow(['', STATUS_TEXT[status]]);
      row.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } };
    });
    key.addRow([]);
    key.addRow(['', 'Teacher comments are cell notes (hover a cell).']);
    key.getColumn(2).width = 48;

    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${ctx.cls.name.replace(/[\\/:*?"<>|]+/g, '-')} - grades - ${new Date().toISOString().slice(0, 10)}.xlsx`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
  }

  // ============================================================
  // EVENTS
  // ============================================================
  container.addEventListener('click', (event) => {
    const el = event.target.closest('[data-action]');
    if (!el || el.tagName === 'INPUT') return;
    const { action, student, assignment } = el.dataset;
    switch (action) {
      case 'open-cell': openCell(student, assignment); break;
      case 'return-all': returnAll(assignment); break;
      case 'remove-student': setRemoved(student, true); break;
      case 'restore-student': setRemoved(student, false); break;
      case 'copy-link': copyJoinLink(); break;
      case 'export': exportExcel(); break;
      default: break;
    }
  });

  container.addEventListener('change', (event) => {
    if (event.target.matches('[data-action="toggle-removed"]')) {
      showRemoved = event.target.checked;
      render();
    }
  });

  $('gradeForm').addEventListener('submit', (e) => { e.preventDefault(); saveGrade(false); });
  $('gradeSaveReturn').addEventListener('click', () => saveGrade(true));
  $('gradeClear').addEventListener('click', clearGrade);
  $('gradeReopen').addEventListener('click', reopen);
  $('gradePrev').addEventListener('click', () => moveStudent(-1));
  $('gradeNext').addEventListener('click', () => moveStudent(1));
  $('gradeFiles').addEventListener('click', openFileLink);

  return { render, refresh };
}
