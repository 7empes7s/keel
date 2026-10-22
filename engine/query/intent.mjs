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
  /** The most records an answer lists; the rest are counted. */
  maxRows: 100,
  defaultRows: 100,
  /** The longest question read. */
  maxQuestionLength: 500,
  /** Statement timeout for each read, in milliseconds. */
  statementTimeoutMs: 5000,
});

const DAY = 86_400_000;
const CHANGE_TYPES = Object.freeze(['added', 'modified', 'removed']);
const PARAM_KEYS = Object.freeze(['entity', 'from', 'to', 'period', 'resourceType', 'resourceTypes', 'name', 'changeType', 'limit']);
/** The longest name a question can look for, and the most kinds one question can name. */
const MAX_NAME = 120;
const MAX_KINDS = 60;
const ENTITY_CODE = /^[A-Z][A-Z0-9_]{1,31}$/;
const PERIODS = Object.freeze(['today', 'yesterday', 'this-week', 'last-week', 'last-7-days', 'last-30-days', 'this-month']);

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
  const monday = new Date(today.getTime() - ((today.getUTCDay() + 6) % 7) * DAY);
  switch (period) {
    case 'today': return { from: today, to: now };
    case 'yesterday': return { from: new Date(today.getTime() - DAY), to: today };
    case 'this-week': return { from: monday, to: now };
    case 'last-week': return { from: new Date(monday.getTime() - 7 * DAY), to: monday };
    case 'last-7-days': return { from: new Date(now.getTime() - 7 * DAY), to: now };
    case 'last-30-days': return { from: new Date(now.getTime() - 30 * DAY), to: now };
    case 'this-month': return { from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), to: now };
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
]);
const UNBOUNDED = /\b(ever|all[- ]time|since (the )?beginning|everything|forever|any time)\b/i;

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
    const lastDays = /\b(?:last|past|previous) (\d{1,4}) days?\b/i;
    const between = /\bbetween (\d{4}-\d{2}-\d{2}) and (\d{4}-\d{2}-\d{2})\b/i;
    const since = /\bsince (\d{4}-\d{2}-\d{2})\b/i;
    const named = PERIOD_WORDS.find(([pattern]) => pattern.test(text));
    const betweenMatch = between.exec(text);
    const sinceMatch = since.exec(text);
    const lastMatch = lastDays.exec(text);
    if (betweenMatch) { params.from = betweenMatch[1]; params.to = betweenMatch[2]; hit(between); }
    else if (sinceMatch) { params.from = sinceMatch[1]; params.to = now.toISOString(); hit(since); }
    else if (lastMatch) {
      const days = Number(lastMatch[1]);
      params.from = new Date(now.getTime() - days * DAY).toISOString();
      params.to = now.toISOString();
      hit(lastDays);
    } else if (named) { params.period = named[1]; hit(named[0]); }
    else if (UNBOUNDED.test(text)) { params.unbounded = true; hit(UNBOUNDED); }
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
  return { intent, params, ignored };
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
    if (window.to.getTime() - window.from.getTime() > BUDGET.maxWindowDays * DAY + 60_000) {
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
    }[builtIn.unsupported] ?? 'KEEL can answer questions about changes, coverage and failed jobs only.';
    return { ...refuse('unsupported', message), readBy: 'rules' };
  }
  const { ignored = [], ...candidate } = builtIn;
  return { ...validateRequest(candidate, { now, knownEntities, scope }), readBy: 'rules', ignored };
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
