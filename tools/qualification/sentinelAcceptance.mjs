/**
 * Roadmap task-117: the Sentinel workspace ingestion live-acceptance gate.
 *
 * This is the evidence contract and its gate validator. It is registered in
 * tools/release/qualification.mjs (GATE_VALIDATORS) and checks the `subject` of a
 * record captured by tools/qualification/sentinelLive.mjs against the production
 * declarations it qualifies:
 *  - the task-80 Azure Monitor Logs Ingestion adapter (stream, table, column
 *    schema and API version declared in engine/telemetry/adapters/sentinel.mjs);
 *  - the task-79 receiver dedup contract (at-least-once delivery; the receiver
 *    deduplicates on TenantRef, DestinationId, KeelEventId) and the task-80 KQL
 *    logical dedup view (ops/sentinel-dedup.kql).
 *
 * What a passing subject proves, beyond the generic verifier (signature, capture
 * log digest, gate, tenant, freshness, --require-live):
 *  - identity: operation, build, credential mode, two distinct credential
 *    references (the sender ingests, the reader queries), and the destination and
 *    every probe event and every received row belong to the record's tenant;
 *  - prerequisites: tasks 79 and 80 are named; the workspace, DCR, endpoint and
 *    sender reference leave no task-80 setup prerequisite pending; the stream,
 *    table, schema and API version are the ones this build declares; the sender
 *    holds the publishing role on the DCR and the reader a workspace read role;
 *  - delivery and restart/replay: every probe event was accepted at least once
 *    by the production adapter, and after a restart (a fresh adapter instance)
 *    at least one event was redelivered and accepted under the SAME event id;
 *  - logical dedup, never physical uniqueness: the logical rows are exactly the
 *    task-80 dedup view recomputed over the raw rows, one per dedup key; the
 *    record never claims unique physical rows or exactly-once ingestion, and the
 *    physical duplicate count is recorded as observed;
 *  - no missing events: every probe event id appears in the logical view, and no
 *    row outside the probe set does;
 *  - actual delay and errors: the declared results (errors by outcome, throttled
 *    responses, per-event ingestion delay) are recomputed from the delivery log
 *    and the received rows, so a summary that hides an error or invents a delay
 *    fails;
 *  - documentation retrieval is recorded, and no credential material is anywhere
 *    in the record.
 *
 * It never sends a request and never enables anything.
 */
import { readFileSync } from 'node:fs';

import {
  LOGS_INGESTION_API_VERSION, LOGS_INGESTION_DOC_SOURCE, SENTINEL_COLUMNS, SENTINEL_DESTINATION_KIND,
  SENTINEL_STREAM_NAME, SENTINEL_TABLE_NAME, sentinelSetupPrerequisites,
} from '../../engine/telemetry/adapters/sentinel.mjs';
import { RECEIVER_DEDUP_CONTRACT } from '../../engine/telemetry/outbox.mjs';
import { secretProblems } from './sharepointAcceptance.mjs';

export const SENTINEL_LIVE_GATE = 'sentinel-live-acceptance';
export const SENTINEL_LIVE_OPERATION = 'sentinel.workspace-ingestion-qualification';
export const SENTINEL_LIVE_CREDENTIAL_MODE = 'sender-ingest+reader-query';
export const SENTINEL_LIVE_PREREQUISITES = Object.freeze(['task-79', 'task-80']);
export const SENTINEL_PROBE_EVENT_TYPE = 'keel.qualification.sentinel-probe';
export const SENTINEL_MIN_PROBES = 3;
export const SENTINEL_DEDUP_KEY = Object.freeze(['TenantRef', 'DestinationId', 'KeelEventId']);
// Roles that grant the needed actions. The sender needs the DCR data-publish action;
// the reader needs workspace query access.
export const SENTINEL_SENDER_ROLES = Object.freeze(['Monitoring Metrics Publisher']);
export const SENTINEL_READER_ROLES = Object.freeze(['Log Analytics Reader', 'Microsoft Sentinel Reader', 'Reader']);
export const LOG_ANALYTICS_QUERY_DOC_URL = 'https://learn.microsoft.com/en-us/azure/azure-monitor/logs/api/overview';
// Claims a record may never make: delivery is at-least-once and rows are not unique.
export const SENTINEL_FORBIDDEN_CLAIMS = Object.freeze(['exactly-once', 'unique-physical-rows']);
const DELIVERY_OUTCOMES = Object.freeze(['accepted', 'retry', 'uncertain', 'poison', 'threw']);
// A capture belongs to the record it is in: no older than this before observedAt.
export const SENTINEL_CAPTURE_WINDOW_MS = 24 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;

/** The documentation the qualified behaviour was declared from. */
export function sentinelRequiredDocumentation() {
  return [LOGS_INGESTION_DOC_SOURCE.url, LOGS_INGESTION_DOC_SOURCE.limits, LOG_ANALYTICS_QUERY_DOC_URL];
}

/** The summarize line of the task-80 dedup view, read from the checked-in KQL. */
export function sentinelDedupViewLine() {
  try {
    const kql = readFileSync(new URL('../../ops/sentinel-dedup.kql', import.meta.url), 'utf8');
    const line = kql.split('\n').map((text) => text.trim()).find((text) => text.startsWith('| summarize arg_max('));
    return line ? line.replace(/;\s*$/, '') : null;
  } catch {
    return null;
  }
}

/** The task-80 dedup view over raw rows: one row per dedup key, the latest TimeGenerated kept. */
export function sentinelLogicalView(rows) {
  const byKey = new Map();
  for (const row of rows) {
    const key = JSON.stringify(SENTINEL_DEDUP_KEY.map((field) => row?.[field] ?? null));
    const kept = byKey.get(key);
    if (!kept || Date.parse(row.TimeGenerated) > Date.parse(kept.TimeGenerated)) byKey.set(key, row);
  }
  return [...byKey.values()];
}

const dedupKeyOf = (row) => JSON.stringify(SENTINEL_DEDUP_KEY.map((field) => row?.[field] ?? null));

/**
 * The results a capture reports, derived from its own delivery log and received
 * rows. The validator recomputes these and requires the declared ones to match.
 */
export function sentinelResults({ probes, deliveries, rawRows, logicalRows }) {
  const errors = Object.fromEntries(DELIVERY_OUTCOMES.filter((outcome) => outcome !== 'accepted').map((outcome) => [outcome, 0]));
  let retryAfterResponses = 0;
  for (const delivery of deliveries) {
    if (delivery.outcome !== 'accepted' && Object.hasOwn(errors, delivery.outcome)) errors[delivery.outcome] += 1;
    if (/HTTP 429/.test(delivery.error ?? '')) retryAfterResponses += 1;
  }
  const logicalIds = new Set(logicalRows.map((row) => row.KeelEventId));
  const delayMs = {};
  for (const probe of probes) {
    const firstAccepted = deliveries
      .filter((item) => item.eventId === probe.eventId && item.outcome === 'accepted')
      .map((item) => Date.parse(item.sentAt))
      .sort((a, b) => a - b)[0];
    const firstIngested = rawRows
      .filter((row) => row.KeelEventId === probe.eventId)
      .map((row) => Date.parse(row.IngestedAt))
      .sort((a, b) => a - b)[0];
    delayMs[probe.eventId] = Number.isFinite(firstAccepted) && Number.isFinite(firstIngested) ? firstIngested - firstAccepted : null;
  }
  const delays = Object.values(delayMs).filter((value) => value !== null);
  return {
    probes: probes.length,
    physicalRows: rawRows.length,
    logicalEvents: logicalRows.length,
    physicalDuplicates: rawRows.length - logicalRows.length,
    missingEventIds: probes.map((probe) => probe.eventId).filter((id) => !logicalIds.has(id)),
    errors,
    retryAfterResponses,
    delayMs: { perEvent: delayMs, min: delays.length ? Math.min(...delays) : null, max: delays.length ? Math.max(...delays) : null },
  };
}

function captureTimeProblems(label, capturedAt, observedAt) {
  const at = Date.parse(capturedAt ?? '');
  if (Number.isNaN(at)) return [`${label}: no valid capture time`];
  if (Number.isNaN(observedAt)) return [];
  if (at > observedAt + CLOCK_SKEW_MS) return [`${label}: captured after the record was observed`];
  if (observedAt - at > SENTINEL_CAPTURE_WINDOW_MS) return [`${label}: captured more than 24h before the record (stale capture)`];
  return [];
}

function canonicalOf(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalOf).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalOf(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function prerequisiteProblems(evidence, subject) {
  const failures = [];
  const named = new Set(Array.isArray(subject.prerequisites) ? subject.prerequisites : []);
  for (const task of SENTINEL_LIVE_PREREQUISITES) if (!named.has(task)) failures.push(`missing prerequisite: ${task}`);

  // The task-79 contract this build publishes is the one the capture ran against.
  if (RECEIVER_DEDUP_CONTRACT.deliverySemantics !== 'at-least-once') failures.push('prerequisite missing in this build: task-79 at-least-once contract');
  if (subject.deliverySemantics !== 'at-least-once') failures.push(`delivery semantics must be at-least-once, got '${subject.deliverySemantics ?? 'missing'}'`);
  if (canonicalOf(subject.dedupKey) !== canonicalOf(SENTINEL_DEDUP_KEY)) failures.push(`the dedup key must be ${SENTINEL_DEDUP_KEY.join(', ')}`);
  for (const claim of Array.isArray(subject.claims) ? subject.claims : []) {
    if (SENTINEL_FORBIDDEN_CLAIMS.includes(claim)) failures.push(`unproven claim refused: ${claim} (delivery is at-least-once; dedup is logical)`);
  }

  // The configured workspace: nothing pending, the declared stream, table, schema and version.
  const workspace = subject.workspace ?? {};
  if (typeof workspace.workspaceId !== 'string' || !GUID_RE.test(workspace.workspaceId)) failures.push('missing prerequisite: no Log Analytics workspace id');
  const pending = sentinelSetupPrerequisites({
    endpoint: workspace.endpoint, dcrImmutableId: workspace.dcrImmutableId, credentialRef: subject.credentials?.sender,
    cloud: workspace.cloud, streamName: workspace.streamName,
  });
  for (const item of pending) failures.push(`missing prerequisite: ${item.name}`);
  if (workspace.streamName !== SENTINEL_STREAM_NAME) failures.push(`missing prerequisite: stream is '${workspace.streamName ?? 'missing'}', not ${SENTINEL_STREAM_NAME}`);
  if (workspace.table !== SENTINEL_TABLE_NAME) failures.push(`missing prerequisite: table is '${workspace.table ?? 'missing'}', not ${SENTINEL_TABLE_NAME}`);
  if (workspace.apiVersion !== LOGS_INGESTION_API_VERSION) failures.push(`ingestion captured at API version ${workspace.apiVersion ?? 'unknown'}, not ${LOGS_INGESTION_API_VERSION}`);
  if (canonicalOf(workspace.schemaColumns) !== canonicalOf(SENTINEL_COLUMNS.map((column) => column.name))) {
    failures.push('missing prerequisite: the workspace stream schema is not the one this build declares');
  }

  // Credentials: references only, two distinct identities, each with its role.
  const credentials = subject.credentials ?? {};
  for (const role of ['sender', 'reader']) {
    if (typeof credentials[role] !== 'string' || !credentials[role].trim()) failures.push(`no ${role} credential reference`);
  }
  if (credentials.sender && credentials.sender === credentials.reader) failures.push('sender and reader must be separate credentials');
  const roles = subject.roles ?? {};
  const held = (who) => new Set(Array.isArray(roles[who]) ? roles[who] : []);
  if (!SENTINEL_SENDER_ROLES.some((role) => held('sender').has(role))) failures.push(`missing prerequisite: sender lacks role ${SENTINEL_SENDER_ROLES[0]} on the DCR`);
  if (!SENTINEL_READER_ROLES.some((role) => held('reader').has(role))) failures.push(`missing prerequisite: reader lacks a workspace read role (${SENTINEL_READER_ROLES.join(' or ')})`);

  // The destination the events were delivered for is the record's tenant's.
  const destination = subject.destination ?? {};
  if (destination.kind !== SENTINEL_DESTINATION_KIND) failures.push(`missing prerequisite: destination kind is not ${SENTINEL_DESTINATION_KIND}`);
  if (typeof destination.id !== 'string' || !destination.id) failures.push('missing prerequisite: no destination id');
  if (destination.tenantRef !== evidence.tenantRef) failures.push('the destination belongs to another tenant');
  return failures;
}

function deliveryProblems(evidence, subject, observedAt) {
  const failures = [];
  const probes = Array.isArray(subject.probes) ? subject.probes : [];
  const deliveries = Array.isArray(subject.deliveries) ? subject.deliveries : [];
  if (probes.length < SENTINEL_MIN_PROBES) failures.push(`at least ${SENTINEL_MIN_PROBES} probe events are needed, found ${probes.length}`);
  const ids = new Set();
  for (const [index, probe] of probes.entries()) {
    if (typeof probe?.eventId !== 'string' || !/^evt_[0-9a-f]{64}$/.test(probe.eventId)) failures.push(`probe ${index}: no stable event id`);
    else if (ids.has(probe.eventId)) failures.push(`probe ${index}: duplicate event id ${probe.eventId}`);
    ids.add(probe?.eventId);
    if (probe?.tenantRef !== evidence.tenantRef) failures.push(`probe ${index}: belongs to another tenant`);
    if (probe?.eventType !== SENTINEL_PROBE_EVENT_TYPE) failures.push(`probe ${index}: not a ${SENTINEL_PROBE_EVENT_TYPE} event`);
  }
  const sequences = probes.map((probe) => probe?.sourceSequence).filter(Number.isSafeInteger).sort((a, b) => a - b);
  if (sequences.length !== probes.length || sequences.some((value, index) => index > 0 && value !== sequences[index - 1] + 1)) {
    failures.push('probe source sequences are not one contiguous run');
  }

  if (deliveries.length === 0) return [...failures, 'no delivery log recorded'];
  let replayedAccepted = 0;
  for (const [index, delivery] of deliveries.entries()) {
    const label = `delivery ${index} (${delivery?.phase ?? '?'} ${delivery?.eventId ?? '?'})`;
    if (!ids.has(delivery?.eventId)) failures.push(`${label}: not a probe event`);
    if (!['initial', 'replay'].includes(delivery?.phase)) failures.push(`${label}: unknown phase`);
    if (!DELIVERY_OUTCOMES.includes(delivery?.outcome)) failures.push(`${label}: unknown outcome`);
    if (delivery?.outcome !== 'accepted' && (typeof delivery?.error !== 'string' || !delivery.error)) {
      failures.push(`${label}: a failed delivery must keep its error`);
    }
    failures.push(...captureTimeProblems(label, delivery?.sentAt, observedAt));
    if (delivery?.phase === 'replay' && delivery?.outcome === 'accepted') replayedAccepted += 1;
  }
  for (const id of ids) {
    if (!deliveries.some((item) => item?.eventId === id && item?.phase === 'initial' && item?.outcome === 'accepted')) {
      failures.push(`event ${id} was never accepted on initial delivery`);
    }
  }
  const replay = subject.replay ?? {};
  if (replay.restartedAdapter !== true) failures.push('restart/replay not exercised: no fresh adapter instance after the first delivery');
  if (replayedAccepted === 0) failures.push('restart/replay not exercised: no event was redelivered and accepted under its event id');
  return failures;
}

function receiverProblems(evidence, subject, observedAt) {
  const failures = [];
  const receiver = subject.receiver ?? {};
  const rawRows = Array.isArray(receiver.rawRows) ? receiver.rawRows : null;
  const logicalRows = Array.isArray(receiver.logicalRows) ? receiver.logicalRows : null;
  if (!rawRows || !logicalRows) return ['missing prerequisite: no receiver query evidence'];
  failures.push(...captureTimeProblems('receiver query', receiver.queriedAt, observedAt));

  const runId = subject.runId;
  const destinationId = subject.destination?.id;
  if (typeof receiver.logicalQuery !== 'string' || !receiver.logicalQuery.includes(sentinelDedupViewLine() ?? '\u0000')) {
    failures.push('the logical query is not the task-80 dedup view');
  }
  for (const [label, query] of [['raw', receiver.rawQuery], ['logical', receiver.logicalQuery]]) {
    if (typeof query !== 'string' || !query.includes(SENTINEL_TABLE_NAME) || !query.includes(`'${runId}'`)
        || !query.includes(`'${evidence.tenantRef}'`) || !query.includes(`'${destinationId}'`)) {
      failures.push(`the ${label} query is not scoped to this run, tenant and destination`);
    }
  }
  for (const [label, rows] of [['raw', rawRows], ['logical', logicalRows]]) {
    for (const [index, row] of rows.entries()) {
      if (row?.TenantRef !== evidence.tenantRef) failures.push(`${label} row ${index}: belongs to another tenant`);
      if (row?.DestinationId !== destinationId) failures.push(`${label} row ${index}: belongs to another destination`);
      if (row?.CorrelationId !== runId) failures.push(`${label} row ${index}: belongs to another run`);
      if (Number.isNaN(Date.parse(row?.IngestedAt ?? ''))) failures.push(`${label} row ${index}: no ingestion time`);
    }
  }

  // Logical dedup by event id: the logical rows are the view over the raw rows, one per key.
  const logicalKeys = logicalRows.map(dedupKeyOf);
  if (new Set(logicalKeys).size !== logicalKeys.length) failures.push('the logical view holds more than one row for a dedup key');
  const expectedKeys = sentinelLogicalView(rawRows).map(dedupKeyOf).sort();
  if (canonicalOf([...logicalKeys].sort()) !== canonicalOf(expectedKeys)) {
    failures.push('the logical rows are not the dedup view of the raw rows');
  }

  // No missing events, and no row outside the probe set.
  const probeIds = new Set((subject.probes ?? []).map((probe) => probe?.eventId));
  const logicalIds = new Set(logicalRows.map((row) => row?.KeelEventId));
  for (const id of probeIds) if (!logicalIds.has(id)) failures.push(`missing event: ${id} was delivered but never observed in the workspace`);
  for (const id of new Set(rawRows.map((row) => row?.KeelEventId))) {
    if (!probeIds.has(id)) failures.push(`unexpected event ${id} in the workspace for this run`);
  }
  return failures;
}

/**
 * Gate validator for the task-117 record. Returns failure reasons; empty means the
 * subject holds. `runner` is the release verifier's runner-proof result.
 */
export function validateSentinelLiveSubject(evidence, context = {}) {
  const { tenantRef, build, artifact, runner } = context;
  const failures = [];
  if (evidence.status === 'pending') return ['Sentinel live evidence pending: no record has been captured'];
  // Both proofs: the runner signature over the record and the digest of its raw log.
  if (!runner?.ok) failures.push(`Sentinel runner proof required (${runner?.reason ?? 'not checked'})`);
  if (!artifact?.ok) failures.push(`Sentinel capture artifact required (${artifact?.reason ?? 'not checked'})`);
  if (evidence.evidenceLevel === 'live-qualified' && (evidence.synthetic !== false || runner?.synthetic)) {
    failures.push('Sentinel fixture evidence cannot claim live qualification');
  }
  if (!tenantRef || !build) failures.push('Sentinel expected tenant/build identity required');
  if (build && evidence.build !== build) failures.push(`Sentinel build mismatch: evidence is '${evidence.build}', required '${build}'`);
  if (evidence.operation !== SENTINEL_LIVE_OPERATION) {
    failures.push(`Sentinel operation mismatch: expected '${SENTINEL_LIVE_OPERATION}', got '${evidence.operation ?? 'missing'}'`);
  }
  if (evidence.credentialMode !== SENTINEL_LIVE_CREDENTIAL_MODE) failures.push(`Sentinel requires credential mode '${SENTINEL_LIVE_CREDENTIAL_MODE}'`);
  failures.push(...secretProblems(evidence));

  const subject = evidence.subject;
  if (!subject || typeof subject !== 'object') return [...failures, 'subject is missing'];
  const observedAt = Date.parse(evidence.observedAt ?? '');
  if (typeof subject.runId !== 'string' || !/^[\w.:-]+$/.test(subject.runId)) failures.push('no run id scoping the probe events');

  failures.push(...prerequisiteProblems(evidence, subject));
  failures.push(...deliveryProblems(evidence, subject, observedAt));
  failures.push(...receiverProblems(evidence, subject, observedAt));

  // Actual delay and errors: the declared results are recomputed, never trusted.
  const receiver = subject.receiver ?? {};
  if (Array.isArray(subject.probes) && Array.isArray(subject.deliveries) && Array.isArray(receiver.rawRows) && Array.isArray(receiver.logicalRows)) {
    const expected = sentinelResults({
      probes: subject.probes, deliveries: subject.deliveries, rawRows: receiver.rawRows, logicalRows: receiver.logicalRows,
    });
    for (const field of Object.keys(expected)) {
      if (canonicalOf(subject.results?.[field]) !== canonicalOf(expected[field])) {
        failures.push(`results.${field} does not match the delivery log and received rows`);
      }
    }
    for (const [id, delay] of Object.entries(expected.delayMs.perEvent)) {
      if (delay !== null && delay < -CLOCK_SKEW_MS) failures.push(`event ${id} was ingested before it was sent`);
    }
  }

  // The raw capture log is bound into the signed subject.
  if (typeof subject.captureLogSha256 !== 'string' || !SHA256_RE.test(subject.captureLogSha256)
      || subject.captureLogSha256 !== evidence.proof?.artifact?.sha256) {
    failures.push('the capture log digest is not bound to the signed subject');
  }

  const docs = Array.isArray(subject.documentation) ? subject.documentation : [];
  for (const url of sentinelRequiredDocumentation()) {
    const entry = docs.find((item) => item?.url === url);
    if (!entry || Number.isNaN(Date.parse(entry.retrievedAt ?? ''))) failures.push(`documentation not retrieved: ${url}`);
  }
  return failures;
}
