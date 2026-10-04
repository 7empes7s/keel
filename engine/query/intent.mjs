/**
 * Roadmap task-99: bounded, grounded tenant questions.
 *
 * A question becomes one of a FIXED set of intents (changes, coverage, failed jobs).
 * Each intent has a fixed, parameterized read-only query (engine/query/execute.mjs);
 * nothing here produces SQL. This module only turns a question, or a structured
 * request, into a validated plan:
 *
 *   { intent, params: { entity, from, to, resourceType, changeType, limit } }
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

export const PLAN_VERSION = 1;

export const INTENTS = Object.freeze(['changes', 'coverage', 'failed-jobs']);

export const BUDGET = Object.freeze({
  /** The longest period a changes or failed-jobs question may cover. */
  maxWindowDays: 31,
  /** The most records an answer lists; the rest are counted. */
  maxRows: 100,
  defaultRows: 25,
  /** The longest question read. */
  maxQuestionLength: 500,
  /** Statement timeout for each read, in milliseconds. */
  statementTimeoutMs: 5000,
});

const DAY = 86_400_000;
const CHANGE_TYPES = Object.freeze(['added', 'modified', 'removed']);
const PARAM_KEYS = Object.freeze(['entity', 'from', 'to', 'period', 'resourceType', 'changeType', 'limit']);
const ENTITY_CODE = /^[A-Z][A-Z0-9_]{1,31}$/;
const PERIODS = Object.freeze(['today', 'yesterday', 'this-week', 'last-week', 'last-7-days', 'last-30-days', 'this-month']);

export const RESOURCE_TYPES = Object.freeze(DESCRIPTORS.map(({ type }) => type));

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

  let intent = null;
  if (/\bfail(ed|ures?|ing)?\b/i.test(text) && /\b(jobs?|runs?|tasks?|backups?|collections?)\b/i.test(text)) intent = 'failed-jobs';
  else if (/\b(coverage|covered|protected|protection|backed up)\b/i.test(text)) intent = 'coverage';
  else if (/\b(chang(e|ed|es)|modified|added|created|removed|deleted|drift(ed)?|edited|updated)\b/i.test(text)) intent = 'changes';
  if (!intent) return { unsupported: 'unknown-intent' };

  const params = {};
  const entities = knownEntities.filter((code) => new RegExp(`\\b${code.replace(/_/g, '[ _]')}\\b`, 'i').test(text));
  if (entities.length > 1) return { unsupported: 'several-entities' };
  if (entities.length === 1) params.entity = entities[0];

  const types = [...new Set(TYPE_WORDS.filter(([pattern]) => pattern.test(text)).map(([, type]) => type))];
  // "group" inside "conditional access policy for a group" is still one question;
  // the more specific phrase wins only when exactly one specific type matched.
  const specific = types.filter((type) => type !== 'group' && type !== 'user');
  if (specific.length > 1 || (specific.length === 0 && types.length > 1)) return { unsupported: 'several-types' };
  if (specific.length === 1) params.resourceType = specific[0];
  else if (types.length === 1) params.resourceType = types[0];

  if (intent === 'changes') {
    if (/\b(added|created|new)\b/i.test(text)) params.changeType = 'added';
    else if (/\b(removed|deleted)\b/i.test(text)) params.changeType = 'removed';
    else if (/\b(modified|edited|updated)\b/i.test(text)) params.changeType = 'modified';
  }

  if (intent !== 'coverage') {
    const lastDays = /\b(?:last|past|previous) (\d{1,4}) days?\b/i.exec(text);
    const between = /\bbetween (\d{4}-\d{2}-\d{2}) and (\d{4}-\d{2}-\d{2})\b/i.exec(text);
    const since = /\bsince (\d{4}-\d{2}-\d{2})\b/i.exec(text);
    const named = PERIOD_WORDS.find(([pattern]) => pattern.test(text));
    if (between) { params.from = between[1]; params.to = between[2]; }
    else if (since) { params.from = since[1]; params.to = now.toISOString(); }
    else if (lastDays) {
      const days = Number(lastDays[1]);
      params.from = new Date(now.getTime() - days * DAY).toISOString();
      params.to = now.toISOString();
    } else if (named) params.period = named[1];
    else if (UNBOUNDED.test(text)) params.unbounded = true;
  }
  return { intent, params };
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
    if (value !== undefined && value !== null && typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      return refuse('malformed', `KEEL could not read the ${key} of this request.`);
    }
  }

  const central = scope?.central === true;
  const readerEntities = central ? [] : (Array.isArray(scope?.entities) ? scope.entities.filter((code) => ENTITY_CODE.test(code)) : []);
  if (!central && readerEntities.length === 0) return refuse('no-access', 'You do not have access to this.');

  const plan = { intent, params: { entity: null, from: null, to: null, resourceType: null, changeType: null, limit: BUDGET.defaultRows } };

  if (params.entity !== undefined && params.entity !== null && params.entity !== '') {
    const entity = String(params.entity).toUpperCase();
    // An entity outside the reader's scope and an entity that does not exist get the
    // same refusal, so a question cannot probe which entities exist.
    const allowed = central ? knownEntities.includes(entity) : readerEntities.includes(entity);
    if (!ENTITY_CODE.test(entity) || !allowed) return refuse('outside-scope', 'You can ask only about resources your access covers.');
    plan.params.entity = entity;
  }
  if (params.resourceType) {
    if (!RESOURCE_TYPES.includes(params.resourceType)) return refuse('unknown-type', 'KEEL does not collect that kind of resource.');
    plan.params.resourceType = params.resourceType;
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
    }[builtIn.unsupported] ?? 'KEEL can answer questions about changes, coverage and failed jobs only.';
    return { ...refuse('unsupported', message), readBy: 'rules' };
  }
  return { ...validateRequest(builtIn, { now, knownEntities, scope }), readBy: 'rules' };
}

/** The plan in words, for "Understood as". */
export function describePlan(plan) {
  const { intent, params } = plan;
  const type = params.resourceType ? ` to ${params.resourceType}` : '';
  const owner = params.entity ? ` owned by ${params.entity}` : '';
  if (intent === 'coverage') return `What the latest backup holds${params.resourceType ? ` for ${params.resourceType}` : ''}${owner}`;
  if (intent === 'failed-jobs') return `Jobs that failed between ${params.from} and ${params.to}`;
  return `${params.changeType ? `${params.changeType[0].toUpperCase()}${params.changeType.slice(1)} resources` : 'Changes'}${type}${owner} detected between ${params.from} and ${params.to}`;
}
