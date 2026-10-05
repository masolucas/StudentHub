// Terms (academic only): create, edit, activate, close.
// Upcoming → teachers set up classes. Active → the default everywhere (one at a time).
// Closed → read-only for students; no joining or submitting.
import { db, requireSession, getProfile } from '../supabase.js';
import { registerServiceWorker } from '../pwa.js';
import { renderNavbar } from '../nav.js';
import { esc, errorMessage, showToast, openModal, closeModal } from '../ui.js';
import { formatDateRange } from '../time.js';

registerServiceWorker();

const $ = (id) => document.getElementById(id);
const STATUS_LABELS = { upcoming: 'Upcoming', active: 'Active', closed: 'Closed' };

let terms = [];
let editingId = null;

// Database errors in plain words.
function termError(err) {
  if (err?.code === '23P01') return 'These dates overlap another term.';
  if (err?.code === '23505') return /name/.test(err.message) ? 'A term with this name already exists.' : 'Another term is already active.';
  if (err?.code === '23514') return 'The last day must be after the first day.';
  if (err?.code === '23503') return 'This term has classes, so it can’t be deleted.';
  return errorMessage(err);
}

async function loadTerms() {
  const { data, error } = await db
    .from('terms')
    .select('id, name, start_date, end_date, status, classes(count)')
    .order('start_date', { ascending: false });
  if (error) throw error;
  terms = data.map((t) => ({ ...t, classCount: t.classes?.[0]?.count ?? 0 }));
  render();
}

function render() {
  $('termsTableWrap').hidden = !terms.length;
  $('emptyTerms').hidden = terms.length > 0;
  $('termsBody').innerHTML = terms.map((t) => `
    <tr>
      <th scope="row">${esc(t.name)}</th>
      <td>${esc(formatDateRange(t.start_date, t.end_date))}</td>
      <td><span class="chip chip--${t.status}">${STATUS_LABELS[t.status]}</span></td>
      <td>${t.classCount}</td>
      <td>
        <div class="row-actions">
          <button class="btn btn--ghost btn--sm" type="button" data-edit="${t.id}">Edit</button>
          ${t.status !== 'active' ? `<button class="btn btn--secondary btn--sm" type="button" data-activate="${t.id}">Make active</button>` : ''}
          ${t.status !== 'closed' ? `<button class="btn btn--ghost btn--sm" type="button" data-close-term="${t.id}">Close</button>` : ''}
          ${t.classCount === 0 ? `<button class="btn btn--ghost btn--sm btn--danger-text" type="button" data-delete="${t.id}">Delete</button>` : ''}
        </div>
      </td>
    </tr>`).join('');
}

async function refresh() {
  try {
    await loadTerms();
  } catch (err) {
    showToast(termError(err), 'error');
  }
}

// ============================================================
// FORM
// ============================================================
function openForm(termId = null) {
  const t = terms.find((x) => x.id === termId);
  editingId = termId;
  $('termFormTitle').textContent = t ? 'Edit term' : 'New term';
  $('termName').value = t?.name ?? '';
  $('termStart').value = t?.start_date ?? '';
  $('termEnd').value = t?.end_date ?? '';
  $('termStatus').value = 'upcoming';
  $('termStatusField').hidden = Boolean(t);  // status changes use the row buttons
  $('termDatesHelp').hidden = !(t && t.classCount > 0);
  $('termFormError').hidden = true;
  openModal($('termOverlay'));
}

function showFormError(message) {
  $('termFormErrorText').textContent = message;
  $('termFormError').hidden = false;
}

async function closeActiveTerm(exceptId) {
  const active = terms.find((t) => t.status === 'active' && t.id !== exceptId);
  if (!active) return;
  const { error } = await db.from('terms').update({ status: 'closed' }).eq('id', active.id);
  if (error) throw error;
}

async function submitForm(event) {
  event.preventDefault();
  $('termFormError').hidden = true;
  const name = $('termName').value.trim();
  const start = $('termStart').value;
  const end = $('termEnd').value;

  if (!name) return showFormError('Please type a name.');
  if (!start || !end) return showFormError('Choose the first and last day.');
  if (end <= start) return showFormError('The last day must be after the first day.');

  const button = $('termFormSubmit');
  button.disabled = true;
  try {
    if (editingId) {
      const t = terms.find((x) => x.id === editingId);
      const datesChanged = start !== t.start_date || end !== t.end_date;
      if (name !== t.name) {
        const { error } = await db.from('terms').update({ name }).eq('id', t.id);
        if (error) throw error;
      }
      if (datesChanged) {
        if (t.classCount > 0) {
          if (!window.confirm(`Change the dates of ${t.name}? All ${t.classCount} classes will get new week dates. Week content is kept.`)) {
            button.disabled = false;
            return;
          }
          const { error } = await db.rpc('update_term_dates', { p_term: t.id, p_start: start, p_end: end });
          if (error) throw error;
        } else {
          const { error } = await db.from('terms').update({ start_date: start, end_date: end }).eq('id', t.id);
          if (error) throw error;
        }
      }
    } else {
      const status = $('termStatus').value;
      if (status === 'active') {
        const active = terms.find((t) => t.status === 'active');
        if (active && !window.confirm(`${active.name} is active now. Close it and make the new term active?`)) {
          button.disabled = false;
          return;
        }
        await closeActiveTerm(null);
      }
      const { error } = await db.from('terms').insert({ name, start_date: start, end_date: end, status });
      if (error) throw error;
    }
  } catch (err) {
    showFormError(termError(err));
    button.disabled = false;
    await refresh();
    return;
  }

  button.disabled = false;
  closeModal($('termOverlay'));
  showToast('Term saved.', 'success');
  await refresh();
}

// ============================================================
// ROW ACTIONS
// ============================================================
async function activate(termId) {
  const t = terms.find((x) => x.id === termId);
  const active = terms.find((x) => x.status === 'active');
  const message = active
    ? `Make ${t.name} the active term? ${active.name} will be closed: students can still look at it, but can't join or hand in work.`
    : `Make ${t.name} the active term?`;
  if (!window.confirm(message)) return;
  try {
    await closeActiveTerm(termId);
    const { error } = await db.from('terms').update({ status: 'active' }).eq('id', termId);
    if (error) throw error;
    showToast(`${t.name} is now active.`, 'success');
  } catch (err) {
    showToast(termError(err), 'error');
  }
  await refresh();
}

async function closeTerm(termId) {
  const t = terms.find((x) => x.id === termId);
  if (!window.confirm(`Close ${t.name}? Students can still look at its classes, but can't join or hand in work.`)) return;
  const { error } = await db.from('terms').update({ status: 'closed' }).eq('id', termId);
  if (error) showToast(termError(error), 'error');
  else showToast(`${t.name} is closed.`, 'success');
  await refresh();
}

async function deleteTerm(termId) {
  const t = terms.find((x) => x.id === termId);
  if (!window.confirm(`Delete ${t.name}?`)) return;
  const { error } = await db.from('terms').delete().eq('id', termId);
  if (error) showToast(termError(error), 'error');
  else showToast('Term deleted.', 'success');
  await refresh();
}

$('termsBody').addEventListener('click', (e) => {
  const button = e.target.closest('button');
  if (!button) return;
  if (button.dataset.edit) openForm(button.dataset.edit);
  if (button.dataset.activate) activate(button.dataset.activate);
  if (button.dataset.closeTerm) closeTerm(button.dataset.closeTerm);
  if (button.dataset.delete) deleteTerm(button.dataset.delete);
});
$('newTermBtn').addEventListener('click', () => openForm());
$('termForm').addEventListener('submit', submitForm);

// ============================================================
// START
// ============================================================
async function start() {
  const session = await requireSession();
  if (!session) return;

  try {
    const profile = await getProfile(session.user.id);
    if (profile.role !== 'academic') {
      window.location.replace('dashboard.html');
      return;
    }
    renderNavbar($('navbar'), profile, 'terms');
    await loadTerms();
  } catch (err) {
    $('pageErrorText').textContent = termError(err);
    $('pageError').hidden = false;
  }

  $('loading').hidden = true;
  $('page').hidden = false;
}

start();
