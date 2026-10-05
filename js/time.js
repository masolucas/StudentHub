// Time helpers. Class times are stored as "HH:MM:SS" in the school's time zone.
import { SCHOOL_TIMEZONE } from './config.js';

// ISO weekday numbers: 1 = Monday … 6 = Saturday.
export const DAYS = [null, 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const DAYS_SHORT = [null, 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Classes run between 9 AM and 10 PM, in 15-minute steps.
export const DAY_START = 9 * 60;
export const DAY_END = 22 * 60;
export const STEP = 15;

export function toMinutes(time) {
  const [h, m] = String(time).split(':').map(Number);
  return h * 60 + m;
}

export function toTimeString(minutes) {
  const h = String(Math.floor(minutes / 60)).padStart(2, '0');
  const m = String(minutes % 60).padStart(2, '0');
  return `${h}:${m}`;
}

// 540 → "9 AM", 570 → "9:30 AM"
export function formatTime(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const suffix = h >= 12 ? 'PM' : 'AM';
  const h12 = ((h + 11) % 12) + 1;
  return m ? `${h12}:${String(m).padStart(2, '0')} ${suffix}` : `${h12} ${suffix}`;
}

export function formatRange(start, end) {
  return `${formatTime(start)} – ${formatTime(end)}`;
}

// 240 → "4h", 90 → "1h 30m"
export function durationLabel(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

// Every selectable class time, 9:00 AM to 10:00 PM.
export function timeOptions() {
  const options = [];
  for (let t = DAY_START; t <= DAY_END; t += STEP) options.push(t);
  return options;
}

// ------------------------------------------------------------
// Dates and time zones
// session_date is a plain date ("2026-10-20"); unlock and due times are
// instants (timestamptz) shown in the class's time zone.
// ------------------------------------------------------------

// "2026-10-20" → "Mon, Oct 20" (no time zone shift: it's a calendar date)
export function formatDate(dateStr, { year = false } = {}) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', ...(year ? { year: 'numeric' } : {}),
  }).format(new Date(`${dateStr}T12:00:00Z`));
}

// "2026-09-28", "2026-12-12" → "Sep 28 – Dec 12, 2026"
export function formatDateRange(startStr, endStr) {
  const fmt = (s, opts) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...opts }).format(new Date(`${s}T12:00:00Z`));
  return `${fmt(startStr, { month: 'short', day: 'numeric' })} – ${fmt(endStr, { month: 'short', day: 'numeric', year: 'numeric' })}`;
}

// Instant → "Mon, Oct 20 · 9:00 AM" in the given time zone
export function formatDateTime(value, timeZone = SCHOOL_TIMEZONE) {
  const date = new Date(value);
  const day = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric' }).format(date);
  const time = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(date);
  return `${day} · ${time}`;
}

function zonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') };
}

// Wall-clock date and time in a time zone → the real instant (handles daylight saving).
// zonedToDate("2026-10-20", "09:00", "America/New_York") → 2026-10-20T13:00:00Z
export function zonedToDate(dateStr, timeStr, timeZone = SCHOOL_TIMEZONE) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mi] = timeStr.split(':').map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  let guess = wall;
  for (let i = 0; i < 2; i++) {
    const p = zonedParts(new Date(guess), timeZone);
    guess += wall - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  }
  return new Date(guess);
}

// Instant → "2026-10-20T09:00" in a time zone, for <input type="datetime-local">.
export function toZonedInputValue(value, timeZone = SCHOOL_TIMEZONE) {
  const p = zonedParts(new Date(value), timeZone);
  const pad = (n) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

// "2026-10-20T09:00" (wall time in a time zone) → ISO instant for the database.
export function zonedInputToIso(inputValue, timeZone = SCHOOL_TIMEZONE) {
  const [dateStr, timeStr] = inputValue.split('T');
  return zonedToDate(dateStr, timeStr, timeZone).toISOString();
}

// Weekday (1 = Monday … 7 = Sunday) and minutes since midnight, in the school's time zone.
export function nowInSchool() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: SCHOOL_TIMEZONE, weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type)?.value;
  const dow = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(get('weekday')) + 1;
  return { dow, minutes: Number(get('hour')) * 60 + Number(get('minute')) };
}
