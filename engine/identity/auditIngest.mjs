import { randomUUID } from 'node:crypto';
import { can } from '../authz/can.mjs';
import { findPrincipalById } from '../authz/principals.mjs';
import { defineEvent } from '../telemetry/events.mjs';
import { redactSecrets } from '../../tools/tenant-probe/graph.mjs';
import { auditSizing } from './auditSizing.mjs';

// Explicit, additive and retry-safe migration; never invoked by a read or disabled worker.
export async function migrateAuditIngestion(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS audit_ingest_state (
      tenant_ref text NOT NULL, source text NOT NULL,
      cursor bigint, window_from timestamptz, window_until timestamptz,
      complete boolean NOT NULL DEFAULT false,
      PRIMARY KEY (tenant_ref, source)
    );
    ALTER TABLE audit_ingest_state ADD COLUMN IF NOT EXISTS retention_gap jsonb;
    CREATE TABLE IF NOT EXISTS audit_ingest_event (
      tenant_ref text NOT NULL, source text NOT NULL, source_event_id text NOT NULL,
      occurred_at timestamptz NOT NULL,
      PRIMARY KEY (tenant_ref, source, source_event_id)
    );
    CREATE INDEX IF NOT EXISTS audit_ingest_event_retention ON audit_ingest_event(tenant_ref, source, occurred_at);
    CREATE TABLE IF NOT EXISTS audit_ingest_run (
      id uuid PRIMARY KEY, tenant_ref text NOT NULL, source text NOT NULL,
      started_at timestamptz NOT NULL DEFAULT now(), evidence jsonb NOT NULL
    );
    CREATE INDEX IF NOT EXISTS audit_ingest_run_tenant ON audit_ingest_run(tenant_ref, source, started_at DESC);
  `);
}

function safeRef(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_:.\-]{1,128}$/.test(value) || redactSecrets(value) !== value) {
    throw new Error('invalid reference');
  }
  return value;
}
function instant(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error('invalid time window');
  return new Date(value).toISOString();
}
async function authorize(client, options, capability) {
  if (!options.managedTenantRef || options.tenantRef !== options.managedTenantRef) throw new Error('tenant mismatch');
  // Existing KEEL tenant references include canonical SHA-256 digests; these
  // are identity references, not bearer tokens.
  if (!/^sha256:[a-f0-9]{64}$/.test(options.tenantRef)) safeRef(options.tenantRef);
  if (!['audit', 'sign-in'].includes(options.source)) throw new Error('unsupported audit source');
  const principal = await findPrincipalById(client, options.requestedBy);
  if (!principal || !await can(client, principal, capability)) throw new Error('not authorized for audit ingestion');
}
function positive(value, maximum, name) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`invalid ${name} budget`);
}

// Legacy installations have no audit tables: absence is unknown/not configured, never empty success.
export async function readAuditEvidence(client, options) {
  await authorize(client, options, 'read');
  const exists = await client.query("SELECT to_regclass('audit_ingest_state') AS name");
  if (!exists.rows[0].name) return { status: 'not-configured', eventCount: null, state: null, runs: [] };
  const args = [options.tenantRef, options.source];
  const state = await client.query('SELECT * FROM audit_ingest_state WHERE tenant_ref=$1 AND source=$2', args);
  const count = await client.query('SELECT count(*) FROM audit_ingest_event WHERE tenant_ref=$1 AND source=$2', args);
  const runs = await client.query('SELECT * FROM audit_ingest_run WHERE tenant_ref=$1 AND source=$2 ORDER BY started_at DESC, id DESC LIMIT 100', args);
  return { status: state.rows.length ? 'configured' : 'not-configured', state: state.rows[0] ?? null,
    eventCount: Number(count.rows[0].count), runs: runs.rows };
}

/** Read-only injected adapter contract. No credential acquisition or tenant writes.
 * readPage({source, from, until, cursor, limit, signal}) returns
 * {events:[{id,occurredAt}], nextCursor: nonnegative integer|null, availableFrom?: ISO}.
 * Cursors identify positions in a stable bounded window; adapters must preserve that
 * window across restarts. Opaque URLs/tokens cannot be used as persisted cursors.
 */
export async function ingestAudit(client, options) {
  await authorize(client, options, 'collect');
  if (options.enabled !== true) return { status: 'disabled' };
  const { tenantRef, source, adapter, archiveRef } = options;
  const from = instant(options.from), until = instant(options.until);
  if (from > until || Date.parse(until) - Date.parse(from) > 90 * 86400000) throw new Error('invalid time window');
  const maxRequests = options.maxRequests ?? 10, maxEvents = options.maxEvents ?? 1000;
  const maxDurationMs = options.maxDurationMs ?? 30000, pageSize = options.pageSize ?? 100;
  const retentionDays = options.retentionDays ?? 30;
  positive(maxRequests, 100, 'request'); positive(maxEvents, 10000, 'event');
  positive(maxDurationMs, 60000, 'time'); positive(pageSize, 1000, 'page'); positive(retentionDays, 90, 'retention');
  auditSizing({ observedEvents: 0, storedBytes: 0, requests: 0, durationMs: 0, synthetic: true, costInputs: options.costInputs });
  if (archiveRef !== undefined) safeRef(archiveRef);
  else if (!adapter || adapter.credentialMode !== 'collector-read-only' || adapter.tenantRef !== tenantRef
    || typeof adapter.synthetic !== 'boolean' || typeof adapter.readPage !== 'function') throw new Error('tenant-bound read-only collector adapter required');
  const lockKey = JSON.stringify(['audit-ingest', tenantRef, source]);
  const locked = await client.query('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked', [lockKey]);
  if (!locked.rows[0].locked) return { status: 'busy' };
  const runId = randomUUID(), started = Date.now();
  const evidence = { status: 'running', requests: 0, observedEvents: 0, insertedEvents: 0, storedBytes: 0,
    retentionGap: null, synthetic: archiveRef === undefined ? adapter.synthetic : false,
    window: { from, until }, transitions: ['running'] };
  let runCreated = false;
  const save = async (status) => {
    await authorize(client, options, 'collect');
    evidence.status = status;
    if (evidence.transitions.at(-1) !== status) evidence.transitions.push(status);
    evidence.sizing = auditSizing({ ...evidence, durationMs: Date.now() - started, costInputs: options.costInputs });
    evidence.envelope = defineEvent({ tenantRef, eventType: `audit-ingest.${status}`,
      source: { component: 'audit-ingest', instanceId: source }, correlationId: runId,
      sourceEventId: `${runId}:${status}`, observedAt: new Date(started),
      payload: { status, requests: evidence.requests, insertedEvents: evidence.insertedEvents, retentionGap: evidence.retentionGap } });
    await client.query('UPDATE audit_ingest_run SET evidence=$2 WHERE id=$1 AND tenant_ref=$3', [runId, evidence, tenantRef]);
    await client.query(`DELETE FROM audit_ingest_run WHERE tenant_ref=$1 AND source=$2
      AND id<>$3 AND started_at < now() - $4 * interval '1 day'`, [tenantRef, source, runId, retentionDays]);
    return evidence;
  };
  try {
    await client.query('INSERT INTO audit_ingest_run(id, tenant_ref, source, evidence) VALUES ($1,$2,$3,$4)', [runId, tenantRef, source, evidence]);
    runCreated = true;
    if (archiveRef !== undefined) {
      evidence.archiveRef = archiveRef;
      return await save('archive-reference');
    }
    await client.query('INSERT INTO audit_ingest_state(tenant_ref,source) VALUES ($1,$2) ON CONFLICT DO NOTHING', [tenantRef, source]);
    const { rows: [state] } = await client.query('SELECT * FROM audit_ingest_state WHERE tenant_ref=$1 AND source=$2', [tenantRef, source]);
    let cursor = state.cursor === null ? null : Number(state.cursor);
    let windowFrom = from;
    if (state.window_until && !state.complete) {
      // Never apply an old page offset to a newly requested window.
      if (from > state.window_from.toISOString() || state.window_until.toISOString() !== until) throw new Error('unfinished time window must be resumed');
      windowFrom = state.window_from.toISOString();
    } else if (state.complete) {
      windowFrom = state.window_until.toISOString();
      if (until < windowFrom) throw new Error('time window cannot move backwards');
      cursor = null;
    }
    evidence.window.from = windowFrom;
    let status = 'budget-exhausted';
    while (evidence.requests < maxRequests && evidence.observedEvents < maxEvents && Date.now() - started < maxDurationMs) {
      await authorize(client, options, 'collect');
      const controller = new AbortController();
      let timer;
      let page;
      const remaining = maxDurationMs - (Date.now() - started);
      if (remaining <= 0) break;
      const limit = Math.min(pageSize, maxEvents - evidence.observedEvents);
      try {
        evidence.requests++;
        page = await Promise.race([
          Promise.resolve().then(() => adapter.readPage({ source, from: windowFrom, until, cursor, limit, signal: controller.signal })),
          new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Object.assign(new Error('budget'), { budget: true })); }, remaining); }),
        ]);
      } catch (error) {
        status = error.budget ? 'budget-exhausted' : [401, 403].includes(error.status) ? 'read-scope-revoked' : 'read-failed';
        break;
      } finally { clearTimeout(timer); }
      let events, nextCursor, gap;
      try {
        if (!Array.isArray(page.events) || page.events.length > limit) throw new Error('page size');
        nextCursor = page.nextCursor;
        if (nextCursor !== null && (!Number.isSafeInteger(nextCursor) || nextCursor < 0 || (cursor !== null && nextCursor <= cursor))) throw new Error('cursor');
        const availableFrom = page.availableFrom === undefined ? null : instant(page.availableFrom);
        gap = availableFrom && availableFrom > windowFrom ? { from: windowFrom, until: availableFrom < until ? availableFrom : until } : null;
        events = page.events.map((event) => {
          const occurredAt = instant(event.occurredAt);
          if (occurredAt < windowFrom || occurredAt > until) throw new Error('event outside window');
          return { id: safeRef(event.id), occurredAt };
        });
      } catch { status = 'invalid-page'; break; }
      await authorize(client, options, 'collect');
      if (Date.now() - started >= maxDurationMs) break;
      let insertedEvents = 0, storedBytes = 0;
      const previous = { observedEvents: evidence.observedEvents, insertedEvents: evidence.insertedEvents,
        storedBytes: evidence.storedBytes, retentionGap: evidence.retentionGap };
      await client.query('BEGIN');
      try {
        // Event persistence and checkpoint advancement are one transaction, in this order.
        for (const event of events) {
          const result = await client.query(`INSERT INTO audit_ingest_event(tenant_ref,source,source_event_id,occurred_at)
            VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [tenantRef, source, event.id, event.occurredAt]);
          insertedEvents += result.rowCount;
          storedBytes += result.rowCount * Buffer.byteLength(JSON.stringify(event));
        }
        await client.query(`UPDATE audit_ingest_state SET cursor=$3, window_from=$4, window_until=$5, complete=$6,
          retention_gap=COALESCE($7::jsonb,retention_gap)
          WHERE tenant_ref=$1 AND source=$2`, [tenantRef, source, nextCursor, windowFrom, until, nextCursor === null, gap]);
        await client.query(`DELETE FROM audit_ingest_event WHERE tenant_ref=$1 AND source=$2 AND occurred_at < $3::timestamptz - $4 * interval '1 day'`, [tenantRef, source, until, retentionDays]);
        evidence.observedEvents += events.length;
        evidence.insertedEvents += insertedEvents;
        evidence.storedBytes += storedBytes;
        if (gap) evidence.retentionGap = gap;
        await save('running');
        await client.query('COMMIT');
      } catch {
        await client.query('ROLLBACK');
        Object.assign(evidence, previous);
        throw new Error('audit page persistence failed');
      }
      cursor = nextCursor;
      if (nextCursor === null) { status = evidence.observedEvents ? 'complete' : 'complete-empty'; break; }
    }
    return await save(status);
  } catch (error) {
    if (runCreated) await save('failed');
    // Never echo an adapter/database error payload into worker logs.
    if (/^(not authorized|unfinished time window|time window cannot|audit page persistence)/.test(error.message)) throw error;
    throw new Error('audit ingestion persistence failed');
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockKey]);
  }
}

// Local executable fixture adapter: no network, token acquisition, or permissions.
export function createFixtureAuditAdapter({ tenantRef, pages }) {
  return { tenantRef, credentialMode: 'collector-read-only', synthetic: true,
    async readPage({ cursor }) {
      const page = pages[cursor ?? 0];
      if (!page) throw new Error('fixture page unavailable');
      return page;
    } };
}
