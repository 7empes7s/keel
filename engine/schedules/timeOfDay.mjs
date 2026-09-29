// Browser-safe helpers for the structured builder. Convert once on save; stored
// cadence and scheduler arithmetic remain UTC through subsequent DST transitions.
function parts(time) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('invalid time of day');
  return time.split(':').map(Number);
}
const format = (hour, minute) => `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
export function localTimeToUTC(time, onDate = new Date()) {
  const date = new Date(onDate);
  date.setHours(...parts(time), 0, 0);
  return format(date.getUTCHours(), date.getUTCMinutes());
}
export function utcTimeToLocal(time, onDate = new Date()) {
  const date = new Date(onDate);
  date.setUTCHours(...parts(time), 0, 0);
  return format(date.getHours(), date.getMinutes());
}
