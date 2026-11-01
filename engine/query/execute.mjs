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
import { objectNameSql } from '../cir/objectName.mjs';
import { DESCRIPTORS } from '../collect/descriptors.mjs';
import { scopePredicate } from '../authz/entityScope.mjs';
import { contentWorkloadInfo, loadServiceBackups } from '../coverage/serviceBackups.mjs';
import { storedTypeOf, subkindFamilies, typeInfo } from '../insights/taxonomy.mjs';
import { assertTenantRef } from '../store/tenantRef.mjs';
import { RECORDED_CHANGE_PREDICATE } from '../store/openDrift.mjs';
import { BUDGET, PLAN_VERSION, QueryRefusal, RESOURCE_TYPES, describePlan, isValidatedPlan, planQuestion, validateRequest } from './intent.mjs';

export const ANSWER_VERSION = 1;
const MAX_ERROR_TEXT = 300;
const MAX_NAME_TEXT = 200;
const MAX_FIELDS = 12;

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
// The template family a settings catalog policy's copy carries (templateReference); read
// for those rows alone, so the other rows' payloads stay out of the sort.
const TEMPLATE_FAMILY_SQL = `CASE WHEN d.resource_type = 'configurationPolicy'
  THEN COALESCE(d.after_payload->'templateReference'->>'templateFamily', d.before_payload->'templateReference'->>'templateFamily') END`;

// A kind can be a part of a stored type that lists file under another service: Intune
// settings catalog policies made from an endpoint security template are Defender's
// "Endpoint security policy" (insights/taxonomy.mjs#settingKind). The stored type is
// read, and each row's kind comes from its template family. The map is the taxonomy's,
// never a question's, and travels as a bind parameter.
const SUBKIND_FAMILIES = JSON.stringify(subkindFamilies());
const familyOf = (payload) => `(${payload}->'templateReference'->>'templateFamily')`;
/** The kind one stored row files under, from its stored type and payloads. */
const kindSql = (typeExpr, familyExpr, param) => `COALESCE($${param}::jsonb->${typeExpr}->>${familyExpr}, ${typeExpr})`;

/** The stored types to read for the kinds asked about, and the kinds to keep among them
 *  (null when every kind asked about is a stored type, so no row needs telling apart). */
function readKinds(params) {
  const kinds = params.resourceTypes ? [...params.resourceTypes] : params.resourceType ? [params.resourceType] : null;
  if (!kinds) return { stored: null, kinds: null };
  const stored = [...new Set(kinds.map(storedTypeOf))].sort();
  const split = subkindFamilies();
  return { stored, kinds: stored.some((type) => split[type]) ? kinds : null };
}

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
      typeExpr: 'd.resource_type', keyExpr: 'd.natural_key', asOfExpr: 'd.detected_at', nextParam: 10,
    });
    // A name is looked for anywhere in the saved name or key, as typed (no wildcards).
    const name = params.name ? `%${String(params.name).replace(/[\\%_]/g, (char) => `\\${char}`)}%` : null;
    // The stored type ($4) or types ($6) narrow the read; the kinds asked about then keep
    // the rows that file under them ($8), so "Defender" holds the endpoint security
    // policies and "settings catalog" the rest.
    const read = readKinds(params);
    const kind = kindSql('d.resource_type', `COALESCE(${familyOf('d.after_payload')}, ${familyOf('d.before_payload')})`, 9);
    const single = read.stored?.length === 1 && !params.resourceTypes;
    const base = [tenantRef, params.from, params.to, single ? read.stored[0] : null, params.changeType,
      read.stored && !single ? read.stored : null, name, read.kinds, SUBKIND_FAMILIES];
    const condition = `d.tenant_ref = $1 AND ${SEEN_AT} >= $2 AND ${SEEN_AT} < $3 AND ${RECORDED_CHANGE_PREDICATE}
         AND ($4::text IS NULL OR d.resource_type = $4) AND ($5::text IS NULL OR d.change_type = $5)
         AND ($6::text[] IS NULL OR d.resource_type = ANY($6::text[]))
         AND ($8::text[] IS NULL OR ${kind} = ANY($8::text[]))
         AND ($7::text IS NULL OR COALESCE(${objectNameSql('d.after_payload', 'd.resource_type')}, ${objectNameSql('d.before_payload', 'd.resource_type')}, d.natural_key) ILIKE $7
              OR d.natural_key ILIKE $7)
         AND ${where.sql}`;
    const limitParam = 10 + where.values.length;
    // One row per resource: a change seen again in a later backup is the same change, so
    // its newest sighting in the period stands for it, and the count is of resources.
    // Only narrow columns go through this sort: a month can hold many thousands of rows,
    // and the payloads are read for the listed page alone.
    const matched = `WITH matched AS (
       SELECT DISTINCT ON (d.resource_type, d.natural_key)
              d.id, d.tenant_ref, d.natural_key, d.resource_type, d.change_type, d.blast_radius,
              d.detected_at, d.observed_snapshot, ${SEEN_AT} AS seen_at,
              -- An endpoint security policy made in Intune is listed under Defender
              -- (taxonomy settingKind); only settings catalog policies carry one.
              ${TEMPLATE_FAMILY_SQL} AS template_family
         FROM drift d
         LEFT JOIN snapshot os ON os.id = d.observed_snapshot AND os.tenant_ref = d.tenant_ref
        WHERE ${condition}
        ORDER BY d.resource_type, d.natural_key, ${SEEN_AT} DESC, d.id DESC
     )`;
    const { rows } = await client.query(
      `${matched},
       page AS (
         SELECT m.* FROM matched m ORDER BY m.seen_at DESC, m.id LIMIT $${limitParam}
       ),
       -- The change happened after the last backup that read this kind completely:
       -- a backup of other kinds that finished a moment before says nothing about it.
       -- Looked up once per kind and sighting, walking back from the sighting along
       -- snapshot_complete_time_idx, so each lookup stops at the first backup that read it.
       opened AS (
         SELECT p.tenant_ref, p.resource_type, p.seen_at,
                (SELECT ps.completed_at FROM snapshot ps
                  WHERE ps.tenant_ref = p.tenant_ref AND ps.status = 'complete' AND ps.completed_at < p.seen_at
                    AND ps.coverage_digest->p.resource_type->>'outcome' IN ('complete', 'complete-empty')
                  ORDER BY ps.completed_at DESC LIMIT 1) AS window_from
           FROM (SELECT DISTINCT tenant_ref, resource_type, seen_at FROM page) p
       )
       SELECT m.id::text AS id, m.natural_key, m.resource_type, m.template_family, m.change_type, m.blast_radius, m.detected_at,
              m.observed_snapshot::text AS collection_id, m.seen_at, o.window_from,
              -- An admin role reads as built-in or custom (taxonomy objectTypeName).
              COALESCE(d.after_payload->'isBuiltIn', d.before_payload->'isBuiltIn') AS is_built_in,
              COALESCE(${objectNameSql('d.after_payload', 'd.resource_type')}, ${objectNameSql('d.before_payload', 'd.resource_type')}) AS display_name,
              CASE WHEN m.change_type = 'modified' AND jsonb_typeof(d.before_payload) = 'object' AND jsonb_typeof(d.after_payload) = 'object'
                   THEN ARRAY(SELECT k FROM (SELECT jsonb_object_keys(d.before_payload) UNION SELECT jsonb_object_keys(d.after_payload)) keys(k)
                               WHERE d.before_payload->k IS DISTINCT FROM d.after_payload->k ORDER BY k LIMIT ${MAX_FIELDS + 1})
              END AS fields,
              (SELECT p.action FROM disposition p WHERE p.drift_id = m.id ORDER BY p.decided_at DESC, p.id DESC LIMIT 1) AS decision
         FROM page m
         JOIN drift d ON d.id = m.id
         LEFT JOIN opened o ON o.tenant_ref = m.tenant_ref AND o.resource_type = m.resource_type AND o.seen_at = m.seen_at
        ORDER BY m.seen_at DESC, m.id`,
      [...base, ...where.values, params.limit],
    );
    // Every matching change counted by kind, change and risk, so the answer can be
    // summarised beyond the rows it lists.
    const { rows: grouped } = await client.query(
      `${matched}
       SELECT m.resource_type, m.template_family, m.change_type, m.blast_radius, count(*)::int AS n FROM matched m
        GROUP BY m.resource_type, m.template_family, m.change_type, m.blast_radius
        ORDER BY m.resource_type, m.template_family NULLS FIRST, m.change_type, m.blast_radius`,
      [...base, ...where.values],
    );
    const counted = { total: grouped.reduce((sum, row) => sum + Number(row.n), 0) };
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
      [tenantRef, params.resourceType ? storedTypeOf(params.resourceType) : null],
    );
    const known = history?.collections > 0 ? { from: iso(history.first_at), to: iso(history.last_at) } : null;
    // When the kind asked about is next read: users are read once a day, not every hour,
    // so a gap since the last read is expected until then.
    const tier = DESCRIPTORS.find((entry) => entry.type === storedTypeOf(params.resourceType))?.criticality ?? null;
    const { rows: [schedule] } = tier ? await client.query(
      `SELECT cadence, cron_override, next_due_at FROM schedule
        WHERE tenant_ref = $1 AND job_kind = 'collect' AND tier = $2 AND enabled
        ORDER BY next_due_at LIMIT 1`,
      [tenantRef, tier],
    ) : { rows: [] };
    // A raw cron override sets the times itself: only the next due time is said then.
    const every = !schedule?.cron_override && typeof schedule?.cadence?.every === 'string' ? schedule.cadence.every : null;
    return {
      total: Number(counted?.total ?? 0),
      known,
      nextRead: schedule ? { every, n: Number(schedule.cadence?.n ?? 1) || 1, dueAt: iso(schedule.next_due_at) } : null,
      summary: grouped.map((row) => ({
        resourceType: row.resource_type, ...(row.template_family ? { templateFamily: row.template_family } : {}),
        changeType: row.change_type, impact: row.blast_radius, count: Number(row.n),
      })),
      records: rows.map((row) => ({
        kind: 'change',
        id: row.id,
        resourceType: row.resource_type,
        ...(row.template_family ? { templateFamily: row.template_family } : {}),
        ...(typeof row.is_built_in === 'boolean' ? { builtIn: row.is_built_in } : {}),
        naturalKey: row.natural_key,
        name: clip(row.display_name, MAX_NAME_TEXT),
        changeType: row.change_type,
        impact: row.blast_radius,
        decision: row.decision ?? null,
        seenAt: iso(row.seen_at),
        // The settings that differ; more than MAX_FIELDS reads as "many".
        fields: Array.isArray(row.fields) ? row.fields.slice(0, MAX_FIELDS) : null,
        moreFields: Array.isArray(row.fields) && row.fields.length > MAX_FIELDS,
        window: { from: iso(row.window_from), to: iso(row.seen_at) },
        source: { kind: 'change', id: row.id, href: '/changes', collectionId: row.collection_id },
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
    const records = [];
    let known = null;
    if (latest) {
      const where = filters({
        tenantRef, scope, entity: params.entity, at: now,
        typeExpr: 'rv.resource_type', keyExpr: 'rv.natural_key', asOfExpr: 's.completed_at', nextParam: 3,
      });
      // Counted by the kind each object files under: endpoint security policies apart from
      // the rest of the settings catalog.
      const kindParam = 3 + where.values.length;
      const { rows } = await client.query(
        `SELECT ${kindSql('rv.resource_type', familyOf('rv.payload'), kindParam)} AS kind, count(*)::int AS count
           FROM resource_version rv
           JOIN snapshot s ON s.id = rv.snapshot_id AND s.tenant_ref = $1
          WHERE rv.snapshot_id = $2::uuid AND ${where.sql}
          GROUP BY 1`,
        [tenantRef, latest.id, ...where.values, SUBKIND_FAMILIES],
      );
      const counts = new Map(rows.map((row) => [row.kind, Number(row.count)]));
      const digest = latest.coverage_digest && typeof latest.coverage_digest === 'object' && !Array.isArray(latest.coverage_digest)
        ? latest.coverage_digest : {};
      // A part of a stored type is read with it, so it is listed wherever that type is.
      const parts = [...new Set(Object.values(subkindFamilies()).flatMap((families) => Object.values(families)))];
      const types = params.resourceType && RESOURCE_TYPES.includes(storedTypeOf(params.resourceType))
        ? [params.resourceType]
        : [...new Set([...Object.keys(digest), ...counts.keys(), ...parts.filter((part) => digest[storedTypeOf(part)])])].sort();
      for (const type of types) {
        const entry = digest[storedTypeOf(type)];
        const outcome = typeof entry?.outcome === 'string' ? entry.outcome : 'not-recorded';
        const read = outcome === 'complete' || outcome === 'complete-empty';
        records.push({
          kind: 'coverage',
          backup: 'settings',
          id: `${latest.id}/${type}`,
          resourceType: type,
          name: null,
          service: typeInfo(type).service ?? null,
          outcome,
          // A count from a read that did not finish is not a count of what exists.
          count: read ? (counts.get(type) ?? 0) : null,
          window: { from: iso(latest.started_at), to: iso(latest.completed_at) },
          source: { kind: 'collection', id: latest.id, href: '/protect' },
        });
      }
      known = { from: iso(latest.completed_at), to: iso(latest.completed_at) };
    }
    // Service settings and content backups have no owning entity, so only a reader of the
    // whole tenant sees them, and a question about one Entra ID or Intune type leaves them out.
    // They come first: there are a dozen or so, while the settings types run past the
    // row budget, so listing them after the types would cut them from the answer.
    if (scope.central === true && !params.entity && (!params.resourceType || !RESOURCE_TYPES.includes(storedTypeOf(params.resourceType)))) {
      const typeRecords = records.splice(0);
      const services = await loadServiceBackups(client, { tenantRef });
      for (const entry of services.settings) {
        const good = entry.lastGood;
        const outcome = entry.switchedOn ? entry.latest.outcome : 'disabled';
        records.push({
          kind: 'coverage',
          backup: 'service-settings',
          id: `workload/${entry.workload}`,
          resourceType: entry.workload,
          name: typeInfo(entry.workload).name ?? null,
          service: typeInfo(entry.workload).service ?? null,
          outcome,
          // The settings the last good read holds; none is known until one finished.
          count: good ? good.settings : null,
          lastGoodAt: good?.at ?? null,
          window: { from: good?.from ?? null, to: good?.at ?? entry.latest.at },
          source: { kind: 'collection', id: good?.id ?? entry.latest.id, href: '/protect' },
        });
      }
      for (const entry of services.content) {
        const info = contentWorkloadInfo(entry.workload);
        const good = entry.lastGood;
        records.push({
          kind: 'coverage',
          backup: 'content',
          id: `content/${entry.workload}`,
          resourceType: entry.workload,
          name: info.name,
          service: info.service,
          outcome: entry.latest?.outcome ?? 'not-recorded',
          // Distinct items held in the content store, across every run.
          count: entry.stored ? entry.stored.items : null,
          bytes: entry.stored ? entry.stored.bytes : null,
          lastGoodAt: good?.at ?? null,
          window: { from: good?.from ?? null, to: good?.at ?? entry.latest?.at ?? entry.stored?.newestAt ?? null },
          source: { kind: 'collection', id: good?.id ?? entry.latest?.id ?? `content/${entry.workload}`, href: '/protect' },
        });
      }
      const times = records.map((record) => record.window.to).filter(Boolean).sort();
      records.push(...typeRecords);
      if (times.length) {
        known = known
          ? { from: [known.from, times[0]].sort()[0], to: [known.to, times.at(-1)].sort().at(-1) }
          : { from: times[0], to: times.at(-1) };
      }
    }
    // Kinds and names asked about narrow every row, settings types and service reads alike.
    const kinds = params.resourceTypes ? new Set(params.resourceTypes) : params.resourceType ? new Set([params.resourceType]) : null;
    const needle = params.name ? String(params.name).toLowerCase() : null;
    const kept = records.filter((record) => (!kinds || kinds.has(record.resourceType))
      && (!needle || `${record.name ?? ''} ${typeInfo(record.resourceType).name}`.toLowerCase().includes(needle)));
    if (kept.length === 0) return { total: 0, known: records.length ? known : null, records: [] };
    return { total: kept.length, known, records: kept.slice(0, BUDGET.maxRows) };
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
  if (intent === 'coverage') return `The latest backups hold ${plural(total, 'kind')} of resource you may see.${listed}`;
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
    summary: result.summary ?? null,
    nextRead: result.nextRead ?? null,
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
  // Words the reading did not use are returned, so the page can say what it ignored.
  return { ...answer, readBy: planned.readBy, ignored: planned.ignored ?? [], assumed: planned.assumed ?? [], question: typeof question === 'string' ? question.slice(0, BUDGET.maxQuestionLength) : null };
}
