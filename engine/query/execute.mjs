/**
 * Roadmap task-99: run a validated question plan and answer only from what it returns.
 *
 * - Only plans produced by intent.mjs#validateRequest run. Each intent has a FIXED,
 *   parameterized query below; no text from a question, a helper or a stored record is
 *   ever placed into SQL. Values travel as bind parameters only.
 * - Every read runs in a READ ONLY transaction with a statement timeout, and is rolled
 *   back. Nothing here can write.
 * - The reader's scope comes from the caller's authenticated grants (task 90), never
 *   from the plan, and is applied in the same SQL that counts, through
 *   engine/authz/entityScope.mjs#scopePredicate. An entity asked about is applied the
 *   same way, on top of the reader's scope: it can narrow what is read, never widen it.
 * - Each record cites its source (the change, collection or job it came from) and the
 *   window it covers. Records are data: names and error text are returned as fields and
 *   are never read as instructions or folded into the answer's sentence.
 * - A period KEEL has no comparison for is answered as unknown, never as "no changes".
 */
import { scopePredicate } from '../authz/entityScope.mjs';
import { assertTenantRef } from '../store/tenantRef.mjs';
import { BUDGET, PLAN_VERSION, QueryRefusal, describePlan, isValidatedPlan, planQuestion, validateRequest } from './intent.mjs';

export const ANSWER_VERSION = 1;
const MAX_ERROR_TEXT = 300;
const MAX_NAME_TEXT = 200;

function iso(value) {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function clip(value, max) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Run `operation` inside a read-only transaction with the budget's statement timeout.
 * The transaction is always rolled back. Exported for the boundary test.
 */
export async function readOnly(client, operation) {
  await client.query('BEGIN TRANSACTION READ ONLY');
  try {
    await client.query(`SET LOCAL statement_timeout = ${Number(BUDGET.statementTimeoutMs)}`);
    return await operation();
  } finally {
    await client.query('ROLLBACK');
  }
}

/** Entity codes this tenant's current ownership evidence names. Server-side only. */
export async function knownEntities(client, { tenantRef }) {
  assertTenantRef(tenantRef);
  return readOnly(client, async () => {
    const { rows } = await client.query(
      `SELECT DISTINCT code FROM (
         SELECT entity_code AS code FROM resource_ownership_evidence
          WHERE tenant_ref = $1 AND superseded_at IS NULL AND entity_code IS NOT NULL
         UNION
         SELECT unnest(entity_codes) AS code FROM resource_ownership_evidence
          WHERE tenant_ref = $1 AND superseded_at IS NULL
       ) codes WHERE code IS NOT NULL ORDER BY code
       LIMIT 500`,
      [tenantRef],
    );
    return rows.map((row) => row.code);
  });
}

/* ------------------------------------------------------------ templates -- */

// A change is placed in time by the collection that saw it (its completion), falling
// back to when it was recorded. Comparisons, coverage and the window all use this time.
const SEEN_AT = 'COALESCE(os.completed_at, d.detected_at)';

function filters({ tenantRef, scope, entity, at, typeExpr, keyExpr, asOfExpr, nextParam }) {
  const owner = entity
    ? scopePredicate({ central: false, entities: [entity] }, { tenantRef, typeExpr, keyExpr, asOfExpr, at, nextParam })
    : { sql: 'TRUE', values: [] };
  const reader = scopePredicate(scope, { tenantRef, typeExpr, keyExpr, asOfExpr, at, nextParam: nextParam + owner.values.length });
  return { sql: `(${owner.sql}) AND (${reader.sql})`, values: [...owner.values, ...reader.values] };
}

/** Fixed queries, one per intent. Each returns { rows, total, known, gaps }. */
const TEMPLATES = Object.freeze({
  async changes(client, { tenantRef, scope, params, now }) {
    const where = filters({
      tenantRef, scope, entity: params.entity, at: now,
      typeExpr: 'd.resource_type', keyExpr: 'd.natural_key', asOfExpr: 'd.detected_at', nextParam: 6,
    });
    const base = [tenantRef, params.from, params.to, params.resourceType, params.changeType];
    const condition = `d.tenant_ref = $1 AND ${SEEN_AT} >= $2 AND ${SEEN_AT} < $3
         AND ($4::text IS NULL OR d.resource_type = $4) AND ($5::text IS NULL OR d.change_type = $5)
         AND ${where.sql}`;
    const limitParam = 6 + where.values.length;
    const { rows } = await client.query(
      `SELECT d.id::text AS id, d.natural_key, d.resource_type, d.change_type, d.blast_radius, d.detected_at,
              d.observed_snapshot::text AS collection_id, ${SEEN_AT} AS seen_at,
              (SELECT max(ps.completed_at) FROM snapshot ps
                WHERE ps.tenant_ref = d.tenant_ref AND ps.status = 'complete' AND ps.completed_at < ${SEEN_AT}) AS window_from,
              COALESCE(d.after_payload->>'displayName', d.before_payload->>'displayName') AS display_name,
              (SELECT p.action FROM disposition p WHERE p.drift_id = d.id ORDER BY p.decided_at DESC, p.id DESC LIMIT 1) AS decision
         FROM drift d
         LEFT JOIN snapshot os ON os.id = d.observed_snapshot AND os.tenant_ref = d.tenant_ref
        WHERE ${condition}
        ORDER BY ${SEEN_AT} DESC, d.id
        LIMIT $${limitParam}`,
      [...base, ...where.values, params.limit],
    );
    const { rows: [counted] } = await client.query(
      `SELECT count(*)::int AS total FROM drift d
         LEFT JOIN snapshot os ON os.id = d.observed_snapshot AND os.tenant_ref = d.tenant_ref
        WHERE ${condition}`,
      [...base, ...where.values],
    );
    // What KEEL has compared: complete collections a drift comparison is recorded for.
    // A type-filtered question needs that type to have been read completely.
    const { rows: [history] } = await client.query(
      `SELECT min(s.completed_at) AS first_at, max(s.completed_at) AS last_at, count(*)::int AS collections
         FROM snapshot s
        WHERE s.tenant_ref = $1 AND s.status = 'complete' AND s.completed_at IS NOT NULL
          AND (EXISTS (SELECT 1 FROM drift dd WHERE dd.observed_snapshot = s.id AND dd.tenant_ref = s.tenant_ref)
               OR EXISTS (SELECT 1 FROM job j WHERE j.kind = 'drift-detect' AND j.status = 'succeeded'
                                                  AND j.params->>'snapshotId' = s.id::text))
          AND ($2::text IS NULL OR s.coverage_digest->$2->>'outcome' IN ('complete', 'complete-empty'))`,
      [tenantRef, params.resourceType],
    );
    const known = history?.collections > 0 ? { from: iso(history.first_at), to: iso(history.last_at) } : null;
    return {
      total: Number(counted?.total ?? 0),
      known,
      records: rows.map((row) => ({
        kind: 'change',
        id: row.id,
        resourceType: row.resource_type,
        naturalKey: row.natural_key,
        name: clip(row.display_name, MAX_NAME_TEXT),
        changeType: row.change_type,
        impact: row.blast_radius,
        decision: row.decision ?? null,
        seenAt: iso(row.seen_at),
        window: { from: iso(row.window_from), to: iso(row.seen_at) },
        source: { kind: 'change', id: row.id, href: '/drift', collectionId: row.collection_id },
      })),
    };
  },

  async coverage(client, { tenantRef, scope, params, now }) {
    const { rows: [latest] } = await client.query(
      `SELECT s.id::text AS id, s.started_at, s.completed_at, s.coverage_digest
         FROM snapshot s
        WHERE s.tenant_ref = $1 AND s.status = 'complete' AND s.completed_at IS NOT NULL
        ORDER BY s.completed_at DESC, s.id DESC
        LIMIT 1`,
      [tenantRef],
    );
    if (!latest) return { total: 0, known: null, records: [] };
    const where = filters({
      tenantRef, scope, entity: params.entity, at: now,
      typeExpr: 'rv.resource_type', keyExpr: 'rv.natural_key', asOfExpr: 's.completed_at', nextParam: 3,
    });
    const { rows } = await client.query(
      `SELECT rv.resource_type, count(*)::int AS count
         FROM resource_version rv
         JOIN snapshot s ON s.id = rv.snapshot_id AND s.tenant_ref = $1
        WHERE rv.snapshot_id = $2::uuid AND ${where.sql}
        GROUP BY rv.resource_type`,
      [tenantRef, latest.id, ...where.values],
    );
    const counts = new Map(rows.map((row) => [row.resource_type, Number(row.count)]));
    const digest = latest.coverage_digest && typeof latest.coverage_digest === 'object' && !Array.isArray(latest.coverage_digest)
      ? latest.coverage_digest : {};
    const types = params.resourceType
      ? [params.resourceType]
      : [...new Set([...Object.keys(digest), ...counts.keys()])].sort();
    const records = types.slice(0, BUDGET.maxRows).map((type) => {
      const outcome = typeof digest[type]?.outcome === 'string' ? digest[type].outcome : 'not-recorded';
      const read = outcome === 'complete' || outcome === 'complete-empty';
      return {
        kind: 'coverage',
        id: `${latest.id}/${type}`,
        resourceType: type,
        outcome,
        // A count from a read that did not finish is not a count of what exists.
        count: read ? (counts.get(type) ?? 0) : null,
        window: { from: iso(latest.started_at), to: iso(latest.completed_at) },
        source: { kind: 'collection', id: latest.id, href: '/protect' },
      };
    });
    return { total: types.length, known: { from: iso(latest.completed_at), to: iso(latest.completed_at) }, records };
  },

  async 'failed-jobs'(client, { tenantRef, params }) {
    const condition = `j.status = 'failed' AND COALESCE(j.finished_at, j.created_at) >= $1 AND COALESCE(j.finished_at, j.created_at) < $2
         AND (j.params->>'tenantRef' IS NULL OR j.params->>'tenantRef' = $3)`;
    const { rows } = await client.query(
      `SELECT j.id::text AS id, j.kind, j.error, j.created_at, j.started_at, j.finished_at
         FROM job j WHERE ${condition}
        ORDER BY COALESCE(j.finished_at, j.created_at) DESC, j.id
        LIMIT $4`,
      [params.from, params.to, tenantRef, params.limit],
    );
    const { rows: [counted] } = await client.query(`SELECT count(*)::int AS total FROM job j WHERE ${condition}`, [params.from, params.to, tenantRef]);
    // The job record starts with the first job KEEL kept for this tenant.
    const { rows: [first] } = await client.query(
      `SELECT min(j.created_at) AS first_at FROM job j WHERE j.params->>'tenantRef' IS NULL OR j.params->>'tenantRef' = $1`,
      [tenantRef],
    );
    return {
      total: Number(counted?.total ?? 0),
      known: first?.first_at ? { from: iso(first.first_at), to: params.to } : null,
      records: rows.map((row) => ({
        kind: 'job',
        id: row.id,
        jobKind: row.kind,
        error: clip(row.error, MAX_ERROR_TEXT),
        window: { from: iso(row.started_at ?? row.created_at), to: iso(row.finished_at ?? row.created_at) },
        source: { kind: 'job', id: row.id, href: `/jobs/${row.id}` },
      })),
    };
  },
});

/** The intents a template exists for; equal to intent.mjs#INTENTS. */
export const TEMPLATE_INTENTS = Object.freeze(Object.keys(TEMPLATES));

/* --------------------------------------------------------------- answer -- */

function gapsFor(window, known) {
  if (!window) return [];
  if (!known) return [{ from: window.from, to: window.to, reason: 'no-history' }];
  const gaps = [];
  if (window.from < known.from) gaps.push({ from: window.from, to: known.from < window.to ? known.from : window.to, reason: 'before-history' });
  if (known.to < window.to) gaps.push({ from: known.to > window.from ? known.to : window.from, to: window.to, reason: 'not-compared-yet' });
  return gaps;
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/** The answer's sentence. Built from counts and dates only, never from record text. */
function sentenceFor({ intent, status, total, shown, gaps, known }) {
  if (status === 'unknown') {
    if (intent === 'coverage') return 'Not known: KEEL has no complete backup to answer from.';
    if (intent === 'failed-jobs') return 'Not known: KEEL has no job record for this period.';
    return 'Not known: KEEL has not compared any collection in this period, so it cannot say whether anything changed.';
  }
  const listed = shown < total ? ` Showing the newest ${shown}.` : '';
  if (intent === 'coverage') return `The latest complete backup holds ${plural(total, 'kind')} of resource you may see.${listed}`;
  const noun = intent === 'failed-jobs' ? 'failed job' : 'matching change';
  const found = total === 0 ? `No ${noun}s were found` : `${plural(total, noun)} found`;
  if (status === 'answered') return `${found} in this period.${listed}`;
  const until = gaps.some((gap) => gap.reason === 'not-compared-yet') && known?.to ? ` up to ${known.to}` : '';
  return `${found}${until}. Part of this period is not known yet, so this may not be everything.${listed}`;
}

/**
 * Run a validated plan for the reader. `scope` is the reader's own (task 90); it is
 * never taken from the plan. Throws QueryRefusal for anything that did not come from
 * validateRequest.
 */
export async function executePlan(client, plan, { tenantRef, scope, now = new Date() }) {
  if (!isValidatedPlan(plan) || plan.version !== PLAN_VERSION) {
    throw new QueryRefusal('unvalidated', 'Only a validated question plan can run.');
  }
  assertTenantRef(tenantRef);
  const template = TEMPLATES[plan.intent];
  if (!template) throw new QueryRefusal('unsupported', 'No query exists for this question.');
  const readerScope = scope?.central === true ? { central: true, entities: [] } : { central: false, entities: [...(scope?.entities ?? [])] };
  const result = await readOnly(client, () => template(client, { tenantRef, scope: readerScope, params: plan.params, now }));

  const window = plan.params.from ? { from: plan.params.from, to: plan.params.to } : null;
  const gaps = plan.intent === 'coverage' ? [] : gapsFor(window, result.known);
  const overlaps = plan.intent === 'coverage'
    ? Boolean(result.known)
    : Boolean(result.known && result.known.from < window.to && result.known.to >= window.from);
  // Missing history is unknown. Records found are still listed when part of the period
  // is not known, and the answer says it may not be everything.
  let status;
  if (!overlaps && result.records.length === 0) status = 'unknown';
  else status = gaps.length ? 'partial' : 'answered';

  const shown = result.records.length;
  return {
    version: ANSWER_VERSION,
    status,
    intent: plan.intent,
    plan: { intent: plan.intent, params: { ...plan.params } },
    understood: describePlan(plan),
    scope: readerScope,
    window,
    known: result.known,
    gaps,
    total: result.total,
    shown,
    truncated: shown < result.total,
    records: result.records,
    sentence: sentenceFor({ intent: plan.intent, status, total: result.total, shown, gaps, known: result.known }),
    generatedAt: now.toISOString(),
  };
}

function refusalAnswer(refusal, { scope, now, readBy, question }) {
  // An unsupported question is unknown (KEEL cannot answer it); anything else is refused.
  const status = refusal.code === 'unsupported' ? 'unknown' : 'refused';
  return {
    version: ANSWER_VERSION,
    status,
    intent: null,
    plan: null,
    understood: null,
    scope: scope?.central === true ? { central: true, entities: [] } : { central: false, entities: [...(scope?.entities ?? [])] },
    window: null,
    known: null,
    gaps: [],
    total: 0,
    shown: 0,
    truncated: false,
    records: [],
    refusal,
    readBy,
    question: typeof question === 'string' ? question.slice(0, BUDGET.maxQuestionLength) : null,
    sentence: refusal.message,
    generatedAt: now.toISOString(),
  };
}

/**
 * Answer a question (free text) or a structured request ({ intent, params }) for a
 * reader. `helper` is optional and absent by default (intent.mjs#planQuestion).
 *
 * @param {any} client
 * @param {{ tenantRef: string, scope: { central: boolean, entities: string[] }, question?: string | null,
 *   request?: Record<string, unknown> | null, helper?: { propose: Function } | null, now?: Date }} options
 */
export async function answerQuestion(client, { tenantRef, scope, question = null, request = null, helper = null, now = new Date() }) {
  assertTenantRef(tenantRef);
  const entities = await knownEntities(client, { tenantRef });
  let planned;
  if (request) planned = { ...validateRequest(request, { now, knownEntities: entities, scope }), readBy: 'form' };
  else planned = await planQuestion(question, { helper, now, knownEntities: entities, scope });
  if (!planned.ok) return refusalAnswer(planned.refusal, { scope, now, readBy: planned.readBy, question });
  const answer = await executePlan(client, planned.plan, { tenantRef, scope, now });
  return { ...answer, readBy: planned.readBy, question: typeof question === 'string' ? question.slice(0, BUDGET.maxQuestionLength) : null };
}
