// Weekly calendar for the dashboard.
// Desktop: Monday–Saturday columns, hours down the side, each class a card
// whose height equals its duration (64px per hour). The visible hours trim
// to the earliest and latest class.
// Phones: one column, a heading per day that has classes; students also get
// their next class pinned on top.
// Both layouts are rendered; CSS shows one or the other.
import { esc } from './ui.js';
import { DAYS, DAYS_SHORT, formatRange, nowInSchool } from './time.js';

const SLOT_MINUTES = 15;       // one grid row
const COMPACT_BELOW = 120;     // classes shorter than 2h get the compact card

const ICON = {
  people: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.2a6.5 6.5 0 0 1 3.5 5.8"/></svg>',
  qr: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><path d="M14 14h3v3h-3zM21 14v.01M14 21h.01M17 21h4v-4"/></svg>',
  teacher: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>',
  due: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  feedback: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z"/></svg>',
};

const studentsLabel = (n) => `${n} ${n === 1 ? 'student' : 'students'}`;

// ------------------------------------------------------------
// Cards
// ------------------------------------------------------------
function studentBadges(c) {
  let html = '';
  if (c.due) html += `<span class="badge badge--due">${ICON.due}${c.due} due</span>`;
  if (c.feedback) html += `<span class="badge badge--new">${ICON.feedback}New feedback</span>`;
  return html;
}

function cardBody(c, role, compact) {
  const time = esc(formatRange(c.start, c.end));

  if (c.ghost) {
    return `<p class="class-card-name">${esc(c.name)}</p><p class="class-card-time">${time}</p>`;
  }

  // The class name links to the class page; its ::after covers the whole card.
  const name = `<a class="class-card-link" href="class.html?id=${encodeURIComponent(c.id)}">${esc(c.name)}</a>`;

  if (role === 'teacher') {
    const count = `<span class="class-card-meta">${ICON.people}${studentsLabel(c.students)}</span>`;
    const codeLabel = `Show code for ${esc(c.name)}`;
    if (compact) {
      return `<p class="class-card-line"><span class="class-card-name">${name}</span><span class="class-card-time">${time}</span></p>`
        + `<p class="class-card-line">${count}<button type="button" class="icon-btn icon-btn--card" data-show-code="${esc(c.id)}" aria-label="${codeLabel}" title="Show code">${ICON.qr}</button></p>`;
    }
    return `<p class="class-card-name">${name}</p><p class="class-card-time">${time}</p><p>${count}</p>`
      + `<button type="button" class="btn btn--sm class-card-btn" data-show-code="${esc(c.id)}" aria-label="${codeLabel}">${ICON.qr}<span>Show code</span></button>`;
  }

  const teacher = c.teacher ? `<span class="class-card-meta">${ICON.teacher}${esc(c.teacher)}</span>` : '';
  const badges = studentBadges(c);
  if (compact) {
    return `<p class="class-card-line"><span class="class-card-name">${name}</span><span class="class-card-time">${time}</span></p>`
      + `<p class="class-card-line">${badges || teacher}</p>`;
  }
  return `<p class="class-card-name">${name}</p><p class="class-card-time">${time}</p><p>${teacher}</p>`
    + (badges ? `<p class="class-card-badges">${badges}</p>` : '');
}

function cardHtml(c, role, { compact = false, place = '' } = {}) {
  const classes = ['class-card', `cls-${c.color}`];
  if (compact) classes.push('class-card--compact');
  if (c.ghost) classes.push('class-card--ghost');
  const label = c.ghost ? ' aria-label="Preview of the new class"' : '';
  return `<article class="${classes.join(' ')}"${place}${label}>${cardBody(c, role, compact)}</article>`;
}

// Grid position as data attributes; applyPlacement() turns them into CSS variables.
const place = (col, rowStart, rowEnd) => ` data-col="${col}" data-row-start="${rowStart}" data-row-end="${rowEnd}"`;

// ------------------------------------------------------------
// Desktop grid
// ------------------------------------------------------------
function gridHtml(items, role, now) {
  const startHour = Math.floor(Math.min(...items.map((c) => c.start)) / 60);
  const endHour = Math.ceil(Math.max(...items.map((c) => c.end)) / 60);
  const rows = ((endHour - startHour) * 60) / SLOT_MINUTES;
  const rowOf = (minutes) => (minutes - startHour * 60) / SLOT_MINUTES + 2;  // row 1 is the day header
  const lastRow = rows + 2;

  let html = `<div class="cal-grid" data-rows="${rows}" data-start-hour="${startHour}" data-end-hour="${endHour}">`;
  html += `<div class="cal-corner"${place(1, 1, 2)}></div>`;

  for (let d = 1; d <= 6; d++) {
    const today = d === now.dow ? ' is-today' : '';
    html += `<div class="cal-day-head${today}"${place(d + 1, 1, 2)}><abbr title="${DAYS[d]}">${DAYS_SHORT[d]}</abbr></div>`;
    html += `<div class="cal-day-col${today}"${place(d + 1, 2, lastRow)}></div>`;
  }

  for (let h = startHour; h < endHour; h++) {
    const label = h === 12 ? '12 PM' : h > 12 ? `${h - 12} PM` : `${h} AM`;
    html += `<div class="cal-hour"${place(1, rowOf(h * 60), rowOf(h * 60) + 4)}>${label}</div>`;
  }

  for (const c of items) {
    const compact = c.end - c.start < COMPACT_BELOW;
    html += cardHtml(c, role, { compact, place: place(c.dow + 1, rowOf(c.start), rowOf(c.end)) });
  }

  if (now.dow >= 1 && now.dow <= 6) {
    html += `<div class="cal-now"${place(now.dow + 1, 2, lastRow)} aria-hidden="true"><span class="cal-now-line"></span></div>`;
  }

  return `${html}</div>`;
}

// ------------------------------------------------------------
// Phone list
// ------------------------------------------------------------
// Next class from now: one happening right now first, then the soonest this week.
function nextClass(items, now) {
  let best = null;
  let bestScore = Infinity;
  for (const c of items) {
    if (c.ghost) continue;
    let score = ((c.dow - now.dow + 7) % 7) * 1440 + c.start - now.minutes;
    if (c.dow === now.dow && c.end <= now.minutes) score += 7 * 1440;  // already over today
    if (score < bestScore) { best = c; bestScore = score; }
  }
  return best;
}

function listHtml(items, role, now) {
  let html = '<div class="cal-list">';

  if (role === 'student') {
    const next = nextClass(items, now);
    if (next) {
      html += `<section class="cal-list-day cal-list-day--next"><h2 class="cal-list-head">Next class · ${DAYS[next.dow]}</h2>${cardHtml(next, role)}</section>`;
    }
  }

  for (let d = 1; d <= 6; d++) {
    const day = items.filter((c) => c.dow === d).sort((a, b) => a.start - b.start);
    if (!day.length) continue;
    const today = d === now.dow ? ' · Today' : '';
    html += `<section class="cal-list-day"><h2 class="cal-list-head">${DAYS[d]}${today}</h2>`
      + day.map((c) => cardHtml(c, role)).join('')
      + '</section>';
  }

  return `${html}</div>`;
}

// ------------------------------------------------------------
// Public API
// ------------------------------------------------------------
function applyPlacement(container) {
  const grid = container.querySelector('.cal-grid');
  if (!grid) return;
  grid.style.setProperty('--cal-rows', grid.dataset.rows);
  grid.querySelectorAll('[data-col]').forEach((el) => {
    el.style.setProperty('--col', el.dataset.col);
    el.style.setProperty('--row-start', el.dataset.rowStart);
    el.style.setProperty('--row-end', el.dataset.rowEnd);
  });
  updateNowLine(container);
}

// items: [{ id, name, dow, start, end, color, students? | teacher?, due?, feedback? }]
// ghost: an optional preview card (create-class form).
export function renderCalendar(container, items, { role, ghost = null }) {
  const all = ghost ? [...items, { ...ghost, id: 'ghost', ghost: true }] : items;
  if (!all.length) {
    container.innerHTML = '';
    container.hidden = true;
    return;
  }
  const now = nowInSchool();
  container.hidden = false;
  container.innerHTML = gridHtml(all, role, now) + listHtml(all, role, now);
  applyPlacement(container);
}

// Moves the gold "now" line; hides it outside the visible hours. Call every minute.
export function updateNowLine(container) {
  const grid = container.querySelector('.cal-grid');
  const line = grid?.querySelector('.cal-now');
  if (!line) return;
  const { minutes } = nowInSchool();
  const start = Number(grid.dataset.startHour) * 60;
  const end = Number(grid.dataset.endHour) * 60;
  line.hidden = minutes < start || minutes > end;
  line.style.setProperty('--now-min', minutes - start);
}
