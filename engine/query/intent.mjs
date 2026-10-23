/**
 * Roadmap task-99: bounded, grounded tenant questions.
 *
 * A question becomes one of a FIXED set of intents (changes, coverage, failed jobs).
 * Each intent has a fixed, parameterized read-only query (engine/query/execute.mjs);
 * nothing here produces SQL. This module only turns a question, or a structured
 * request, into a validated plan:
 *
 *   { intent, params: { entity, from, to, resourceType, resourceTypes, name, changeType, limit } }
 *
 * Every value is checked against a closed set: an intent from INTENTS, a resource type
 * KEEL collects, a change type, an entity code KEEL holds ownership evidence for and
 * the reader may see, and a period no longer than the budget. A request with any other
 * key (sql, query, tool, scope, ...) is refused, not ignored. The reader's scope never
 * comes from a request: execute.mjs takes it from the authenticated principal.
 *
 * The built-in reading is deterministic (keywords and periods). A natural-language
 * helper may be supplied by an operator, and none is configured by default. Its
 * proposal is treated exactly like a structured request, and each value it proposes
 * must appear in the question itself: it cannot run a query or a tool, and it cannot
 * add an entity, type or date the person did not ask about.
 */
import { DESCRIPTORS } from '../collect/descriptors.mjs';
import { TAXONOMY } from '../insights/taxonomy.mjs';

export const PLAN_VERSION = 1;

export const INTENTS = Object.freeze(['changes', 'coverage', 'failed-jobs']);

export const BUDGET = Object.freeze({
  /** The longest period a changes or failed-jobs question may cover. */
  maxWindowDays: 31,
  /** The most records an answer lists; the rest are counted. The page pages and filters
   *  them itself, so a month of changes to a tenant's users fits in one answer. */
  maxRows: 1000,
  defaultRows: 1000,
  /** The longest question read. */
  maxQuestionLength: 500,
  /** Statement timeout for each read, in milliseconds. */
  statementTimeoutMs: 5000,
});

const DAY_MS = 86_400_000;
const CHANGE_TYPES = Object.freeze(['added', 'modified', 'removed']);
const PARAM_KEYS = Object.freeze(['entity', 'from', 'to', 'period', 'resourceType', 'resourceTypes', 'name', 'changeType', 'limit']);
/** The longest name a question can look for, and the most kinds one question can name. */
const MAX_NAME = 120;
const MAX_KINDS = 60;
const ENTITY_CODE = /^[A-Z][A-Z0-9_]{1,31}$/;
const PERIODS = Object.freeze(['today', 'yesterday', 'this-week', 'last-week', 'last-7-days', 'last-30-days', 'this-month', 'last-month']);

export const RESOURCE_TYPES = Object.freeze(DESCRIPTORS.map(({ type }) => type));
/** Every kind a question can narrow to: collected types and service setting reads. */
export const KNOWN_KINDS = Object.freeze([...new Set([...RESOURCE_TYPES, ...Object.keys(TAXONOMY)])]);

/** Words a person uses for a service, matched to the taxonomy's service names. */
const SERVICE_WORDS = Object.freeze([
  [/\b(entra(?: id)?|azure (?:ad|active directory)|aad)\b/i, 'Entra'],
  [/\bintune\b/i, 'Intune'],
  [/\bexchange(?: online)?\b/i, 'Exchange'],
  [/\b(ms |microsoft )?teams\b/i, 'Teams'],
  [/\b(sharepoint|onedrive)\b/i, 'SharePoint'],
  [/\bpurview\b/i, 'Purview'],
  [/\b(power platform|power apps|power automate)\b/i, 'Power Platform'],
  [/\bdefender\b/i, 'Defender'],
]);

/** Broad words for a kind of setting; each keeps the kinds whose name holds the word. */
const CATEGORY_WORDS = Object.freeze([
  [/\bpolic(?:y|ies)\b/i, /\bpolic(?:y|ies)\b/i],
  [/\broles?\b/i, /\broles?\b/i],
  [/\brules?\b/i, /\brules?\b/i],
  [/\blabels?\b/i, /\blabels?\b/i],
  [/\bmemberships?\b/i, /\bmemberships?\b/i],
  [/\b(apps?|applications?)\b/i, /\b(apps?|applications?)\b/i],
  [/\bdevices?\b/i, /\bdevices?\b/i],
  [/\bmailbox(?:es)?\b/i, /\bmailbox(?:es)?\b/i],
  [/\bsites?\b/i, /\bsites?\b/i],
]);

// Words that carry no filter. Anything else a reading does not use is reported back as
// "not understood", never dropped silently.
const FILLER = new Set(('a an the what which who whom whose when where how why did do does done was were is are be been being has have had '
  + 'in on of for to from by with and or at as any all every some me my our us we you your i it its this that these those there their '
  + 'show list tell give find see get please about since between during ago last past previous days day weeks week months month '
  + 'happen happened happening anything something everything kind kinds type types setting settings resource resources thing things '
  + 'tenant microsoft 365 m365 office online new latest backup backups recent recently made make change changed changes changing '
  + 'modified added created removed deleted drift drifted edited updated covered coverage protected protection backed up fail failed '
  + 'failure failures failing job jobs run runs task tasks collection collections now today yesterday month').split(' '));

/** Words a person uses for a resource type. Each maps to exactly one collected type. */
const TYPE_WORDS = Object.freeze([
  [/\bconditional access( polic(y|ies))?\b/i, 'conditionalAccessPolicy'],
  [/\bnamed locations?\b/i, 'namedLocation'],
  [/\brole assignments?\b/i, 'roleAssignment'],
  [/\b(enterprise apps?|service principals?)\b/i, 'servicePrincipal'],
  [/\bapp registrations?\b/i, 'application'],
  [/\bgroups?\b/i, 'group'],
  [/\busers?\b/i, 'user'],
  [/\bauthori[sz]ation polic(y|ies)\b/i, 'authorizationPolicy'],
  [/\bdevice configurations?\b/i, 'deviceConfiguration'],
]);

export class QueryRefusal extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const refuse = (code, message) => ({ ok: false, refusal: { code, message } });

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function startOfDay(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/** The [from, to) window a named period covers at `now`, in UTC. */
export function periodWindow(period, now = new Date()) {
  const today = startOfDay(now);
  const monday = new Date(today.getTime() - ((today.getUTCDay() + 6) % 7) * DAY_MS);
  switch (period) {
    case 'today': return { from: today, to: now };
    case 'yesterday': return { from: new Date(today.getTime() - DAY_MS), to: today };
    case 'this-week': return { from: monday, to: now };
    case 'last-week': return { from: new Date(monday.getTime() - 7 * DAY_MS), to: monday };
    case 'last-7-days': return { from: new Date(now.getTime() - 7 * DAY_MS), to: now };
    case 'last-30-days': return { from: new Date(now.getTime() - 30 * DAY_MS), to: now };
    case 'this-month': return { from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), to: now };
    case 'last-month': return { from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)), to: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)) };
    default: return null;
  }
}

function parseDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(T[\d:.]+Z)?$/.test(value)) return null;
  const date = new Date(value.length === 10 ? `${value}T00:00:00Z` : value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/* ---------------------------------------------------- built-in reading -- */

const PERIOD_WORDS = Object.freeze([
  [/\bthis week\b/i, 'this-week'],
  [/\blast week\b/i, 'last-week'],
  [/\b(today)\b/i, 'today'],
  [/\b(yesterday)\b/i, 'yesterday'],
  [/\bthis month\b/i, 'this-month'],
  [/\blast month\b/i, 'last-month'],
]);
const UNBOUNDED = /\b(ever|all[- ]time|since (the )?beginning|everything|forever|any time)\b/i;
/** "since the start of the month", "from the beginning of this week". */
const START_OF = /\b(?:since|from) (?:the )?(?:beginning|start) of (?:the |this )?(month|week|year)\b/i;
/** "3 days ago", "in the last 48 hours", "past 2 weeks". */
const UNIT_MS = Object.freeze({ hour: 3_600_000, day: 86_400_000, week: 7 * 86_400_000 });
const AGO = /\b(since )?(\d{1,4}) (hour|day|week)s? ago\b/i;
const LAST_N = /\b(?:last|past|previous) (\d{1,4}) (hour|day|week)s?\b/i;
const WEEKEND = /\b(?:over |during |on )?(?:the |this |last )?weekend\b/i;
/** The period a question that names none is read for. */
export const DEFAULT_PERIOD = 'this-week';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const WEEKDAY_NAME = '(?:(?:last )?(?:mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?|sun)(?:day)?)';
const MONTH_NAME = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
/** A day as people write it: 2026-10-17, 17/10, 10/17, 17.10.2026, 17 Oct, October 17th, Monday.
 *  A dotted day needs its year, so a version ("since 1.5") is not read as a date. */
const DAY = `(?:${WEEKDAY_NAME}|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}/\\d{1,2}(?:/\\d{2,4})?|\\d{1,2}\\.\\d{1,2}\\.\\d{2,4}|\\d{1,2}(?:st|nd|rd|th)? (?:of )?${MONTH_NAME}(?:,? \\d{4})?|${MONTH_NAME} \\d{1,2}(?:st|nd|rd|th)?(?:,? \\d{4})?)`;

function isoDay(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

/**
 * Read one written day as YYYY-MM-DD. Day and month are told apart when only one
 * reading is a date (17/10 and 10/17 are both 17 October); 05/06 could be either, so it
 * comes back { ambiguous }. A day with no year is the latest one not after `now`, and a
 * weekday the latest such day; `rolls` says by how much a later reading would move it.
 */
export function readDay(text, now = new Date()) {
  const value = text.trim().toLowerCase();
  const weekday = new RegExp(`^${WEEKDAY_NAME}$`).test(value) ? WEEKDAYS.indexOf(value.replace(/^last /, '').slice(0, 3)) : -1;
  if (weekday !== -1) {
    // The latest such day up to today; "last Monday" is the one before when today is Monday.
    const today = startOfDay(now);
    let back = (today.getUTCDay() - weekday + 7) % 7;
    if (back === 0 && value.startsWith('last ')) back = 7;
    return { day: new Date(today.getTime() - back * DAY_MS).toISOString().slice(0, 10), rolls: 'week' };
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split('-').map(Number);
    return isoDay(year, month, day) ? { day: value } : null;
  }
  let year = null;
  let month = null;
  let day = null;
  const numeric = /^(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2,4}))?$/.exec(value);
  if (numeric) {
    const [first, second] = [Number(numeric[1]), Number(numeric[2])];
    if (numeric[3]) year = Number(numeric[3].length === 2 ? `20${numeric[3]}` : numeric[3]);
    const dayFirst = second <= 12 && first <= 31;
    const monthFirst = first <= 12 && second <= 31;
    if (dayFirst && monthFirst && first !== second) return { ambiguous: text.trim() };
    if (dayFirst) { day = first; month = second; } else if (monthFirst) { day = second; month = first; } else return null;
  } else {
    const named = new RegExp(`^(?:(\\d{1,2})(?:st|nd|rd|th)? (?:of )?(${MONTH_NAME})|(${MONTH_NAME}) (\\d{1,2})(?:st|nd|rd|th)?)(?:,? (\\d{4}))?$`).exec(value);
    if (!named) return null;
    day = Number(named[1] ?? named[4]);
    month = MONTHS.indexOf((named[2] ?? named[3]).slice(0, 3)) + 1;
    if (named[5]) year = Number(named[5]);
  }
  const rolls = year === null ? 'year' : null;
  if (year === null) {
    year = now.getUTCFullYear();
    const candidate = isoDay(year, month, day);
    if (candidate && new Date(`${candidate}T00:00:00Z`) > now) year -= 1;
  }
  const iso = isoDay(year, month, day);
  return iso ? { day: iso, rolls } : null;
}

/** The end of a range, read after its start: "Monday to Friday" asked on a Wednesday
 *  ends this Friday, "28 Dec to 5 Jan" ends in the new year. Validation cuts it at now. */
function after(start, end) {
  let day = new Date(`${end.day}T00:00:00Z`);
  const from = new Date(`${start}T00:00:00Z`);
  while (day < from && end.rolls) {
    day = end.rolls === 'week' ? new Date(day.getTime() + 7 * DAY_MS)
      : new Date(Date.UTC(day.getUTCFullYear() + 1, day.getUTCMonth(), day.getUTCDate()));
  }
  return day.toISOString().slice(0, 10);
}

/**
 * Read a question with fixed rules. Returns a candidate request (still to be validated)
 * or { unsupported: reason }. Entity words are recognised only from `knownEntities`,
 * the codes this tenant's ownership evidence holds; the question's text never adds one.
 */
export function readQuestion(question, { now = new Date(), knownEntities = [] } = {}) {
  if (typeof question !== 'string' || !question.trim()) return { unsupported: 'empty' };
  if (question.length > BUDGET.maxQuestionLength) return { unsupported: 'too-long' };
  const text = question.replace(/\s+/g, ' ').trim();
  // Every span a rule reads, so the rest can be reported as not understood.
  const used = [];
  const hit = (pattern) => {
    const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
    let found = false;
    for (const match of text.matchAll(new RegExp(pattern.source, flags))) {
      used.push([match.index, match.index + match[0].length]);
      found = true;
    }
    return found;
  };

  // A quoted phrase is a name to look for ("Block legacy auth").
  const params = {};
  // What the reading filled in because the question did not say it.
  const assumed = [];
  const quoted = /["“”'‘’]([^"“”'‘’]{2,120})["“”'‘’]/.exec(text);
  if (quoted) {
    params.name = quoted[1].trim();
    used.push([quoted.index, quoted.index + quoted[0].length]);
  }

  let intent = null;
  const failWords = /\bfail(ed|ures?|ing)?\b/i;
  const jobWords = /\b(jobs?|runs?|tasks?|backups?|collections?)\b/i;
  const coverageWords = /\b(coverage|covered|protected|protection|backed up)\b/i;
  const changeWords = /\b(chang(e|ed|es)|modified|added|created|removed|deleted|drift(ed)?|edited|updated)\b/i;
  if (failWords.test(text) && jobWords.test(text)) { intent = 'failed-jobs'; hit(failWords); hit(jobWords); }
  else if (coverageWords.test(text)) { intent = 'coverage'; hit(coverageWords); }
  else if (changeWords.test(text)) { intent = 'changes'; hit(changeWords); }
  if (!intent) return { unsupported: 'unknown-intent' };

  const entities = knownEntities.filter((code) => new RegExp(`\\b${code.replace(/_/g, '[ _]')}\\b`, 'i').test(text));
  if (entities.length > 1) return { unsupported: 'several-entities' };
  if (entities.length === 1) {
    params.entity = entities[0];
    hit(new RegExp(`\\b${entities[0].replace(/_/g, '[ _]')}\\b`, 'i'));
  }

  const types = [...new Set(TYPE_WORDS.filter(([pattern]) => pattern.test(text)).map(([, type]) => type))];
  // "group" inside "conditional access policy for a group" is still one question;
  // the more specific phrase wins only when exactly one specific type matched.
  const specific = types.filter((type) => type !== 'group' && type !== 'user');
  if (specific.length > 1 || (specific.length === 0 && types.length > 1)) return { unsupported: 'several-types' };
  const services = [...new Set(SERVICE_WORDS.filter(([pattern]) => pattern.test(text)).map(([, service]) => service))];
  if (types.length) {
    for (const [pattern] of TYPE_WORDS) hit(pattern);
    if (specific.length === 1) params.resourceType = specific[0];
    else params.resourceType = types[0];
  } else if (intent !== 'failed-jobs') {
    // A service and broad kind words ("Teams policies") narrow to the taxonomy's kinds:
    // a kind's full name first, then every kind of the service whose name holds the word.
    const lower = text.toLowerCase();
    const named = Object.values(TAXONOMY).filter((entry) => {
      const name = entry.name.toLowerCase();
      return lower.includes(name) || lower.includes(`${name}s`) || (name.endsWith('y') && lower.includes(`${name.slice(0, -1)}ies`));
    });
    // A broad word narrows only as the subject ("Which policies changed") or next to a
    // service ("changed in Teams policies"); elsewhere it is reported as not understood.
    const verbAt = text.search(intent === 'coverage' ? coverageWords : changeWords);
    const categoryWords = CATEGORY_WORDS.filter(([pattern]) => {
      const at = text.search(pattern);
      return at !== -1 && (services.length > 0 || at < verbAt);
    });
    const categories = categoryWords.map(([, test]) => test);
    let kinds = [];
    if (named.length) {
      kinds = named;
      for (const entry of named) hit(new RegExp(entry.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/y$/i, '(?:y|ies)'), 'i'));
    } else if (services.length || categories.length) {
      kinds = Object.values(TAXONOMY).filter((entry) => (!services.length || services.includes(entry.service))
        && (!categories.length || categories.some((test) => test.test(entry.name))));
      for (const [pattern] of categoryWords) hit(pattern);
      if (!kinds.length) return { unsupported: 'no-such-kind' };
    }
    if (services.length) {
      for (const [pattern] of SERVICE_WORDS) hit(pattern);
      kinds = kinds.filter((entry) => services.includes(entry.service));
      if (named.length && !kinds.length) return { unsupported: 'no-such-kind' };
    }
    if (kinds.length === 1) params.resourceType = kinds[0].type;
    else if (kinds.length > 1) params.resourceTypes = kinds.map((entry) => entry.type).sort();
  }

  if (intent === 'changes') {
    const added = /\b(added|created|new)\b/i;
    const removed = /\b(removed|deleted)\b/i;
    const modified = /\b(modified|edited|updated)\b/i;
    if (added.test(text)) { params.changeType = 'added'; hit(added); }
    else if (removed.test(text)) { params.changeType = 'removed'; hit(removed); }
    else if (modified.test(text)) { params.changeType = 'modified'; hit(modified); }
  }

  if (intent !== 'coverage') {
    const between = new RegExp(`\\b(?:between|from) (${DAY}) (?:and|to|until) (${DAY})\\b`, 'i');
    const since = new RegExp(`\\b(?:since|from|after) (${DAY})\\b`, 'i');
    const on = new RegExp(`\\b(?:on|for) (${DAY})\\b`, 'i');
    const named = PERIOD_WORDS.find(([pattern]) => pattern.test(text));
    const startOf = START_OF.exec(text);
    const betweenMatch = between.exec(text);
    const sinceMatch = since.exec(text);
    const onMatch = on.exec(text);
    const lastMatch = LAST_N.exec(text);
    const agoMatch = AGO.exec(text);
    const days = (...written) => {
      const read = written.map((value) => readDay(value, now));
      const ambiguous = read.find((entry) => entry?.ambiguous);
      if (ambiguous) return { ambiguous: ambiguous.ambiguous };
      return read.every((entry) => entry?.day) ? read : null;
    };
    if (betweenMatch) {
      const read = days(betweenMatch[1], betweenMatch[2]);
      if (read?.ambiguous) return { unsupported: 'ambiguous-date', date: read.ambiguous };
      if (!read) return { unsupported: 'unreadable-date' };
      // The last day named is included: "between 1 Oct and 5 Oct" runs to the end of the 5th.
      params.from = read[0].day;
      params.to = new Date(new Date(`${after(read[0].day, read[1])}T00:00:00Z`).getTime() + DAY_MS).toISOString();
      hit(between);
    } else if (sinceMatch) {
      const read = days(sinceMatch[1]);
      if (read?.ambiguous) return { unsupported: 'ambiguous-date', date: read.ambiguous };
      if (!read) return { unsupported: 'unreadable-date' };
      params.from = read[0].day;
      params.to = now.toISOString();
      hit(since);
    } else if (onMatch) {
      // One day named: that whole day.
      const read = days(onMatch[1]);
      if (read?.ambiguous) return { unsupported: 'ambiguous-date', date: read.ambiguous };
      if (!read) return { unsupported: 'unreadable-date' };
      params.from = read[0].day;
      params.to = new Date(new Date(`${read[0].day}T00:00:00Z`).getTime() + DAY_MS).toISOString();
      hit(on);
    } else if (startOf) {
      const unit = startOf[1].toLowerCase();
      if (unit === 'year') { params.from = `${now.getUTCFullYear()}-01-01`; params.to = now.toISOString(); }
      else params.period = unit === 'month' ? 'this-month' : 'this-week';
      hit(START_OF);
    } else if (agoMatch && !agoMatch[1] && agoMatch[3].toLowerCase() === 'day') {
      // "3 days ago" is that day; "since 3 days ago" runs to now.
      const day = new Date(startOfDay(now).getTime() - Number(agoMatch[2]) * DAY_MS);
      params.from = day.toISOString();
      params.to = new Date(day.getTime() + DAY_MS).toISOString();
      hit(AGO);
    } else if (agoMatch || lastMatch) {
      const [count, unit] = agoMatch ? agoMatch.slice(2) : lastMatch.slice(1);
      params.from = new Date(now.getTime() - Number(count) * UNIT_MS[unit.toLowerCase()]).toISOString();
      params.to = now.toISOString();
      hit(agoMatch ? AGO : LAST_N);
    } else if (WEEKEND.test(text) && !named) {
      // The latest Saturday and Sunday: still running when asked on a weekend.
      const today = startOfDay(now);
      const saturday = new Date(today.getTime() - ((today.getUTCDay() + 1) % 7) * DAY_MS);
      params.from = saturday.toISOString();
      params.to = new Date(Math.min(saturday.getTime() + 2 * DAY_MS, now.getTime())).toISOString();
      hit(WEEKEND);
    } else if (named) { params.period = named[1]; hit(named[0]); }
    else if (UNBOUNDED.test(text)) { params.unbounded = true; hit(UNBOUNDED); }
    else {
      // No period named: answer for this week, and say so.
      params.period = DEFAULT_PERIOD;
      assumed.push('period');
    }
  }

  const ignored = [];
  for (const match of text.matchAll(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)) {
    const start = match.index;
    const end = start + match[0].length;
    if (used.some(([from, to]) => start < to && end > from)) continue;
    const word = match[0].toLowerCase().replace(/['’]s$/, '');
    if (FILLER.has(word) || /^\d+$/.test(word)) continue;
    if (!ignored.includes(match[0])) ignored.push(match[0]);
  }
  return assumed.length ? { intent, params, ignored, assumed } : { intent, params, ignored };
}

/* ------------------------------------------------------------ validate -- */

const VALIDATED = new WeakSet();

/** Whether `plan` came from validateRequest in this process. execute.mjs runs nothing else. */
export function isValidatedPlan(plan) {
  return VALIDATED.has(plan);
}

/**
 * Validate a candidate request against the closed sets and the budget.
 *  - knownEntities: entity codes this tenant's ownership evidence holds (server-side).
 *  - scope: the reader's scope from their grants; an entity outside it is refused.
 * Returns { ok: true, plan } (frozen, branded) or { ok: false, refusal: { code, message } }.
 */
export function validateRequest(candidate, { now = new Date(), knownEntities = [], scope = { central: false, entities: [] } } = {}) {
  if (!isPlainObject(candidate)) return refuse('malformed', 'KEEL could not read this request.');
  const extra = Object.keys(candidate).filter((key) => key !== 'intent' && key !== 'params');
  if (extra.length) return refuse('unexpected-field', 'This request carries something other than a question, so KEEL did not run it.');
  const { intent } = candidate;
  if (!INTENTS.includes(intent)) return refuse('unsupported', 'KEEL can answer questions about changes, coverage and failed jobs only.');
  const params = candidate.params ?? {};
  if (!isPlainObject(params)) return refuse('malformed', 'KEEL could not read this request.');
  const unknownKeys = Object.keys(params).filter((key) => !PARAM_KEYS.includes(key) && key !== 'unbounded');
  if (unknownKeys.length) return refuse('unexpected-field', 'This request carries something other than a question, so KEEL did not run it.');
  for (const [key, value] of Object.entries(params)) {
    if (key === 'resourceTypes' && (value === null || value === undefined || (Array.isArray(value) && value.every((entry) => typeof entry === 'string')))) continue;
    if (value !== undefined && value !== null && typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      return refuse('malformed', `KEEL could not read the ${key} of this request.`);
    }
  }

  const central = scope?.central === true;
  const readerEntities = central ? [] : (Array.isArray(scope?.entities) ? scope.entities.filter((code) => ENTITY_CODE.test(code)) : []);
  if (!central && readerEntities.length === 0) return refuse('no-access', 'You do not have access to this.');

  const plan = { intent, params: { entity: null, from: null, to: null, resourceType: null, resourceTypes: null, name: null, changeType: null, limit: BUDGET.defaultRows } };

  if (params.entity !== undefined && params.entity !== null && params.entity !== '') {
    const entity = String(params.entity).toUpperCase();
    // An entity outside the reader's scope and an entity that does not exist get the
    // same refusal, so a question cannot probe which entities exist.
    const allowed = central ? knownEntities.includes(entity) : readerEntities.includes(entity);
    if (!ENTITY_CODE.test(entity) || !allowed) return refuse('outside-scope', 'You can ask only about resources your access covers.');
    plan.params.entity = entity;
  }
  if (params.resourceType) {
    if (!KNOWN_KINDS.includes(params.resourceType)) return refuse('unknown-type', 'KEEL does not collect that kind of resource.');
    plan.params.resourceType = params.resourceType;
  }
  if (Array.isArray(params.resourceTypes) && params.resourceTypes.length) {
    if (plan.params.resourceType) return refuse('malformed', 'KEEL could not read the kind of resource asked about.');
    if (params.resourceTypes.length > MAX_KINDS || !params.resourceTypes.every((type) => KNOWN_KINDS.includes(type))) {
      return refuse('unknown-type', 'KEEL does not collect that kind of resource.');
    }
    plan.params.resourceTypes = Object.freeze([...new Set(params.resourceTypes)].sort());
  }
  if (params.name !== undefined && params.name !== null && params.name !== '') {
    const name = String(params.name).trim();
    if (!name || name.length > MAX_NAME) return refuse('malformed', `Look for a name of at most ${MAX_NAME} characters.`);
    plan.params.name = name;
  }
  if (params.changeType) {
    if (intent !== 'changes' || !CHANGE_TYPES.includes(params.changeType)) return refuse('malformed', 'KEEL could not read the kind of change asked about.');
    plan.params.changeType = params.changeType;
  }
  if (params.limit !== undefined && params.limit !== null && params.limit !== '') {
    const limit = Number(params.limit);
    if (!Number.isInteger(limit) || limit < 1) return refuse('malformed', 'KEEL could not read how many records to list.');
    if (limit > BUDGET.maxRows) return refuse('unbounded', `An answer lists at most ${BUDGET.maxRows} records. Ask for fewer.`);
    plan.params.limit = limit;
  }

  if (intent === 'failed-jobs' && !central) {
    return refuse('central-only', 'Failed jobs cover the whole tenant, so only a central administrator can ask about them.');
  }
  if (intent === 'failed-jobs' && plan.params.entity) {
    return refuse('unsupported', 'Jobs are not owned by an entity, so KEEL cannot answer this for one entity.');
  }

  if (intent === 'coverage') {
    if (params.period || params.from || params.to || params.unbounded) {
      return refuse('unsupported', 'Coverage is answered for the latest backup only, not for a period.');
    }
  } else {
    if (params.unbounded) return refuse('unbounded', `KEEL answers for a period of at most ${BUDGET.maxWindowDays} days. Name one, for example "this week".`);
    let window = null;
    if (params.period) {
      if (!PERIODS.includes(params.period)) return refuse('malformed', 'KEEL could not read the period asked about.');
      window = periodWindow(params.period, now);
    } else if (params.from || params.to) {
      const from = parseDate(params.from);
      const to = params.to ? parseDate(params.to) : now;
      if (!from || !to) return refuse('malformed', 'KEEL could not read the dates asked about.');
      window = { from, to };
    }
    if (!window) return refuse('unbounded', `KEEL answers for a period of at most ${BUDGET.maxWindowDays} days. Name one, for example "this week".`);
    if (window.to > now) window.to = now;
    if (!(window.from < window.to)) return refuse('malformed', 'The period asked about ends before it starts.');
    if (window.to.getTime() - window.from.getTime() > BUDGET.maxWindowDays * DAY_MS + 60_000) {
      return refuse('unbounded', `KEEL answers for a period of at most ${BUDGET.maxWindowDays} days. Ask about a shorter period.`);
    }
    plan.params.from = window.from.toISOString();
    plan.params.to = window.to.toISOString();
  }

  plan.version = PLAN_VERSION;
  Object.freeze(plan.params);
  const frozen = Object.freeze(plan);
  VALIDATED.add(frozen);
  return { ok: true, plan: frozen };
}

/* ----------------------------------------------------- optional helper -- */

function grounded(value, text) {
  if (value === undefined || value === null || value === '') return true;
  const needle = String(value).toLowerCase().replace(/_/g, ' ');
  return text.toLowerCase().replace(/_/g, ' ').includes(needle);
}

/**
 * Plan a question. `helper` is optional and absent by default: an object with
 * `propose({ question, intents, resourceTypes }) -> { intent, params }`. Whatever it
 * returns is validated like any request, and each entity, period word and date it
 * proposes must appear in the question. A helper that fails, or proposes something the
 * question does not say, falls back to the built-in reading; it never widens it.
 *
 * Returns { ok: true, plan, readBy } or { ok: false, refusal, readBy }.
 */
export async function planQuestion(question, { helper = null, now = new Date(), knownEntities = [], scope } = {}) {
  if (typeof question === 'string' && question.length > BUDGET.maxQuestionLength) {
    return { ...refuse('too-long', `Ask in at most ${BUDGET.maxQuestionLength} characters.`), readBy: 'rules' };
  }
  const builtIn = readQuestion(question, { now, knownEntities });
  if (helper && typeof helper.propose === 'function') {
    let proposal = null;
    try {
      proposal = await helper.propose({ question, intents: [...INTENTS], resourceTypes: [...RESOURCE_TYPES] });
    } catch {
      proposal = null;
    }
    if (isPlainObject(proposal)) {
      const params = isPlainObject(proposal.params) ? proposal.params : {};
      const typeWord = params.resourceType
        ? TYPE_WORDS.find(([, type]) => type === params.resourceType)?.[0]
        : null;
      const isGrounded = grounded(params.entity, question)
        && grounded(params.from && String(params.from).slice(0, 10), question)
        && grounded(params.to && String(params.to).slice(0, 10), question)
        && grounded(params.period ? String(params.period).replace(/-/g, ' ') : null, question)
        && (!params.resourceType || (typeWord ? typeWord.test(question) : grounded(params.resourceType, question)));
      if (isGrounded) {
        const checked = validateRequest(proposal, { now, knownEntities, scope });
        // A refusal from the helper's proposal is a refusal: a request with SQL or a
        // tool in it is never retried in another form.
        return { ...checked, readBy: 'helper' };
      }
    }
  }
  if (builtIn.unsupported) {
    const message = {
      empty: 'Ask a question about changes, coverage or failed jobs.',
      'too-long': `Ask in at most ${BUDGET.maxQuestionLength} characters.`,
      'several-entities': 'Ask about one entity at a time.',
      'several-types': 'Ask about one kind of resource at a time.',
      'no-such-kind': 'KEEL backs up no kind of setting that matches those words.',
      'ambiguous-date': `“${builtIn.date}” could be read day first or month first. Write the date as year-month-day, for example ${now.toISOString().slice(0, 10)}.`,
      'unreadable-date': `KEEL could not read that date. Write it as year-month-day, for example ${now.toISOString().slice(0, 10)}.`,
    }[builtIn.unsupported] ?? 'KEEL can answer questions about changes, coverage and failed jobs only.';
    // A date KEEL could not settle is the reader's to fix, not a question KEEL cannot answer.
    const code = builtIn.unsupported === 'ambiguous-date' || builtIn.unsupported === 'unreadable-date' ? 'malformed' : 'unsupported';
    return { ...refuse(code, message), readBy: 'rules' };
  }
  const { ignored = [], assumed = [], ...candidate } = builtIn;
  return { ...validateRequest(candidate, { now, knownEntities, scope }), readBy: 'rules', ignored, assumed };
}

/** The plan in words, for "Understood as". */
export function describePlan(plan) {
  const { intent, params } = plan;
  const type = params.resourceType ? ` to ${params.resourceType}` : params.resourceTypes ? ` to ${params.resourceTypes.length} kinds` : '';
  const owner = params.entity ? ` owned by ${params.entity}` : '';
  if (intent === 'coverage') return `What the latest backup holds${params.resourceType ? ` for ${params.resourceType}` : ''}${owner}`;
  if (intent === 'failed-jobs') return `Jobs that failed between ${params.from} and ${params.to}`;
  return `${params.changeType ? `${params.changeType[0].toUpperCase()}${params.changeType.slice(1)} resources` : 'Changes'}${type}${owner} detected between ${params.from} and ${params.to}`;
}
