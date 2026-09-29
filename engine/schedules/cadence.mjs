import { can } from '../authz/can.mjs';

const MINUTE = 60_000;
const DAY = 1440 * MINUTE;
export const MINIMUM_INTERVAL_MS = Object.freeze({ collect: 15 * MINUTE, prune: 60 * MINUTE, offsite: 60 * MINUTE });
const cache = new Map();
const names = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

function field(source, min, max, named = []) {
  const values = new Set();
  source = source.toLowerCase().replace(/[a-z]+/g, (name) => {
    if (!named.includes(name)) throw new Error('invalid cron name');
    return names[name];
  });
  for (const part of source.split(',')) {
    const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!match) throw new Error('invalid cron field');
    const step = Number(match[2] ?? 1);
    const [start, end] = match[1] === '*' ? [min, max]
      : match[1].includes('-') ? match[1].split('-').map(Number)
      : [Number(match[1]), match[2] ? max : Number(match[1])];
    if (step < 1 || step > max + 1 || start < min || end > max || start > end) throw new Error('invalid cron range');
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values;
}

function cron(expression) {
  if (cache.has(expression)) return cache.get(expression);
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('cron requires five UTC fields');
  const minute = field(parts[0], 0, 59);
  const hour = field(parts[1], 0, 23);
  const dom = field(parts[2], 1, 31);
  const month = field(parts[3], 1, 12, Object.keys(names).slice(0, 12));
  const dow = field(parts[4], 0, 7, Object.keys(names).slice(12));
  if (dow.has(7)) dow.add(0);
  const times = [...hour].flatMap((h) => [...minute].map((m) => h * 60 + m)).sort((a, b) => a - b);
  const matchesDay = (date) => month.has(date.getUTCMonth() + 1)
    && (parts[2].startsWith('*') || parts[4].startsWith('*')
      ? dom.has(date.getUTCDate()) && dow.has(date.getUTCDay())
      : dom.has(date.getUTCDate()) || dow.has(date.getUTCDay()));
  let minimumGap = Infinity;
  for (let i = 1; i < times.length; i++) minimumGap = Math.min(minimumGap, times[i] - times[i - 1]);
  // Gregorian weekday/month/day combinations repeat every 400 years. Include the
  // cycle boundary: a sample of a few next firings misses rare clustered schedules.
  let previous;
  let first;
  let last;
  for (let day = Date.UTC(2000, 0, 1); day < Date.UTC(2400, 0, 1); day += DAY) {
    if (!matchesDay(new Date(day))) continue;
    first ??= day;
    last = day;
    if (previous !== undefined) minimumGap = Math.min(minimumGap, (day - previous) / MINUTE + times[0] - times.at(-1));
    previous = day;
  }
  if (first === undefined) throw new Error('cron has no possible firing');
  minimumGap = Math.min(minimumGap, (first + (Date.UTC(2400, 0, 1) - Date.UTC(2000, 0, 1)) - last) / MINUTE + times[0] - times.at(-1));
  const parsed = { times, matchesDay, minimumGap: minimumGap * MINUTE };
  if (cache.size >= 100) cache.clear();
  cache.set(expression, parsed);
  return parsed;
}

export function validateSchedule(row) {
  const floor = MINIMUM_INTERVAL_MS[row.job_kind];
  if (!floor) throw new Error('job kind is not schedulable');
  if (row.job_kind === 'collect' ? !['tier1', 'tier2', 'tier3'].includes(row.tier) : row.tier != null) throw new Error('invalid schedule tier');
  let gap;
  if (row.cron_override != null) gap = cron(row.cron_override).minimumGap;
  else {
    const { every, n, atTime } = row.cadence ?? {};
    const unit = { hour: 60 * MINUTE, day: DAY, week: 7 * DAY }[every];
    if (!unit || !Number.isSafeInteger(n) || n < 1 || n > 10000) throw new Error('invalid structured cadence');
    if (atTime != null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(atTime)) throw new Error('invalid UTC atTime');
    gap = unit * n;
  }
  if (gap < floor) throw new Error(`schedule_minimum_interval: ${row.job_kind} requires at least ${floor / MINUTE} minutes`);
  return row;
}

export function nextDueAt(row, due) {
  validateSchedule(row);
  const date = new Date(due);
  if (!Number.isFinite(date.valueOf())) throw new Error('invalid due instant');
  if (row.cron_override != null) {
    const { matchesDay, times } = cron(row.cron_override);
    const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    for (let day = start; day <= start + 146097 * DAY; day += DAY) {
      if (!matchesDay(new Date(day))) continue;
      for (const time of times) if (day + time * MINUTE > date.valueOf()) return new Date(day + time * MINUTE);
    }
    throw new Error('cron has no next firing');
  }
  const { every, n, atTime } = row.cadence;
  const next = new Date(date.valueOf() + n * { hour: 60 * MINUTE, day: DAY, week: 7 * DAY }[every]);
  if (atTime != null) {
    const [hour, minute] = atTime.split(':').map(Number);
    if (every === 'hour') next.setUTCMinutes(minute, 0, 0);
    else next.setUTCHours(hour, minute, 0, 0);
    if (next <= date) throw new Error('cadence atTime does not advance the due instant');
  }
  return next;
}

// Task 44's write route can call this server boundary; validation cannot be bypassed
// by submitting raw cron instead of the structured builder.
export async function updateSchedule(client, principal, id, changes) {
  if (!(await can(client, principal, 'configuration'))) throw new Error('not authorized to edit schedules');
  await client.query('BEGIN');
  try {
    const { rows: [row] } = await client.query('SELECT * FROM schedule WHERE id = $1 FOR UPDATE', [id]);
    if (!row) throw new Error('schedule not found');
    if (Object.keys(changes).some((key) => !['cadence', 'cron_override', 'enabled'].includes(key))) throw new Error('invalid schedule changes');
    if ('enabled' in changes && typeof changes.enabled !== 'boolean') throw new Error('enabled must be boolean');
    const updated = validateSchedule({ ...row, ...changes });
    const { rows: [saved] } = await client.query(
      `UPDATE schedule SET cadence = $2, cron_override = $3, enabled = $4,
       next_due_at = $5, updated_at = now() WHERE id = $1 RETURNING *`,
      [id, updated.cadence, updated.cron_override, updated.enabled, nextDueAt(updated, new Date())],
    );
    await client.query('COMMIT');
    return saved;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}
