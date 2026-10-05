// Week visibility, for display only. The database decides what content
// students actually receive (week_visible_to_student); this mirrors it so
// the page can show "Locked" or "Opens Mon, Oct 20 · 9:00 AM".

// Open to the whole class right now (unlocked, or scheduled and past its time).
export function isOpenToClass(week) {
  if (week.is_holiday) return false;
  if (week.lock_state === 'unlocked') return true;
  return week.lock_state === 'scheduled' && new Date(week.unlock_at) <= new Date();
}

// Open to the signed-in student (adds their own early access).
export function isOpenForStudent(week, ctx) {
  if (week.is_holiday) return false;
  return isOpenToClass(week) || (ctx.unlocks.get(week.id)?.has(ctx.user.id) ?? false);
}
