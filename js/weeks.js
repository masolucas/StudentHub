// Weeks tab (modeled on the legacy course map).
// Everyone: optional sections, week rows with number, date, title, topic,
// badges, and the week's materials when it is open.
// Teachers also: edit weeks, holidays, lock / schedule / open, early access
// per student, materials, sections, tags, current week.
import { db } from './supabase.js';
import { esc, errorMessage, showToast, openModal, closeModal } from './ui.js';
import { formatDate, formatDateTime, toTimeString, toZonedInputValue, zonedInputToIso } from './time.js';
import { DOC_TYPES, DOC_TYPE_LABELS, detectDocType, makesCopy, canEmbed, isHttpsUrl } from './material-types.js';
import { swatchesHtml, checkSwatch, checkedSwatch, nextFreeColor } from './palette.js';
import { openViewer } from './viewer.js';
import { isOpenToClass, isOpenForStudent as studentCanSee } from './week-access.js';
import { assignmentCardHtml } from './assignments.js';
import { ACCEPT, DOCX, PPTX, uploadFile, deleteFile, hydrateFiles, openFileLink } from './files.js';

// Database doc_type for an uploaded file.
function docTypeOfFile(mimeType) {
  if (mimeType === 'application/pdf') return 'pdf';
  if (mimeType === DOCX) return 'docx';
  if (mimeType === PPTX) return 'pptx';
  return 'other';
}

const $ = (id) => document.getElementById(id);

const svg = (paths, size = 17, width = 2) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="${width}" aria-hidden="true">${paths}</svg>`;
const ICON = {
  doc: svg('<path d="M6 2h9l5 5v15H6z"/><path d="M15 2v5h5"/>', 17, 1.7),
  text: svg('<path d="M5 6h14M5 10h14M5 14h10M5 18h7"/>', 17, 1.8),
  lock: svg('<rect x="5" y="11" width="14" height="9" rx="1.5"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>', 17, 1.8),
  open: svg('<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16 9.5"/>', 17, 1.8),
  clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', 16, 2),
  chevron: svg('<path d="M6 9l6 6 6-6"/>', 16, 2),
  holiday: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>', 22, 1.8),
  edit: svg('<path d="M4 20h4L19 9l-4-4L4 16z"/>', 16, 2),
  users: svg('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.2a6.5 6.5 0 0 1 3.5 5.8"/>', 16, 2),
  plus: svg('<path d="M12 5v14M5 12h14"/>', 16, 2.2),
  up: svg('<path d="M6 15l6-6 6 6"/>', 16, 2),
  down: svg('<path d="M6 9l6 6 6-6"/>', 16, 2),
  eye: svg('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>', 16, 2),
  eyeOff: svg('<path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2"/>', 16, 2),
  trash: svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>', 16, 2),
  layers: svg('<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>', 16, 2),
  tag: svg('<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1.5"/>', 16, 2),
  frame: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/>', 14, 2),
  book: svg('<path d="M4 5.5C4 4.7 4.7 4 5.5 4H12v16H5.5C4.7 20 4 19.3 4 18.5zM20 5.5c0-.8-.7-1.5-1.5-1.5H12v16h6.5c.8 0 1.5-.7 1.5-1.5z"/>', 17, 1.8),
};

const TYPE_OPTION_LABELS = {
  pptx: 'PPTX — slides', docx: 'DOCX — document', pdf: 'PDF', html: 'HTML — web page or game', other: 'Other link',
};

export function createWeeksTab(container, ctx, reload) {
  const expanded = new Set();
  let firstRender = true;
  const editing = { weekId: null, materialId: null, sectionId: null };
  let typeTouched = false;

  const tz = () => ctx.cls.timezone;
  const weekById = (id) => ctx.weeks.find((w) => w.id === id);
  const weekLabel = (w) => (w.is_holiday ? 'Holiday' : `Week ${w.number}`);
  const weekName = (w) => w.title || weekLabel(w);
  const materialsOf = (weekId) => ctx.materials.get(weekId) ?? [];
  const assignmentsOf = (weekId) => ctx.assignments
    .filter((a) => a.week_id === weekId)
    .sort((a, b) => (a.due_at ?? '9999').localeCompare(b.due_at ?? '9999'));
  const hasContent = (w) => materialsOf(w.id).length > 0 || assignmentsOf(w.id).length > 0;

  function findMaterial(id) {
    for (const list of ctx.materials.values()) {
      const found = list.find((m) => m.id === id);
      if (found) return found;
    }
    return null;
  }

  const isOpenForStudent = (w) => studentCanSee(w, ctx);

  // ============================================================
  // RENDERING
  // ============================================================
  function render() {
    if (firstRender && ctx.currentWeekId) expanded.add(ctx.currentWeekId);
    firstRender = false;
    container.innerHTML = (ctx.isTeacher ? toolbarHtml() : '') + `<div class="weeks">${groupsHtml()}</div>`;
    hydrateFiles(container);
  }

  function toolbarHtml() {
    const override = ctx.cls.current_week_override ?? '';
    const options = ctx.weeks.map((w) => `<option value="${w.id}"${w.id === override ? ' selected' : ''}>${esc(weekLabel(w))} · ${formatDate(w.session_date)}</option>`).join('');
    return `
      <div class="weeks-toolbar">
        <button class="btn btn--secondary btn--sm" type="button" data-action="schedule-all">${ICON.clock}<span>Open each week at class time</span></button>
        <button class="btn btn--secondary btn--sm" type="button" data-action="manage-sections">${ICON.layers}<span>Sections</span></button>
        <button class="btn btn--secondary btn--sm" type="button" data-action="manage-tags">${ICON.tag}<span>Tags</span></button>
        <label class="toolbar-select">
          <span>Current week</span>
          <select data-action="current-week">
            <option value=""${override ? '' : ' selected'}>Automatic (by date)</option>
            ${options}
          </select>
        </label>
      </div>`;
  }

  // Consecutive weeks with the same section form one group.
  function groupsHtml() {
    const groups = [];
    for (const w of ctx.weeks) {
      const sectionId = w.section_id ?? null;
      const last = groups[groups.length - 1];
      if (last && last.sectionId === sectionId) last.weeks.push(w);
      else groups.push({ sectionId, weeks: [w] });
    }

    const partNumbers = new Map();
    return groups.map((g) => {
      const rows = g.weeks.map(weekHtml).join('');
      const section = g.sectionId && ctx.sections.find((s) => s.id === g.sectionId);
      if (!section) return `<div class="week-list">${rows}</div>`;

      if (!partNumbers.has(section.id)) partNumbers.set(section.id, partNumbers.size + 1);
      const numbers = g.weeks.filter((w) => w.number).map((w) => w.number);
      const range = !numbers.length ? ''
        : numbers.length === 1 ? `Week ${numbers[0]}` : `Weeks ${numbers[0]}–${numbers[numbers.length - 1]}`;
      return `
        <section class="week-section">
          <header class="week-section-head">
            <div>
              <p class="week-section-eyebrow">Part ${partNumbers.get(section.id)}</p>
              <h2>${esc(section.title)}</h2>
            </div>
            <span class="week-section-range">${range}</span>
          </header>
          ${section.description ? `<p class="week-section-desc">${esc(section.description)}</p>` : ''}
          <div class="week-list">${rows}</div>
        </section>`;
    }).join('');
  }

  function badgesHtml(w) {
    let html = '';
    if (w.id === ctx.currentWeekId) html += '<span class="wbadge wbadge--current">Current week</span>';
    if (w.is_holiday) html += '<span class="wbadge wbadge--holiday">Holiday</span>';
    // From the week's label, or from an assignment marked as an assessment.
    const assessment = w.assessment_label || assignmentsOf(w.id).find((a) => a.is_assessment)?.title;
    if (assessment && !w.is_holiday) html += `<span class="wbadge wbadge--assess" title="${esc(assessment)}">Assessment</span>`;
    for (const tagId of ctx.weekTags.get(w.id) ?? []) {
      const tag = ctx.tags.find((t) => t.id === tagId);
      if (tag) html += `<span class="wbadge wbadge--tag cls-${tag.color}">${esc(tag.label)}</span>`;
    }
    return html;
  }

  // Teachers: what students currently see.
  function accessChipHtml(w) {
    if (w.is_holiday) return '';
    let chip;
    if (isOpenToClass(w)) {
      chip = `<span class="access-chip access-chip--open">${ICON.open}Open</span>`;
    } else if (w.lock_state === 'scheduled') {
      chip = `<span class="access-chip access-chip--scheduled">${ICON.clock}Opens ${esc(formatDateTime(w.unlock_at, tz()))}</span>`;
    } else {
      chip = `<span class="access-chip">${ICON.lock}Locked</span>`;
    }
    const early = ctx.unlocks.get(w.id)?.size ?? 0;
    if (early && !chip.includes('access-chip--open')) {
      chip += `<span class="access-chip access-chip--early">${ICON.users}${early} early</span>`;
    }
    return chip;
  }

  // Students: open, opens at…, or locked.
  function studentStatusHtml(w) {
    if (w.is_holiday) return '';
    if (isOpenForStudent(w)) return `<span class="week-status week-status--open" title="Open">${ICON.open}<span class="visually-hidden">Open</span></span>`;
    if (w.lock_state === 'scheduled') return `<span class="week-status week-status--soon">${ICON.clock}Opens ${esc(formatDateTime(w.unlock_at, tz()))}</span>`;
    return `<span class="week-status" title="Locked">${ICON.lock}<span class="visually-hidden">Locked</span></span>`;
  }

  function weekHtml(w) {
    const canOpen = ctx.isTeacher || isOpenForStudent(w);
    const isOpen = canOpen && expanded.has(w.id);
    const classes = ['week'];
    if (w.id === ctx.currentWeekId) classes.push('is-current');
    if (w.is_holiday) classes.push('is-holiday');
    else if (!canOpen) classes.push('is-locked');
    if (isOpen) classes.push('is-open');

    const num = w.is_holiday
      ? `<span class="week-num week-num--holiday">${ICON.holiday}</span>`
      : `<span class="week-num">${String(w.number ?? '').padStart(2, '0')}</span>`;
    const title = w.is_holiday ? (w.title || 'No class this week') : (w.title || `Week ${w.number}`);
    const topic = w.is_holiday ? '' : (w.topic || '');
    const status = ctx.isTeacher ? accessChipHtml(w) : studentStatusHtml(w);
    const inner = `
      ${num}
      <span class="week-titles">
        <span class="week-date">${formatDate(w.session_date)}</span>
        <span class="week-title">${esc(title)}</span>
        ${topic ? `<span class="week-topic">${esc(topic)}</span>` : ''}
      </span>
      <span class="week-badges">${badgesHtml(w)}</span>
      <span class="week-side">${status}${canOpen ? `<span class="week-chevron">${ICON.chevron}</span>` : ''}</span>`;

    const head = canOpen
      ? `<button class="week-head" type="button" data-action="toggle-week" data-week="${w.id}" aria-expanded="${isOpen}" aria-controls="week-body-${w.id}">${inner}</button>`
      : `<div class="week-head">${inner}</div>`;
    const body = canOpen
      ? `<div class="week-body" id="week-body-${w.id}"${isOpen ? '' : ' hidden'}>${bodyHtml(w)}</div>`
      : '';
    return `<article class="${classes.join(' ')}" data-week-row="${w.id}">${head}${body}</article>`;
  }

  function bodyHtml(w) {
    let html = '';
    if (ctx.isTeacher) {
      html += `
        <div class="week-actions">
          <button class="btn btn--secondary btn--sm" type="button" data-action="edit-week" data-week="${w.id}">${ICON.edit}<span>Edit week</span></button>
          <button class="btn btn--secondary btn--sm" type="button" data-action="access-week" data-week="${w.id}">${ICON.users}<span>Who can see it</span></button>
          <button class="btn btn--primary btn--sm" type="button" data-action="add-material" data-week="${w.id}">${ICON.plus}<span>Add material</span></button>
          <button class="btn btn--primary btn--sm" type="button" data-action="add-assignment" data-week="${w.id}">${ICON.plus}<span>Add assignment</span></button>
        </div>`;
    }
    if (w.is_holiday) {
      html += `<p class="week-note">${ctx.isTeacher && hasContent(w)
        ? 'Holiday: students can’t see the materials below until you turn the holiday off.'
        : 'No class this week.'}</p>`;
    }
    if (w.assessment_label && !w.is_holiday) {
      html += `<p class="week-assessment"><strong>Assessment:</strong> ${esc(w.assessment_label)}</p>`;
    }

    // "This week's reading" chips (classes with a library).
    if (ctx.cls.has_library && !w.is_holiday) {
      const books = ctx.books.filter((b) => b.week_id === w.id);
      if (books.length) {
        html += `<div class="reading-chips">${books.map((b) => `
          <button class="reading-chip" type="button" data-action="open-book" data-book="${b.id}">
            ${ICON.book}<span>This week's reading: <strong>${esc(b.title)}</strong></span>
          </button>`).join('')}</div>`;
      }
    }

    const assignments = assignmentsOf(w.id);
    if (assignments.length) {
      html += `<div class="week-assignments">${assignments.map((a) => assignmentCardHtml(a, ctx)).join('')}</div>`;
    }

    const materials = materialsOf(w.id);
    if (materials.length) {
      html += `<div class="materials">${materials.map((m, i) => materialHtml(m, i, materials.length)).join('')}</div>`;
    } else if (!w.is_holiday && !assignments.length) {
      html += `<p class="week-empty">${ctx.isTeacher
        ? 'No materials yet.'
        : 'Materials for this week haven’t been posted yet. Check back soon.'}</p>`;
    }
    return html;
  }

  function materialHtml(m, index, count) {
    let main;
    if (m.kind === 'text') {
      main = `
        <div class="material-main">
          <span class="material-icon">${ICON.text}</span>
          <span class="material-text">
            <span class="material-name">${esc(m.title)}</span>
            <span class="material-body">${esc(m.body)}</span>
          </span>
        </div>`;
    } else if (m.kind === 'file') {
      // Uploaded file: the link is filled in by hydrateFiles() (short-lived B2 link).
      main = `
        <a class="material-main" href="#" data-file-key="${esc(m.file_key)}" target="_blank" rel="noopener">
          <span class="material-icon">${ICON.doc}</span>
          <span class="material-text">
            <span class="material-name">${esc(m.title)}</span>
            <span class="material-type">${esc(DOC_TYPE_LABELS[m.doc_type] ?? 'FILE')} · File</span>
          </span>
        </a>`;
    } else {
      const embedded = m.open_mode === 'embed' && canEmbed(m.url);
      const details = [DOC_TYPE_LABELS[m.doc_type] ?? 'LINK'];
      if (makesCopy(m.url)) details.push('Makes your own copy');
      main = `
        <a class="material-main" href="${esc(m.url)}" target="_blank" rel="noopener"${embedded ? ` data-action="open-embed" data-material="${m.id}"` : ''}>
          <span class="material-icon">${ICON.doc}</span>
          <span class="material-text">
            <span class="material-name">${esc(m.title)}</span>
            <span class="material-type">${esc(details.join(' · '))}${embedded ? ` <span class="material-embed" title="Opens inside Folio">${ICON.frame}</span>` : ''}</span>
          </span>
        </a>`;
    }

    let teacherBits = '';
    if (ctx.isTeacher) {
      const name = esc(m.title);
      teacherBits = `
        ${m.hidden ? '<span class="material-hidden-chip">Hidden</span>' : ''}
        <div class="material-actions">
          <button class="icon-btn icon-btn--sm" type="button" data-action="move-material" data-dir="-1" data-material="${m.id}" aria-label="Move ${name} up"${index === 0 ? ' disabled' : ''}>${ICON.up}</button>
          <button class="icon-btn icon-btn--sm" type="button" data-action="move-material" data-dir="1" data-material="${m.id}" aria-label="Move ${name} down"${index === count - 1 ? ' disabled' : ''}>${ICON.down}</button>
          <button class="icon-btn icon-btn--sm" type="button" data-action="edit-material" data-material="${m.id}" aria-label="Edit ${name}">${ICON.edit}</button>
          <button class="icon-btn icon-btn--sm" type="button" data-action="toggle-hidden" data-material="${m.id}" aria-label="${m.hidden ? `Show ${name} to students` : `Hide ${name} from students`}">${m.hidden ? ICON.eye : ICON.eyeOff}</button>
          <button class="icon-btn icon-btn--sm icon-btn--danger" type="button" data-action="delete-material" data-material="${m.id}" aria-label="Delete ${name}">${ICON.trash}</button>
        </div>`;
    }

    const classes = ['material', `type-${m.doc_type}`];
    if (m.kind === 'text') classes.push('material--text');
    if (m.hidden) classes.push('is-hidden');
    return `<div class="${classes.join(' ')}">${main}${teacherBits}</div>`;
  }

  // Expand/collapse without re-rendering the whole list.
  function toggleWeek(weekId) {
    const row = container.querySelector(`[data-week-row="${weekId}"]`);
    if (!row) return;
    const open = !expanded.has(weekId);
    if (open) expanded.add(weekId);
    else expanded.delete(weekId);
    row.classList.toggle('is-open', open);
    row.querySelector('.week-head')?.setAttribute('aria-expanded', String(open));
    const body = row.querySelector('.week-body');
    if (body) body.hidden = !open;
  }

  // ============================================================
  // SMALL HELPERS FOR FORMS
  // ============================================================
  function showFormError(prefix, message) {
    $(`${prefix}ErrorText`).textContent = message;
    $(`${prefix}Error`).hidden = false;
  }

  async function run(request) {
    const { data, error } = await request;
    if (error) throw error;
    return data;
  }

  // ============================================================
  // EDIT WEEK
  // ============================================================
  function openWeekForm(weekId) {
    const w = weekById(weekId);
    editing.weekId = weekId;
    $('weekFormTitle').textContent = `Edit ${weekLabel(w).toLowerCase()}`;
    $('weekFormDate').textContent = formatDate(w.session_date, { year: true });
    $('weekHoliday').checked = w.is_holiday;
    $('weekTitle').value = w.title ?? '';
    $('weekTopic').value = w.topic ?? '';
    $('weekAssessment').value = w.assessment_label ?? '';

    const selected = ctx.weekTags.get(w.id) ?? new Set();
    $('weekTags').innerHTML = ctx.tags.length
      ? ctx.tags.map((t) => `
          <label class="tag-check cls-${t.color}">
            <input type="checkbox" value="${t.id}"${selected.has(t.id) ? ' checked' : ''}>
            <span>${esc(t.label)}</span>
          </label>`).join('')
      : '<p class="field-help">No tags yet. Use the Tags button above the weeks to add some.</p>';

    updateHolidayWarning();
    $('weekFormError').hidden = true;
    openModal($('weekOverlay'));
  }

  function updateHolidayWarning() {
    const w = weekById(editing.weekId);
    $('weekHolidayWarning').hidden = !($('weekHoliday').checked && w && hasContent(w));
  }

  async function submitWeekForm(event) {
    event.preventDefault();
    const w = weekById(editing.weekId);
    $('weekFormError').hidden = true;
    const button = $('weekFormSubmit');
    button.disabled = true;

    try {
      await run(db.from('weeks').update({
        is_holiday: $('weekHoliday').checked,
        title: $('weekTitle').value.trim() || null,
        topic: $('weekTopic').value.trim() || null,
        assessment_label: $('weekAssessment').value.trim() || null,
      }).eq('id', w.id));

      const before = ctx.weekTags.get(w.id) ?? new Set();
      const after = new Set([...$('weekTags').querySelectorAll('input:checked')].map((i) => i.value));
      const toAdd = [...after].filter((id) => !before.has(id));
      const toRemove = [...before].filter((id) => !after.has(id));
      if (toAdd.length) {
        await run(db.from('week_tags').insert(toAdd.map((tagId) => ({ week_id: w.id, tag_id: tagId, class_id: ctx.cls.id }))));
      }
      if (toRemove.length) {
        await run(db.from('week_tags').delete().eq('week_id', w.id).in('tag_id', toRemove));
      }
    } catch (err) {
      showFormError('weekForm', errorMessage(err));
      button.disabled = false;
      return;
    }

    button.disabled = false;
    closeModal($('weekOverlay'));
    showToast('Week saved.', 'success');
    await reload();
  }

  // ============================================================
  // WEEK ACCESS: locked / scheduled / open + early access
  // ============================================================
  function accessState() {
    return $('accessForm').querySelector('input[name="accessState"]:checked')?.value ?? 'locked';
  }

  function updateAccessAt() {
    $('accessAtField').hidden = accessState() !== 'scheduled';
  }

  function openAccessForm(weekId) {
    const w = weekById(weekId);
    editing.weekId = weekId;
    $('accessFormWeek').textContent = `${weekName(w)} · ${formatDate(w.session_date)}`;
    $('accessForm').querySelector(`input[name="accessState"][value="${w.lock_state}"]`).checked = true;
    // The picker defaults to the class start time on the week's date.
    $('accessAt').value = w.unlock_at
      ? toZonedInputValue(w.unlock_at, tz())
      : `${w.session_date}T${toTimeString(ctx.cls.start)}`;
    $('accessTzHelp').textContent = `${tz().split('/').pop().replace(/_/g, ' ')} time`;

    const early = ctx.unlocks.get(w.id) ?? new Set();
    $('accessStudents').innerHTML = ctx.roster.length
      ? ctx.roster.map((s) => `
          <label class="check-row check-row--compact">
            <input type="checkbox" value="${s.id}"${early.has(s.id) ? ' checked' : ''}>
            <span>${esc(s.name)}</span>
          </label>`).join('')
      : '<p class="field-help">No students have joined yet.</p>';

    updateAccessAt();
    $('accessFormError').hidden = true;
    openModal($('accessOverlay'));
  }

  async function submitAccessForm(event) {
    event.preventDefault();
    const w = weekById(editing.weekId);
    const state = accessState();
    $('accessFormError').hidden = true;
    if (state === 'scheduled' && !$('accessAt').value) {
      showFormError('accessForm', 'Pick the date and time when the week opens.');
      return;
    }

    const button = $('accessFormSubmit');
    button.disabled = true;
    try {
      await run(db.from('weeks').update({
        lock_state: state,
        unlock_at: state === 'scheduled' ? zonedInputToIso($('accessAt').value, tz()) : null,
      }).eq('id', w.id));

      const before = ctx.unlocks.get(w.id) ?? new Set();
      const after = new Set([...$('accessStudents').querySelectorAll('input:checked')].map((i) => i.value));
      const toAdd = [...after].filter((id) => !before.has(id));
      const toRemove = [...before].filter((id) => !after.has(id));
      if (toAdd.length) {
        await run(db.from('week_unlocks').insert(toAdd.map((studentId) => ({ week_id: w.id, class_id: ctx.cls.id, student_id: studentId }))));
      }
      if (toRemove.length) {
        await run(db.from('week_unlocks').delete().eq('week_id', w.id).in('student_id', toRemove));
      }
    } catch (err) {
      showFormError('accessForm', errorMessage(err));
      button.disabled = false;
      return;
    }

    button.disabled = false;
    closeModal($('accessOverlay'));
    showToast('Saved.', 'success');
    await reload();
  }

  // ============================================================
  // MATERIALS
  // ============================================================
  function materialKind() {
    return $('materialForm').querySelector('input[name="materialKind"]:checked')?.value ?? 'link';
  }

  function updateMaterialFields() {
    const kind = materialKind();
    $('materialLinkFields').hidden = kind !== 'link';
    $('materialTextFields').hidden = kind !== 'text';
    $('materialFileFields').hidden = kind !== 'file';

    const url = $('materialUrl').value.trim();
    if (!typeTouched && url) $('materialType').value = detectDocType(url);
    const copy = makesCopy(url);
    $('materialCopyHelp').hidden = !copy;
    const embedOption = $('materialOpenMode').querySelector('option[value="embed"]');
    embedOption.disabled = copy;
    if (copy) $('materialOpenMode').value = 'new_tab';
  }

  function openMaterialForm(weekId, materialId = null) {
    const w = weekById(weekId);
    const m = materialId ? findMaterial(materialId) : null;
    editing.weekId = weekId;
    editing.materialId = materialId;
    typeTouched = Boolean(m);

    $('materialFormTitle').textContent = m ? 'Edit material' : 'Add material';
    $('materialFormWeek').textContent = `${weekName(w)} · ${formatDate(w.session_date)}`;
    $('materialForm').querySelector(`input[name="materialKind"][value="${m?.kind ?? 'link'}"]`).checked = true;
    $('materialTitle').value = m?.title ?? '';
    $('materialUrl').value = m?.url ?? '';
    $('materialBody').value = m?.body ?? '';
    $('materialType').value = m?.doc_type ?? 'other';
    $('materialOpenMode').value = m?.open_mode ?? 'new_tab';
    $('materialHidden').checked = m?.hidden ?? false;
    $('materialFile').value = '';
    $('materialCurrentFile').hidden = m?.kind !== 'file';
    $('materialCurrentFile').textContent = m?.kind === 'file' ? `Current file: ${m.file_name}. Choose a new file to replace it.` : '';
    $('materialUploadState').hidden = true;
    $('materialFormError').hidden = true;
    updateMaterialFields();
    openModal($('materialOverlay'));
  }

  async function submitMaterialForm(event) {
    event.preventDefault();
    $('materialFormError').hidden = true;
    const kind = materialKind();
    const title = $('materialTitle').value.trim();
    const url = $('materialUrl').value.trim();
    const body = $('materialBody').value.trim();

    const existingMaterial = editing.materialId ? findMaterial(editing.materialId) : null;
    const file = $('materialFile').files[0] ?? null;
    const keepsFile = existingMaterial?.kind === 'file';

    if (!title) return showFormError('materialForm', 'Please type a title.');
    if (kind === 'link' && !isHttpsUrl(url)) return showFormError('materialForm', 'The link must start with https://');
    if (kind === 'text' && !body) return showFormError('materialForm', 'Please type the text.');
    if (kind === 'file' && !file && !keepsFile) return showFormError('materialForm', 'Choose a file to upload.');

    const button = $('materialFormSubmit');
    button.disabled = true;

    // Upload first, so the row can point at the file.
    let upload = null;
    if (kind === 'file' && file) {
      const progress = $('materialUploadState');
      progress.hidden = false;
      progress.textContent = 'Uploading… 0%';
      try {
        upload = await uploadFile({
          purpose: 'material',
          classId: ctx.cls.id,
          file,
          onProgress: (p) => { progress.textContent = `Uploading… ${Math.round(p * 100)}%`; },
        });
        progress.textContent = 'Uploaded ✓';
      } catch (err) {
        progress.hidden = true;
        showFormError('materialForm', errorMessage(err));
        button.disabled = false;
        return;
      }
    }

    const fileFields = kind === 'file'
      ? {
        file_key: upload?.key ?? existingMaterial.file_key,
        file_name: upload?.fileName ?? existingMaterial.file_name,
        size_bytes: upload?.size ?? existingMaterial.size_bytes,
        mime_type: upload?.mimeType ?? existingMaterial.mime_type,
      }
      : { file_key: null, file_name: null, size_bytes: null, mime_type: null };

    const payload = {
      kind,
      title,
      url: kind === 'link' ? url : null,
      body: kind === 'text' ? body : null,
      doc_type: kind === 'link' ? $('materialType').value : kind === 'file' ? docTypeOfFile(fileFields.mime_type) : 'other',
      open_mode: kind === 'link' ? $('materialOpenMode').value : 'new_tab',
      hidden: $('materialHidden').checked,
      ...fileFields,
    };

    try {
      if (editing.materialId) {
        await run(db.from('materials').update(payload).eq('id', editing.materialId));
      } else {
        const existing = materialsOf(editing.weekId);
        const nextOrder = existing.length ? Math.max(...existing.map((m) => m.sort_order)) + 1 : 0;
        await run(db.from('materials').insert({ ...payload, class_id: ctx.cls.id, week_id: editing.weekId, sort_order: nextOrder }));
      }
    } catch (err) {
      if (upload) await deleteFile(upload.key);
      showFormError('materialForm', errorMessage(err));
      button.disabled = false;
      return;
    }

    // The old file is no longer used: replaced, or the material changed kind.
    if (keepsFile && (upload || kind !== 'file')) await deleteFile(existingMaterial.file_key);

    button.disabled = false;
    closeModal($('materialOverlay'));
    expanded.add(editing.weekId);
    showToast(editing.materialId ? 'Material saved.' : 'Material added.', 'success');
    await reload();
  }

  async function moveMaterial(materialId, direction) {
    const m = findMaterial(materialId);
    const list = [...materialsOf(m.week_id)];
    const i = list.findIndex((x) => x.id === materialId);
    const j = i + direction;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];

    const results = await Promise.all(list
      .map((x, index) => (x.sort_order !== index ? db.from('materials').update({ sort_order: index }).eq('id', x.id) : null))
      .filter(Boolean));
    const failed = results.find((r) => r.error);
    if (failed) showToast(errorMessage(failed.error), 'error');
    await reload();
  }

  async function toggleHidden(materialId) {
    const m = findMaterial(materialId);
    const { error } = await db.from('materials').update({ hidden: !m.hidden }).eq('id', materialId);
    if (error) showToast(errorMessage(error), 'error');
    else showToast(m.hidden ? 'Students can see it now.' : 'Hidden from students.', 'success');
    await reload();
  }

  async function deleteMaterial(materialId) {
    const m = findMaterial(materialId);
    if (!window.confirm(`Delete "${m.title}"?`)) return;
    const { error } = await db.from('materials').delete().eq('id', materialId);
    if (error) {
      showToast(errorMessage(error), 'error');
    } else {
      if (m.kind === 'file') await deleteFile(m.file_key);
      showToast('Material deleted.', 'success');
    }
    await reload();
  }

  // ============================================================
  // CLASS-WIDE TOOLS
  // ============================================================
  async function scheduleAll() {
    if (!window.confirm('Every week that is not open yet will open at class time on its date. Continue?')) return;
    const { data: count, error } = await db.rpc('schedule_all_weeks', { p_class: ctx.cls.id });
    if (error) showToast(errorMessage(error), 'error');
    else showToast(`${count} ${count === 1 ? 'week' : 'weeks'} will open at class time.`, 'success');
    await reload();
  }

  async function setCurrentWeek(weekId) {
    const value = weekId || null;
    const { error } = await db.from('classes').update({ current_week_override: value }).eq('id', ctx.cls.id);
    if (error) {
      showToast(errorMessage(error), 'error');
      return;
    }
    ctx.cls.current_week_override = value;
    showToast(value ? 'Current week set.' : 'Current week follows the date again.', 'success');
    await reload();
  }

  // ============================================================
  // SECTIONS: a title, description and a range of weeks
  // ============================================================
  const numberedWeeks = () => ctx.weeks.filter((w) => !w.is_holiday);

  function sectionRange(sectionId) {
    const numbers = ctx.weeks.filter((w) => w.section_id === sectionId && w.number).map((w) => w.number);
    if (!numbers.length) return 'No weeks';
    return numbers.length === 1 ? `Week ${numbers[0]}` : `Weeks ${Math.min(...numbers)}–${Math.max(...numbers)}`;
  }

  function sortedSections() {
    const firstDate = (s) => ctx.weeks.find((w) => w.section_id === s.id)?.session_date ?? '9999';
    return [...ctx.sections].sort((a, b) => firstDate(a).localeCompare(firstDate(b)));
  }

  function renderSectionsList() {
    const sections = sortedSections();
    $('sectionsList').innerHTML = sections.length
      ? sections.map((s) => `
          <li class="manage-item">
            <div>
              <p class="manage-item-title">${esc(s.title)}</p>
              <p class="manage-item-sub">${sectionRange(s.id)}</p>
            </div>
            <div class="manage-item-actions">
              <button class="btn btn--ghost btn--sm" type="button" data-section-edit="${s.id}">Edit</button>
              <button class="btn btn--ghost btn--sm btn--danger-text" type="button" data-section-delete="${s.id}">Delete</button>
            </div>
          </li>`).join('')
      : '<li class="manage-empty">No sections yet. Weeks are listed without groups.</li>';

    const options = numberedWeeks().map((w) => `<option value="${w.id}">Week ${w.number} · ${formatDate(w.session_date)}</option>`).join('');
    $('sectionFrom').innerHTML = options;
    $('sectionTo').innerHTML = options;
  }

  function resetSectionForm() {
    editing.sectionId = null;
    $('sectionForm').reset();
    $('sectionFormTitle').textContent = 'Add a section';
    $('sectionFormSubmit').textContent = 'Add section';
    $('sectionFormCancel').hidden = true;
    $('sectionFormError').hidden = true;
    const weeks = numberedWeeks();
    if (weeks.length) {
      $('sectionFrom').value = weeks[0].id;
      $('sectionTo').value = weeks[weeks.length - 1].id;
    }
  }

  function openSections() {
    renderSectionsList();
    resetSectionForm();
    openModal($('sectionsOverlay'));
  }

  function editSection(sectionId) {
    const s = ctx.sections.find((x) => x.id === sectionId);
    const inSection = numberedWeeks().filter((w) => w.section_id === sectionId);
    editing.sectionId = sectionId;
    $('sectionTitle').value = s.title;
    $('sectionDescription').value = s.description ?? '';
    if (inSection.length) {
      $('sectionFrom').value = inSection[0].id;
      $('sectionTo').value = inSection[inSection.length - 1].id;
    }
    $('sectionFormTitle').textContent = 'Edit section';
    $('sectionFormSubmit').textContent = 'Save section';
    $('sectionFormCancel').hidden = false;
    $('sectionFormError').hidden = true;
    $('sectionTitle').focus();
  }

  async function submitSectionForm(event) {
    event.preventDefault();
    $('sectionFormError').hidden = true;
    const title = $('sectionTitle').value.trim();
    const description = $('sectionDescription').value.trim() || null;
    const from = weekById($('sectionFrom').value);
    const to = weekById($('sectionTo').value);

    if (!title) return showFormError('sectionForm', 'Please type a title.');
    if (!from || !to) return showFormError('sectionForm', 'Choose the first and last week.');
    if (from.session_date > to.session_date) return showFormError('sectionForm', 'The first week must come before the last week.');

    try {
      let sectionId = editing.sectionId;
      if (sectionId) {
        await run(db.from('sections').update({ title, description }).eq('id', sectionId));
        await run(db.from('weeks').update({ section_id: null }).eq('section_id', sectionId));
      } else {
        const nextNumber = ctx.sections.length ? Math.max(...ctx.sections.map((s) => s.number)) + 1 : 1;
        const created = await run(db.from('sections')
          .insert({ class_id: ctx.cls.id, number: nextNumber, title, description })
          .select('id').single());
        sectionId = created.id;
      }
      // Every week (holidays too) between the first and last week joins the section.
      await run(db.from('weeks').update({ section_id: sectionId })
        .eq('class_id', ctx.cls.id)
        .gte('session_date', from.session_date)
        .lte('session_date', to.session_date));
    } catch (err) {
      showFormError('sectionForm', errorMessage(err));
      return;
    }

    showToast(editing.sectionId ? 'Section saved.' : 'Section added.', 'success');
    await reload();
    renderSectionsList();
    resetSectionForm();
  }

  async function deleteSection(sectionId) {
    const s = ctx.sections.find((x) => x.id === sectionId);
    if (!window.confirm(`Delete the section "${s.title}"? The weeks stay; they just won't be grouped.`)) return;
    const { error } = await db.from('sections').delete().eq('id', sectionId);
    if (error) showToast(errorMessage(error), 'error');
    else showToast('Section deleted.', 'success');
    await reload();
    renderSectionsList();
    resetSectionForm();
  }

  // ============================================================
  // TAGS
  // ============================================================
  function renderTagsList() {
    $('tagsList').innerHTML = ctx.tags.length
      ? ctx.tags.map((t) => `
          <li class="manage-item">
            <span class="wbadge wbadge--tag cls-${t.color}">${esc(t.label)}</span>
            <div class="manage-item-actions">
              <button class="btn btn--ghost btn--sm btn--danger-text" type="button" data-tag-delete="${t.id}">Delete</button>
            </div>
          </li>`).join('')
      : '<li class="manage-empty">No tags yet.</li>';
  }

  function resetTagForm() {
    $('tagForm').reset();
    $('tagFormError').hidden = true;
    checkSwatch($('tagColors'), nextFreeColor(ctx.tags.map((t) => t.color)));
  }

  function openTags() {
    renderTagsList();
    resetTagForm();
    openModal($('tagsOverlay'));
  }

  async function submitTagForm(event) {
    event.preventDefault();
    $('tagFormError').hidden = true;
    const label = $('tagLabel').value.trim();
    if (!label) return showFormError('tagForm', 'Please type a label.');

    const { error } = await db.from('class_tags').insert({
      class_id: ctx.cls.id, label, color: checkedSwatch($('tagColors')), sort_order: ctx.tags.length,
    });
    if (error) {
      showFormError('tagForm', error.code === '23505' ? 'That tag already exists.' : errorMessage(error));
      return;
    }
    showToast('Tag added.', 'success');
    await reload();
    renderTagsList();
    resetTagForm();
  }

  async function deleteTag(tagId) {
    const t = ctx.tags.find((x) => x.id === tagId);
    if (!window.confirm(`Delete the tag "${t.label}"? It will be removed from every week.`)) return;
    const { error } = await db.from('class_tags').delete().eq('id', tagId);
    if (error) showToast(errorMessage(error), 'error');
    else showToast('Tag deleted.', 'success');
    await reload();
    renderTagsList();
  }

  // ============================================================
  // EVENTS
  // ============================================================
  container.addEventListener('click', (event) => {
    if (event.target.closest('a[data-file-key]')) {
      openFileLink(event);
      return;
    }
    const el = event.target.closest('[data-action]');
    if (!el || el.tagName === 'SELECT') return;
    const { action, week, material } = el.dataset;

    switch (action) {
      case 'toggle-week': toggleWeek(week); break;
      case 'open-embed': {
        event.preventDefault();
        const m = findMaterial(material);
        if (m) openViewer(m.title, m.url);
        break;
      }
      case 'open-book': ctx.openBook?.(el.dataset.book); break;
      case 'edit-week': openWeekForm(week); break;
      case 'access-week': openAccessForm(week); break;
      case 'add-material': openMaterialForm(week); break;
      case 'edit-material': openMaterialForm(findMaterial(material).week_id, material); break;
      case 'move-material': moveMaterial(material, Number(el.dataset.dir)); break;
      case 'toggle-hidden': toggleHidden(material); break;
      case 'delete-material': deleteMaterial(material); break;
      case 'schedule-all': scheduleAll(); break;
      case 'manage-sections': openSections(); break;
      case 'manage-tags': openTags(); break;
      default:
        ctx.assignmentsTab?.handleAction(action, el.dataset.assignment, week);
        break;
    }
  });

  container.addEventListener('change', (event) => {
    if (event.target.matches('[data-action="current-week"]')) setCurrentWeek(event.target.value);
  });

  if (ctx.isTeacher) {
    $('materialType').innerHTML = DOC_TYPES.map((t) => `<option value="${t}">${TYPE_OPTION_LABELS[t]}</option>`).join('');
    $('materialFile').accept = ACCEPT.material;
    $('tagColors').innerHTML = swatchesHtml('tagColor');

    $('weekForm').addEventListener('submit', submitWeekForm);
    $('weekHoliday').addEventListener('change', updateHolidayWarning);

    $('accessForm').addEventListener('submit', submitAccessForm);
    $('accessForm').addEventListener('change', (e) => { if (e.target.name === 'accessState') updateAccessAt(); });

    $('materialForm').addEventListener('submit', submitMaterialForm);
    $('materialForm').addEventListener('change', (e) => { if (e.target.name === 'materialKind') updateMaterialFields(); });
    $('materialUrl').addEventListener('input', updateMaterialFields);
    $('materialType').addEventListener('change', () => { typeTouched = true; });

    $('sectionForm').addEventListener('submit', submitSectionForm);
    $('sectionFormCancel').addEventListener('click', resetSectionForm);
    $('sectionsList').addEventListener('click', (e) => {
      const edit = e.target.closest('[data-section-edit]');
      const del = e.target.closest('[data-section-delete]');
      if (edit) editSection(edit.dataset.sectionEdit);
      if (del) deleteSection(del.dataset.sectionDelete);
    });

    $('tagForm').addEventListener('submit', submitTagForm);
    $('tagsList').addEventListener('click', (e) => {
      const del = e.target.closest('[data-tag-delete]');
      if (del) deleteTag(del.dataset.tagDelete);
    });
  }

  return { render };
}
