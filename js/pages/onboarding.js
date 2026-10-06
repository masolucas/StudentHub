// Onboarding mode (teachers, projector): onboarding.html?class=…
// The joined list updates live through Supabase Realtime (enrollments is in
// the realtime publication; RLS means only the class's teachers get events).
// A slow poll backs it up in case the live connection drops.
import { db, requireSession, getProfile } from '../supabase.js';
import { esc, storage } from '../ui.js';
import { qrSvg } from '../qr.js';

const $ = (id) => document.getElementById(id);
const classId = new URLSearchParams(window.location.search).get('class');
const POLL_MS = 15_000;
const expectedKey = () => `folio.expected.${classId}`;

let known = null;         // student ids already shown (null until the first load)
let refreshing = false;

async function query(request) {
  const { data, error } = await request;
  if (error) throw error;
  return data;
}

function renderExpected() {
  const expected = Number($('expected').value);
  $('expectedText').textContent = expected > 0 ? ` of ${expected}` : '';
}

// Reload the joined list; names that weren't there before get a "new" animation.
async function refreshList() {
  if (refreshing) return;
  refreshing = true;
  try {
    const rows = await query(db
      .from('enrollments')
      .select('student_id, joined_at, profiles!enrollments_student_id_fkey(preferred_name, full_name)')
      .eq('class_id', classId)
      .is('removed_at', null)
      .order('joined_at', { ascending: false }));

    const isNew = (id) => known !== null && !known.has(id);
    $('joinedCount').textContent = String(rows.length);
    $('names').innerHTML = rows.map((r) => {
      const name = r.profiles?.preferred_name || r.profiles?.full_name || 'New student';
      return `<li class="${isNew(r.student_id) ? 'is-new' : ''}">${esc(name)}</li>`;
    }).join('');
    known = new Set(rows.map((r) => r.student_id));
  } catch {
    // Keep showing the last list; the next event or poll tries again.
  } finally {
    refreshing = false;
  }
}

function subscribeLive() {
  db.channel(`onboarding-${classId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'enrollments', filter: `class_id=eq.${classId}` }, refreshList)
    .subscribe((status) => {
      $('liveDot').classList.toggle('is-off', status !== 'SUBSCRIBED');
    });
  setInterval(refreshList, POLL_MS);
}

async function start() {
  const session = await requireSession();
  if (!session) return;

  try {
    await getProfile(session.user.id);
    const teaches = classId && await query(db.rpc('teaches_class', { p_class: classId }));
    if (!teaches) throw new Error('not allowed');

    const [cls, joinCode] = await Promise.all([
      query(db.from('classes').select('name').eq('id', classId).single()),
      query(db.from('class_join_codes').select('code').eq('class_id', classId).single()),
    ]);

    document.title = `Folio · Onboarding · ${cls.name}`;
    $('className').textContent = cls.name;
    $('code').textContent = joinCode.code;
    $('exitBtn').href = `class.html?id=${encodeURIComponent(classId)}`;

    // The QR opens Folio itself: students install first, then join inside the app.
    const portal = new URL('index.html', window.location.href).href;
    $('portalUrl').textContent = portal.replace(/^https?:\/\//, '').replace(/index\.html$/, '');
    $('portalQr').innerHTML = await qrSvg(portal, 'QR code to open Folio');
  } catch {
    $('loading').hidden = true;
    $('notAllowed').hidden = false;
    return;
  }

  $('expected').value = storage.get(expectedKey()) ?? '';
  renderExpected();
  await refreshList();
  subscribeLive();

  $('loading').hidden = true;
  $('page').hidden = false;
}

$('expected').addEventListener('input', () => {
  storage.set(expectedKey(), $('expected').value);
  renderExpected();
});

$('fullscreenBtn').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.();
});

start();
