/**
 * Canonical correlated operational/evidence event envelope (roadmap task-77).
 *
 * Every existing evidence record, job lifecycle event and drift record can be
 * projected into one envelope shape carrying tenant, deterministic event ID,
 * source, source/event timestamps, schema version and correlation:
 *
 *   { envelopeVersion, eventId, tenantRef, eventType,
 *     source: { component, instanceId }, correlationId, causationId,
 *     sourceSequence, observedAt, emittedAt, payload, capture }
 *
 * Non-negotiable rules enforced here:
 *
 * 1. tenantRef, eventType, source.component and correlationId are mandatory.
 * 2. Event identity is DETERMINISTIC: eventId is a hash of the envelope's
 *    identifying content (never a random value, never the emission clock), so
 *    replaying the same event — a retried emission of the same job attempt —
 *    yields the same eventId. Source record IDs and sequences distinguish events.
 * 3. observedAt is the source event time and sourceSequence is the
 *    source-provided ordering; both are preserved verbatim, never renumbered.
 *    Gaps in a source sequence stay visible via sourceSequenceGaps().
 * 4. Payloads are redacted before anything else happens to them: sensitive
 *    keys (authorization headers, tokens, secrets, connection strings) and
 *    token-shaped values are replaced at ANY nesting depth, and the payload is
 *    capped at a configurable byte budget (minimum 128 bytes). The capture block records what the
 *    capture cost (bytes, redactions, truncation) — secrets never enter logs,
 *    exports or evidence.
 * 5. This module is NOT an audit authority. The append-only hash-chained
 *    evidence table (engine/govern/evidence.mjs) remains the single audit
 *    authority; envelopes are an operational projection/log record that
 *    references evidence rows (seq, record_hash) instead of duplicating them.
 */
import { createHash } from 'node:crypto';

export const EVENT_ENVELOPE_VERSION = 1;
export const DEFAULT_MAX_PAYLOAD_BYTES = 16 * 1024;
export const REDACTED = '[redacted]';

// Keys whose values are credentials at any nesting depth. The match is on the
// final path segment, case-insensitive, so `request.headers.authorization` and
// a bare `Authorization` are treated identically.
const SENSITIVE_KEY_PATTERN = /^(authorization|proxy-authorization|x-api-key|api[-_]?key|token|access[-_]?token|refresh[-_]?token|id[-_]?token|client[-_]?secret|password|passwd|secret|credentials?|private[-_]?key|session[-_]?key|connection[-_]?string|set-cookie|cookie)$/i;

// Values that are credential-shaped regardless of the key they sit under.
const SENSITIVE_VALUE_PATTERNS = [
  /Bearer\s+\S{8,}/i,
  /postgres(?:ql)?:\/\/[^\s/]*:[^\s/]*@/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

function asIsoInstant(value, label) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  throw new TypeError(`event requires a valid ${label} instant`);
}

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`event requires a non-empty ${label}`);
  }
  return value;
}

function isSensitiveKey(key) {
  const segment = String(key).split('.').at(-1);
  return SENSITIVE_KEY_PATTERN.test(segment);
}

function isSensitiveValue(value) {
  return SENSITIVE_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * Deep-redact a payload. Sensitive keys and token-shaped values are replaced
 * with REDACTED at any depth; the walk also normalizes non-JSON values
 * (Date -> ISO string, bigint -> string) and breaks cycles. Returns the
 * redacted value and the number of redacted fields for the capture metrics.
 */
export function redactPayload(value, state = { redactedFields: 0, seen: new WeakSet() }) {
  if (typeof value === 'string') {
    if (isSensitiveValue(value)) {
      state.redactedFields += 1;
      return REDACTED;
    }
    return value;
  }
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (Array.isArray(value)) {
    if (state.seen.has(value)) return '[circular]';
    state.seen.add(value);
    const out = value.map((item) => redactPayload(item, state));
    state.seen.delete(value);
    return out;
  }
  if (value && typeof value === 'object') {
    if (state.seen.has(value)) return '[circular]';
    state.seen.add(value);
    const out = Object.create(null);
    for (const key of Object.keys(value)) {
      if (value[key] === undefined || typeof value[key] === 'function') continue;
      if (isSensitiveKey(key)) {
        state.redactedFields += 1;
        out[key] = REDACTED;
      } else {
        out[key] = redactPayload(value[key], state);
      }
    }
    state.seen.delete(value);
    return out;
  }
  if (value === undefined || typeof value === 'function') return null;
  return value;
}

/** Deterministic JSON: object keys sorted recursively. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * The deterministic event identity. Hashes the identifying content only —
 * never emittedAt and never the source instance — so a retry of the SAME
 * event (same type, correlation, source sequence, observed instant, payload)
 * reproduces the same eventId. Redacted credentials are not event identity.
 */
export function eventIdFor({
  tenantRef, eventType, correlationId, causationId, sourceSequence, observedAt,
  sourceComponent, sourceEventId, payload,
}) {
  const digest = createHash('sha256')
    .update(canonicalJson({
      envelopeVersion: EVENT_ENVELOPE_VERSION,
      tenantRef,
      eventType,
      correlationId,
      causationId: causationId ?? null,
      sourceSequence: sourceSequence ?? null,
      observedAt,
      sourceComponent,
      sourceEventId: sourceEventId ?? null,
      payload,
    }))
    .digest('hex');
  return `evt_${digest}`;
}

/**
 * Build a frozen envelope. The payload is redacted first, then capped at
 * maxPayloadBytes: an oversized payload is replaced by a deterministic stub
 * carrying the redacted payload's digest, so even a capped event keeps a
 * stable replay identity.
 */
export function defineEvent({
  tenantRef, eventType, source, correlationId, causationId = null,
  sourceSequence = null, sourceEventId = null, observedAt, emittedAt, payload = {},
  costMetrics = null, maxPayloadBytes = DEFAULT_MAX_PAYLOAD_BYTES,
}) {
  requireNonEmptyString(tenantRef, 'tenantRef');
  requireNonEmptyString(eventType, 'eventType');
  requireNonEmptyString(correlationId, 'correlationId');
  requireNonEmptyString(source?.component, 'source.component');
  if (causationId !== null && causationId !== undefined) {
    requireNonEmptyString(causationId, 'causationId');
  }
  if (sourceSequence !== null && sourceSequence !== undefined
      && (!Number.isSafeInteger(sourceSequence) || sourceSequence < 0)) {
    throw new TypeError('event sourceSequence must be a non-negative integer or null');
  }
  if (!Number.isSafeInteger(maxPayloadBytes) || maxPayloadBytes < 128) {
    throw new TypeError('maxPayloadBytes must be an integer of at least 128');
  }
  const observed = asIsoInstant(observedAt, 'observedAt');
  const emitted = emittedAt === undefined || emittedAt === null
    ? new Date().toISOString()
    : asIsoInstant(emittedAt, 'emittedAt');

  const redaction = { redactedFields: 0, seen: new WeakSet() };
  let finalPayload = redactPayload(payload ?? {}, redaction);
  let payloadBytes = Buffer.byteLength(canonicalJson(finalPayload), 'utf8');
  const identityPayload = finalPayload;
  let truncated = false;
  if (payloadBytes > maxPayloadBytes) {
    truncated = true;
    finalPayload = {
      truncated: true,
      originalBytes: payloadBytes,
      digest: createHash('sha256').update(canonicalJson(finalPayload)).digest('hex'),
    };
    payloadBytes = Buffer.byteLength(canonicalJson(finalPayload), 'utf8');
  }

  const envelope = {
    envelopeVersion: EVENT_ENVELOPE_VERSION,
    eventId: eventIdFor({
      tenantRef, eventType, correlationId, causationId: causationId ?? null,
      sourceSequence: sourceSequence ?? null, observedAt: observed,
      sourceComponent: source.component, sourceEventId, payload: identityPayload,
    }),
    tenantRef,
    eventType,
    sourceEventId,
    source: Object.freeze({
      component: source.component,
      instanceId: typeof source.instanceId === 'string' ? source.instanceId : null,
    }),
    correlationId,
    causationId: causationId ?? null,
    sourceSequence: sourceSequence ?? null,
    observedAt: observed,
    emittedAt: emitted,
    payload: finalPayload,
    capture: Object.freeze({
      payloadBytes,
      truncated,
      redactedFields: redaction.redactedFields,
      ...captureCosts(costMetrics),
    }),
  };
  return Object.freeze(envelope);
}

/**
 * The job correlation identity. The job row id survives orphan-reset retries
 * (the row is re-queued, never recreated), so every attempt and every evidence
 * envelope the job produces shares this one correlation id.
 */
export function jobCorrelationId(job) {
  const id = typeof job === 'string' ? job : job?.id;
  return `job:${requireNonEmptyString(id, 'job id')}`;
}

/** The tenant scope a job row carries, or the explicit unscoped sentinel. */
export const UNSCOPED_TENANT_REF = 'tenant:unscoped';

function jobTenantRef(job, tenantRef) {
  if (typeof tenantRef === 'string' && tenantRef.length > 0) return tenantRef;
  if (typeof job?.tenant_ref === 'string' && job.tenant_ref.length > 0) return job.tenant_ref;
  if (typeof job?.params?.tenantRef === 'string' && job.params.tenantRef.length > 0) {
    return job.params.tenantRef;
  }
  return UNSCOPED_TENANT_REF;
}

/**
 * Project a job row (plus a lifecycle phase) into an envelope. The source
 * sequence is an optional source-provided claim attempt, so each
 * attempt is a distinct event under the same correlation id; existing queue
 * rows use their persisted started_at timestamp for identity. Rows written
 * before the attempt counter existed read as attempt 0 — legacy — and carry
 * no source sequence rather than a fabricated one.
 */
export function envelopeForJob(job, {
  eventType, tenantRef, instanceId, causationId, observedAt, emittedAt,
  payload, costMetrics, maxPayloadBytes,
} = {}) {
  requireNonEmptyString(eventType, 'eventType');
  const attempt = Number.isSafeInteger(job?.attempt_count) && job.attempt_count > 0
    ? job.attempt_count
    : null;
  const startedAt = job?.started_at ? new Date(job.started_at) : null;
  const finishedAt = job?.finished_at ? new Date(job.finished_at) : null;
  return defineEvent({
    tenantRef: jobTenantRef(job, tenantRef),
    eventType,
    source: { component: 'keel-worker', instanceId: instanceId ?? job?.worker_id ?? null },
    correlationId: jobCorrelationId(job),
    causationId,
    sourceSequence: attempt,
    sourceEventId: `${job.id}:${job.event_started_at ?? job.started_at ?? job.created_at}`,
    observedAt: observedAt ?? finishedAt ?? startedAt ?? job?.created_at,
    emittedAt,
    payload: payload ?? {
      jobId: job?.id,
      kind: job?.kind,
      status: job?.status,
      requestedBy: job?.requested_by,
      idempotencyKey: job?.idempotency_key ?? null,
      params: job?.params ?? {},
    },
    costMetrics: costMetrics ?? {
      attempt,
      durationMs: startedAt && finishedAt ? finishedAt - startedAt : null,
    },
    maxPayloadBytes,
  });
}

/**
 * Project an evidence record into an envelope. The evidence table stays the
 * audit authority — this payload carries seq and record_hash by REFERENCE so
 * the operational log correlates to the chain without duplicating it. The
 * source sequence is the chain seq itself; observedAt is the record's
 * occurred_at. correlationId is supplied by the caller (e.g. the producing
 * job's correlation id); outside a job the tenant's evidence stream is the
 * correlation.
 */
export function envelopeForEvidence(record, {
  correlationId, causationId, component = 'govern/evidence', instanceId,
  emittedAt, payload, costMetrics, maxPayloadBytes,
} = {}) {
  if (!record || typeof record !== 'object') {
    throw new TypeError('evidence envelope requires a record');
  }
  requireNonEmptyString(record.tenant_ref ?? record.tenantRef, 'evidence tenant_ref');
  requireNonEmptyString(record.kind, 'evidence kind');
  const seq = Number(record.seq);
  if (!Number.isSafeInteger(seq) || seq < 0) {
    throw new TypeError('evidence envelope requires an integer seq');
  }
  const tenantRef = record.tenant_ref ?? record.tenantRef;
  return defineEvent({
    tenantRef,
    eventType: `evidence.${record.kind}`,
    source: { component, instanceId: instanceId ?? null },
    correlationId: correlationId ?? record.subject?._event?.correlationId ?? `evidence-stream:${tenantRef}`,
    causationId,
    sourceSequence: seq,
    sourceEventId: String(seq),
    observedAt: record.occurred_at ?? record.occurredAt,
    emittedAt,
    payload: payload ?? {
      seq,
      kind: record.kind,
      subject: record.subject,
      actor: record.actor,
      prevHash: record.prev_hash ?? record.prevHash ?? null,
      recordHash: record.record_hash ?? record.recordHash,
    },
    costMetrics,
    maxPayloadBytes,
  });
}

/**
 * Project a drift row into an envelope. Drift rows carry no source sequence;
 * their ordering is observedAt (detected_at) and their identity is the drift
 * id in the payload, so two detections of the same natural key in different
 * snapshots can never collapse into one event.
 */
export function envelopeForDrift(row, {
  correlationId, causationId, component = 'govern/drift', instanceId,
  emittedAt, payload, costMetrics, maxPayloadBytes,
} = {}) {
  if (!row || typeof row !== 'object') {
    throw new TypeError('drift envelope requires a row');
  }
  requireNonEmptyString(row.tenant_ref, 'drift tenant_ref');
  return defineEvent({
    tenantRef: row.tenant_ref,
    eventType: 'drift.detected',
    sourceEventId: requireNonEmptyString(row.id, 'drift id'),
    source: { component, instanceId: instanceId ?? null },
    correlationId: correlationId ?? `drift:${requireNonEmptyString(row.id, 'drift id')}`,
    causationId,
    sourceSequence: null,
    observedAt: row.detected_at,
    emittedAt,
    payload: payload ?? {
      driftId: row.id,
      naturalKey: row.natural_key,
      resourceType: row.resource_type,
      changeType: row.change_type,
      beforeHash: row.before_hash ?? null,
      afterHash: row.after_hash ?? null,
      blastRadius: row.blast_radius,
      baselineId: row.baseline_id,
      observedSnapshot: row.observed_snapshot,
    },
    costMetrics,
    maxPayloadBytes,
  });
}

/**
 * Sequence gaps stay visible: collect the integer source sequences of a
 * stream, and report every missing number between the first and last
 * observed. Sequences are never renumbered by this module, so a gap here is a
 * genuine source-ordering gap (e.g. a crashed attempt), not a collapsed one.
 */
export function sourceSequenceGaps(envelopes) {
  const seen = new Set();
  for (const envelope of envelopes) {
    if (envelope?.tenantRef !== envelopes[0]?.tenantRef
        || envelope?.source?.component !== envelopes[0]?.source?.component) {
      throw new TypeError('sequence gaps require one tenant/source stream');
    }
    if (Number.isSafeInteger(envelope?.sourceSequence)) seen.add(envelope.sourceSequence);
  }
  if (seen.size === 0) return [];
  const sorted = [...seen].sort((a, b) => a - b);
  if (sorted.at(-1) - sorted[0] > 100000) throw new RangeError('sequence gap window too large');
  const gaps = [];
  for (let n = sorted[0]; n <= sorted.at(-1); n += 1) {
    if (!seen.has(n)) gaps.push(n);
  }
  return gaps;
}

/** The structured log line for an envelope: one JSON object, marked for routing. */
export function structuredEventLine(envelope) {
  return JSON.stringify({ stream: 'keel-events', event: envelope });
}

/**
 * A sink that writes one structured JSON line per envelope. The envelope is
 * already redacted and size-capped; the sink adds nothing but framing.
 */
export function createEventSink(write = (line) => process.stdout.write(`${line}\n`)) {
  return (envelope) => write(structuredEventLine(envelope));
}

// Capture only numeric observations already measured by jobs/Graph. No arbitrary
// metadata enters the capture block, and capture settings cannot change identity.
function captureCosts(metrics) {
  if (!metrics || typeof metrics !== 'object') return {};
  return Object.fromEntries(['attempt', 'durationMs', 'graphRequests', 'graphRetries', 'graphThrottles']
    .filter(key => Number.isFinite(metrics[key]) && metrics[key] >= 0)
    .map(key => [key, metrics[key]]));
}

/**
 * Roadmap task-110: the measured Graph cost of one collected type, read from its
 * coverage-digest entry. `requests` and `throttles` are the reader's own counters
 * (engine/collect/entraAdapter.mjs); `itemCount` is a resource count and is never
 * used as a request count. A legacy entry written before the counters existed, or
 * one with malformed counts, returns null: unmeasured, never an invented zero.
 */
export function graphRequestObservation(entry) {
  if (!entry || typeof entry !== 'object' || entry.outcome === 'not-requested') return null;
  const { requests, throttles } = entry;
  if (!Number.isSafeInteger(requests) || requests < 0) return null;
  if (!Number.isSafeInteger(throttles) || throttles < 0 || throttles > requests) return null;
  return { requests, throttles };
}

/**
 * The capture-cost metrics for one collection run, summed over the types it
 * requested. When any requested type is unmeasured the run's totals are null,
 * because a partial sum would understate the run's cost.
 */
export function collectionCostMetrics(coverageDigest) {
  let graphRequests = 0;
  let graphThrottles = 0;
  let measuredTypes = 0;
  let unmeasuredTypes = 0;
  for (const entry of Object.values(coverageDigest && typeof coverageDigest === 'object' ? coverageDigest : {})) {
    if (entry?.outcome === 'not-requested') continue;
    const observed = graphRequestObservation(entry);
    if (!observed) { unmeasuredTypes += 1; continue; }
    measuredTypes += 1;
    graphRequests += observed.requests;
    graphThrottles += observed.throttles;
  }
  const measured = measuredTypes > 0 && unmeasuredTypes === 0;
  return {
    graphRequests: measured ? graphRequests : null,
    graphThrottles: measured ? graphThrottles : null,
    measuredTypes,
    unmeasuredTypes,
  };
}
