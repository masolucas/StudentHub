// Class page: navy header, tabs, and the Weeks tab.
// Teachers manage the class; students see what is open to them (RLS decides).
import { db, requireSession, getProfile } from '../supabase.js';
import { registerServiceWorker } from '../pwa.js';
import { renderNavbar } from '../nav.js';
import { errorMessage, showToast, openModal, closeModal } from '../ui.js';
import { DAYS, toMinutes, toTimeString, formatTime, formatRange, timeOptions } from '../time.js';
import { isHttpsUrl } from '../material-types.js';
import { swatchesHtml, checkSwatch, checkedSwatch } from '../palette.js';
import { createWeeksTab } from '../weeks.js';

registerServiceWorker();

const $ = (id) => document.getElementById(id);
const classId = new URLSearchParams(window.location.search).get('id');

// Shared with the Weeks tab.
const ctx = {
  user: null,
  profile: null,
  cls: null,
  isTeacher: false,
  weeks: [],
  sections: [],
  tags: [],
  weekTags: new Map(),    // week id → Set of tag ids
  materials: new Map(),   // week id → materials in order
  unlocks: new Map(),     // week id → Set of student ids (students only see their own)
  roster: [],             // teachers only: [{ id, name }]
  currentWeekId: null,
};

let weeksTab = null;

const TAB_ICONS = {
  weeks: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>',
  library: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 5.5C4 4.7 4.7 4 5.5 4H12v16H5.5C4.7 20 4 19.3 4 18.5zM20 5.5c0-.8-.7-1.5-1.5-1.5H12v16h6.5c.8 0 1.5-.7 1.5-1.5z"/></svg>',
  work: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4h6v3H9zM9 12h6M9 16h4"/></svg>',
  students: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.2a6.5 6.5 0 0 1 3.5 5.8"/></svg>',
};

// ============================================================
// LOADING
// ============================================================
async function query(request) {
  const { data, error } = await request;
  if (error) throw error;
  return data;
}

async function loadClass() {
  const data = await query(db
    .from('classes')
    .select(`id, term_id, name, program_eyebrow, subtitle, level, syllabus_url, day_of_week, start_time, end_time,
             timezone, color, has_library, auto_unlock_at_class_time, current_week_override,
             terms(name, status), class_teachers(role, teacher_id, profiles(full_name, preferred_name))`)
    .eq('id', classId)
    .maybeSingle());
  if (!data) return false;

  ctx.cls = { ...data, start: toMinutes(data.start_time), end: toMinutes(data.end_time) };
  ctx.isTeacher = Boolean(await query(db.rpc('teaches_class', { p_class: classId })));
  document.title = `Folio · ${data.name}`;
  return true;
}

async function loadWeeksData() {
  const [weeks, sections, tags, weekTags, materials, unlocks, currentWeekId, roster] = await Promise.all([
    query(db.from('weeks')
      .select('id, number, session_date, title, topic, assessment_label, is_holiday, lock_state, unlock_at, section_id')
      .eq('class_id', classId).order('session_date')),
    query(db.from('sections').select('id, number, title, description').eq('class_id', classId).order('number')),
    query(db.from('class_tags').select('id, label, color, sort_order').eq('class_id', classId).order('sort_order').order('label')),
    query(db.from('week_tags').select('week_id, tag_id').eq('class_id', classId)),
    query(db.from('materials')
      .select('id, week_id, title, kind, doc_type, url, body, open_mode, hidden, sort_order')
      .eq('class_id', classId).order('sort_order').order('created_at')),
    query(db.from('week_unlocks').select('week_id, student_id').eq('class_id', classId)),
    query(db.rpc('current_week_id', { p_class: classId })),
    ctx.isTeacher
      ? query(db.from('enrollments')
        .select('student_id, profiles!enrollments_student_id_fkey(full_name, preferred_name, email)')
        .eq('class_id', classId).is('removed_at', null))
      : Promise.resolve([]),
  ]);

  ctx.weeks = weeks;
  ctx.sections = sections;
  ctx.tags = tags;
  ctx.currentWeekId = currentWeekId;

  ctx.weekTags = new Map();
  weekTags.forEach((r) => {
    if (!ctx.weekTags.has(r.week_id)) ctx.weekTags.set(r.week_id, new Set());
    ctx.weekTags.get(r.week_id).add(r.tag_id);
  });

  ctx.materials = new Map();
  materials.forEach((m) => {
    if (!ctx.materials.has(m.week_id)) ctx.materials.set(m.week_id, []);
    ctx.materials.get(m.week_id).push(m);
  });

  ctx.unlocks = new Map();
  unlocks.forEach((u) => {
    if (!ctx.unlocks.has(u.week_id)) ctx.unlocks.set(u.week_id, new Set());
    ctx.unlocks.get(u.week_id).add(u.student_id);
  });

  ctx.roster = roster
    .map((r) => ({ id: r.student_id, name: r.profiles?.preferred_name || r.profiles?.full_name || r.profiles?.email || 'Student' }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function reloadWeeks() {
  try {
    await loadWeeksData();
  } catch (err) {
    showToast(errorMessage(err), 'error');
  }
  weeksTab.render();
  renderHeader();
}

// ============================================================
// HEADER
// ============================================================
function teacherNames() {
  const teachers = [...ctx.cls.class_teachers].sort((a, b) => (a.role === 'owner' ? -1 : b.role === 'owner' ? 1 : 0));
  return teachers.map((t) => t.profiles?.preferred_name || t.profiles?.full_name).filter(Boolean).join(', ');
}

function hoursLabel(minutes) {
  const hours = minutes / 60;
  return Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
}

function renderHeader() {
  const c = ctx.cls;
  const setText = (id, value) => {
    $(id).textContent = value || '';
    $(id).hidden = !value;
  };
  setText('heroEyebrow', c.program_eyebrow);
  $('heroTitle').textContent = c.name;
  setText('heroSubtitle', c.subtitle);

  const weekCount = ctx.weeks.filter((w) => !w.is_holiday).length;
  const meta = [
    ['Schedule', `${DAYS[c.day_of_week]}s · ${formatRange(c.start, c.end)}`],
    c.level ? ['Level', c.level] : null,
    ['Duration', `${weekCount} weeks · ${hoursLabel(weekCount * (c.end - c.start))} hours`],
    ['Instructor', teacherNames()],
    ['Term', c.terms?.name ?? ''],
  ].filter(Boolean);

  const dl = $('heroMeta');
  dl.replaceChildren(...meta.map(([label, value]) => {
    const item = document.createElement('div');
    const dt = document.createElement('dt');
    const dd = document.createElement('dd');
    dt.textContent = label;
    dd.textContent = value;
    item.append(dt, dd);
    return item;
  }));

  $('syllabusBtn').hidden = !c.syllabus_url;
  if (c.syllabus_url) $('syllabusBtn').href = c.syllabus_url;
  $('editClassBtn').hidden = !ctx.isTeacher;
  $('closedNotice').hidden = ctx.isTeacher || c.terms?.status !== 'closed';
}

// ============================================================
// TABS
// ============================================================
function tabList() {
  const tabs = [{ key: 'weeks', label: 'Weeks' }];
  if (ctx.cls.has_library) tabs.push({ key: 'library', label: 'Library' });
  tabs.push({ key: 'work', label: ctx.isTeacher ? 'Assignments' : 'My Work' });
  if (ctx.isTeacher) tabs.push({ key: 'students', label: 'Students & Grades' });
  return tabs;
}

function renderTabs() {
  const tabs = tabList();
  const wanted = window.location.hash.replace('#', '');
  const active = tabs.some((t) => t.key === wanted) ? wanted : 'weeks';

  $('tabs').innerHTML = tabs.map((t) => `
    <button class="tab" type="button" role="tab" id="tab-${t.key}" data-tab="${t.key}"
            aria-controls="panel-${t.key}" aria-selected="false" tabindex="-1">
      ${TAB_ICONS[t.key]}<span>${t.label}</span>
    </button>`).join('');
  $('workTitle').textContent = ctx.isTeacher ? 'Assignments' : 'My Work';
  selectTab(active, false);
}

function selectTab(key, focus = true) {
  document.querySelectorAll('#tabs .tab').forEach((tab) => {
    const selected = tab.dataset.tab === key;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    if (selected && focus) tab.focus();
  });
  ['weeks', 'library', 'work', 'students'].forEach((k) => {
    $(`panel-${k}`).hidden = k !== key;
  });
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#${key}`);
}

$('tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('[data-tab]');
  if (tab) selectTab(tab.dataset.tab);
});

// Arrow keys move between tabs.
$('tabs').addEventListener('keydown', (e) => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
  const tabs = [...document.querySelectorAll('#tabs .tab')];
  const i = tabs.indexOf(document.activeElement);
  if (i < 0) return;
  e.preventDefault();
  let next = i;
  if (e.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length;
  if (e.key === 'ArrowRight') next = (i + 1) % tabs.length;
  if (e.key === 'Home') next = 0;
  if (e.key === 'End') next = tabs.length - 1;
  selectTab(tabs[next].dataset.tab);
});

// ============================================================
// EDIT CLASS (teachers)
// ============================================================
function fillClassFormOptions() {
  $('editDay').innerHTML = [1, 2, 3, 4, 5, 6].map((d) => `<option value="${d}">${DAYS[d]}</option>`).join('');
  const times = timeOptions().map((t) => `<option value="${t}">${formatTime(t)}</option>`).join('');
  $('editStart').innerHTML = times;
  $('editEnd').innerHTML = times;
  $('editColors').innerHTML = swatchesHtml('editColor');
}

function scheduleChanged() {
  return Number($('editDay').value) !== ctx.cls.day_of_week || Number($('editStart').value) !== ctx.cls.start;
}

function openClassForm() {
  const c = ctx.cls;
  $('editName').value = c.name;
  $('editEyebrow').value = c.program_eyebrow ?? '';
  $('editLevel').value = c.level ?? '';
  $('editSubtitle').value = c.subtitle ?? '';
  $('editSyllabus').value = c.syllabus_url ?? '';
  $('editDay').value = String(c.day_of_week);
  $('editStart').value = String(c.start);
  $('editEnd').value = String(c.end);
  checkSwatch($('editColors'), c.color);
  $('editLibrary').checked = c.has_library;
  $('editAutoUnlock').checked = c.auto_unlock_at_class_time;
  $('scheduleWarning').hidden = true;
  $('classFormError').hidden = true;
  openModal($('classOverlay'));
}

function showClassFormError(message) {
  $('classFormErrorText').textContent = message;
  $('classFormError').hidden = false;
}

async function submitClassForm(event) {
  event.preventDefault();
  $('classFormError').hidden = true;
  const name = $('editName').value.trim();
  const syllabus = $('editSyllabus').value.trim();
  const start = Number($('editStart').value);
  const end = Number($('editEnd').value);

  if (!name) return showClassFormError('Please type a class name.');
  if (syllabus && !isHttpsUrl(syllabus)) return showClassFormError('The syllabus link must start with https://');
  if (end <= start) return showClassFormError('The end time must be after the start time.');
  if (scheduleChanged() && !window.confirm('Change the class day or time? Every week date will move to match.')) return;

  const button = $('classFormSubmit');
  button.disabled = true;
  const { error } = await db.from('classes').update({
    name,
    program_eyebrow: $('editEyebrow').value.trim() || null,
    level: $('editLevel').value.trim() || null,
    subtitle: $('editSubtitle').value.trim() || null,
    syllabus_url: syllabus || null,
    day_of_week: Number($('editDay').value),
    start_time: toTimeString(start),
    end_time: toTimeString(end),
    color: checkedSwatch($('editColors')),
    has_library: $('editLibrary').checked,
    auto_unlock_at_class_time: $('editAutoUnlock').checked,
  }).eq('id', classId);
  button.disabled = false;
  if (error) return showClassFormError(errorMessage(error));

  closeModal($('classOverlay'));
  showToast('Class saved.', 'success');
  try {
    await loadClass();
    await loadWeeksData();
  } catch (err) {
    showToast(errorMessage(err), 'error');
  }
  renderHeader();
  renderTabs();
  weeksTab.render();
}

$('editClassBtn').addEventListener('click', openClassForm);
$('classForm').addEventListener('submit', submitClassForm);
['editDay', 'editStart'].forEach((id) => $(id).addEventListener('change', () => {
  $('scheduleWarning').hidden = !scheduleChanged();
}));

// ============================================================
// START
// ============================================================
function showNotFound(message) {
  if (message) $('notFoundText').textContent = message;
  $('loading').hidden = true;
  $('notFound').hidden = false;
}

async function start() {
  const session = await requireSession();
  if (!session) return;
  ctx.user = session.user;

  try {
    ctx.profile = await getProfile(ctx.user.id);
    renderNavbar($('navbar'), ctx.profile);
    if (!classId || !(await loadClass())) {
      showNotFound();
      return;
    }
    await loadWeeksData();
  } catch {
    showNotFound();
    return;
  }

  if (ctx.isTeacher) fillClassFormOptions();
  weeksTab = createWeeksTab($('panel-weeks'), ctx, reloadWeeks);
  renderHeader();
  renderTabs();
  weeksTab.render();

  $('loading').hidden = true;
  $('classPage').hidden = false;
}

start();
