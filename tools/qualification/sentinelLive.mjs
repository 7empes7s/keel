#!/usr/bin/env node
/**
 * Roadmap task-117: capture and import Sentinel workspace ingestion live-acceptance
 * evidence. The operator runs this against a TEST Log Analytics workspace; builders
 * and CI never point it at a workspace.
 *
 *   node tools/qualification/sentinelLive.mjs plan --tenant-ref <ref> --destination-id <id> [--probe-count N]
 *     Offline (the default). Prints every delivery and query a capture would send. No network.
 *
 *   KEEL_SENTINEL_SENDER_TOKEN=... KEEL_SENTINEL_READER_TOKEN=... [KEEL_QUALIFICATION_HMAC_KEY=...] \
 *   node tools/qualification/sentinelLive.mjs capture --confirm-live-workspace-ingest \
 *        --tenant-ref sha256:... --destination-id <KEEL siem_destination id> \
 *        --workspace-id <guid> --endpoint https://<dce>.ingest.monitor.azure.com --dcr-immutable-id dcr-... \
 *        --sender-ref env:<VAR> --reader-ref app:<reader app id> \
 *        --roles roles.json --docs docs.json \
 *        --out docs/release/qualifications/sentinel-live-acceptance.json [--build <sha>] [--cloud public]
 *
 * What a capture does, in order (and nothing else):
 *  1. builds N probe events (`keel.qualification.sentinel-probe`, one contiguous
 *     source sequence, one run id as their correlation id) with the task-77
 *     envelope builder, so each has its stable KEEL event id;
 *  2. delivers each one through the PRODUCTION task-80 adapter
 *     (createSentinelAdapter) to the configured DCR stream, retrying a `retry` or
 *     `uncertain` outcome under the SAME event id (honouring Retry-After), and logs
 *     every attempt with its outcome and error;
 *  3. restart/replay: builds a FRESH adapter instance (a restarted worker) and
 *     redelivers every probe event from --replay-from-seq under its same event id,
 *     as the task-79 outbox replay does;
 *  4. with the separate reader credential, polls the Log Analytics query API with
 *     two read-only KQL queries scoped to this run, tenant and destination: the raw
 *     rows (with ingestion_time()) and the task-80 logical dedup view. Polling stops
 *     when every probe event is visible logically, or after the poll budget.
 * Nothing else is written to the workspace; no Azure resource is created or changed.
 *
 * The record keeps the actual outcome of every delivery, the observed physical
 * rows, the logical events, any missing event and the per-event ingestion delay.
 * It never claims unique physical rows or exactly-once ingestion: delivery is
 * at-least-once and deduplication is logical, by stable event id.
 *
 * Tokens come from the environment and are never written. The record carries
 * credential references only. With KEEL_QUALIFICATION_HMAC_KEY set the record is
 * signed as `keel-release-runner`; without it the record cannot verify.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  LOGS_INGESTION_API_VERSION, SENTINEL_COLUMNS, SENTINEL_DESTINATION_KIND, SENTINEL_STREAM_NAME, SENTINEL_TABLE_NAME,
  createSentinelAdapter, sentinelSetupPrerequisites,
} from '../../engine/telemetry/adapters/sentinel.mjs';
import { defineEvent } from '../../engine/telemetry/events.mjs';
import { pseudonymizeCapture } from './pseudonymize.mjs';
import { QUALIFICATION_CONTRACT_VERSION, signEvidence, verifyEvidence } from '../release/qualification.mjs';
import {
  SENTINEL_DEDUP_KEY, SENTINEL_LIVE_CREDENTIAL_MODE, SENTINEL_LIVE_GATE, SENTINEL_LIVE_OPERATION, SENTINEL_LIVE_PREREQUISITES,
  SENTINEL_MIN_PROBES, SENTINEL_PROBE_EVENT_TYPE, sentinelDedupViewLine, sentinelResults,
} from './sentinelAcceptance.mjs';

// Log Analytics query API hosts per cloud. Read-only queries only.
export const LOG_ANALYTICS_QUERY_HOST = Object.freeze({
  public: 'https://api.loganalytics.io',
  china: 'https://api.loganalytics.azure.cn',
  usgov: 'https://api.loganalytics.us',
});
const SAFE_LITERAL = /^[\w.:-]+$/;
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_PROBES = 5;
const MAX_ATTEMPTS = 4;

const sha256Hex = (text) => createHash('sha256').update(text).digest('hex');

/** Refuses identifiers that cannot be put into a KQL string literal verbatim. */
export function sentinelIdentityProblems({ tenantRef, destinationId, runId, probeCount }) {
  const problems = [];
  if (typeof tenantRef !== 'string' || !SAFE_LITERAL.test(tenantRef)) problems.push('--tenant-ref must be a KEEL tenant reference');
  if (typeof destinationId !== 'string' || !SAFE_LITERAL.test(destinationId)) problems.push('--destination-id must be the KEEL destination id');
  if (runId !== undefined && (typeof runId !== 'string' || !SAFE_LITERAL.test(runId))) problems.push('the run id must be a plain identifier');
  if (probeCount !== undefined && (!Number.isSafeInteger(probeCount) || probeCount < SENTINEL_MIN_PROBES || probeCount > 50)) {
    problems.push(`--probe-count must be ${SENTINEL_MIN_PROBES} to 50`);
  }
  return problems;
}

/** The two read-only receiver queries for one run. */
export function sentinelReceiverQueries({ tenantRef, destinationId, runId }) {
  const problems = sentinelIdentityProblems({ tenantRef, destinationId, runId });
  if (problems.length) throw new Error(problems.join('; '));
  const scoped = [
    SENTINEL_TABLE_NAME,
    `| where TenantRef == '${tenantRef}' and DestinationId == '${destinationId}' and CorrelationId == '${runId}'`,
    '| extend IngestedAt = ingestion_time()',
  ];
  const columns = '| project KeelEventId, TenantRef, DestinationId, CorrelationId, SourceSequence, TimeGenerated, IngestedAt';
  return {
    rawQuery: [...scoped, columns].join('\n'),
    logicalQuery: [...scoped, sentinelDedupViewLine(), columns].join('\n'),
  };
}

/** The probe envelopes for one run: one contiguous sequence, stable event ids. */
export function sentinelProbeEnvelopes({ tenantRef, runId, probeCount = DEFAULT_PROBES, observedAt }) {
  return Array.from({ length: probeCount }, (_, index) => defineEvent({
    tenantRef,
    eventType: SENTINEL_PROBE_EVENT_TYPE,
    source: { component: 'sentinel-qualification', instanceId: runId },
    correlationId: runId,
    sourceSequence: index,
    observedAt: new Date(Date.parse(observedAt) + index).toISOString(),
    emittedAt: observedAt,
    payload: { probe: index, runId },
  }));
}

/** Offline: what a capture would send, in order. */
export function sentinelCapturePlan({ tenantRef, destinationId, probeCount = DEFAULT_PROBES, replayFromSeq = 0 }) {
  const problems = sentinelIdentityProblems({ tenantRef, destinationId, probeCount });
  if (problems.length) throw new Error(problems.join('; '));
  // The real run id is generated per capture; the plan shows the query shape with a stand-in.
  const runId = 'keel-rt-sentinel-RUN';
  const queries = sentinelReceiverQueries({ tenantRef, destinationId, runId });
  return [
    { step: 1, credential: 'none', action: `build ${probeCount} ${SENTINEL_PROBE_EVENT_TYPE} events, correlation ${runId}` },
    { step: 2, credential: 'sender', method: 'POST', path: `{endpoint}/dataCollectionRules/{dcr}/streams/${SENTINEL_STREAM_NAME}?api-version=${LOGS_INGESTION_API_VERSION}`, count: probeCount },
    { step: 3, credential: 'sender', method: 'POST', path: '(fresh adapter instance) the same path, the same event ids', count: probeCount - replayFromSeq },
    { step: 4, credential: 'reader', method: 'POST', path: '{query host}/v1/workspaces/{workspace}/query (read-only)', query: queries.rawQuery },
    { step: 4, credential: 'reader', method: 'POST', path: '{query host}/v1/workspaces/{workspace}/query (read-only)', query: queries.logicalQuery },
  ];
}

function tableRows(body) {
  const table = body?.tables?.[0];
  if (!table || !Array.isArray(table.columns) || !Array.isArray(table.rows)) return null;
  const names = table.columns.map((column) => column.name);
  return table.rows.map((row) => Object.fromEntries(names.map((name, index) => {
    const value = row[index];
    return [name, ['TimeGenerated', 'IngestedAt'].includes(name) && typeof value === 'string' ? new Date(value).toISOString() : value];
  })));
}

/**
 * Runs a capture. `ingestFetch` is the fetch the production adapter uses for the
 * ingestion endpoint; `senderToken` returns the sender's token; `query(kql)` sends one
 * read-only query and returns `{ status, body }`. Returns the unsigned record and the
 * capture log, with tenant ids pseudonymized (pseudonymize.mjs); it never signs and never writes files.
 */
export async function captureSentinelAcceptance({
  ingestFetch, senderToken, query, tenantRef, build, destinationId, workspace, credentials, roles,
  documentation = [], probeCount = DEFAULT_PROBES, replayFromSeq = 0, runId = `keel-rt-sentinel-${randomUUID()}`,
  now = () => new Date(), sleep = (ms) => new Promise((done) => setTimeout(done, ms)), uuid = randomUUID,
  queryAttempts = 20, queryDelayMs = 30 * 1000,
}) {
  const problems = sentinelIdentityProblems({ tenantRef, destinationId, runId, probeCount });
  if (!Number.isSafeInteger(replayFromSeq) || replayFromSeq < 0 || replayFromSeq >= probeCount) problems.push('--replay-from-seq must name a probe sequence');
  const config = {
    endpoint: workspace?.endpoint, dcrImmutableId: workspace?.dcrImmutableId, credentialRef: credentials?.sender,
    ...(workspace?.cloud ? { cloud: workspace.cloud } : {}),
  };
  for (const item of sentinelSetupPrerequisites(config)) problems.push(`pending setup prerequisite: ${item.name}`);
  if (typeof workspace?.workspaceId !== 'string' || !GUID_RE.test(workspace.workspaceId)) problems.push('--workspace-id must be the workspace GUID');
  if (!credentials?.reader || credentials.reader === credentials.sender) problems.push('the reader credential must be separate from the sender');
  if (problems.length) throw new Error(problems.join('; '));

  const destination = { id: destinationId, tenant_ref: tenantRef, kind: SENTINEL_DESTINATION_KIND, config };
  const log = { runId, deliveries: [], queries: [] };
  const startedAt = now().toISOString();
  const envelopes = sentinelProbeEnvelopes({ tenantRef, runId, probeCount, observedAt: startedAt });
  const tokenProvider = async () => senderToken();

  const deliverAll = async (adapter, phase, batch) => {
    for (const envelope of batch) {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        const sentAt = now().toISOString();
        let result;
        try {
          result = await adapter.deliver({ destination, envelope, eventId: envelope.eventId });
        } catch (error) {
          result = { outcome: 'threw', error: error instanceof Error ? error.message : String(error) };
        }
        const entry = {
          phase, eventId: envelope.eventId, attempt, sentAt, outcome: result.outcome,
          error: result.outcome === 'accepted' ? null : (result.error ?? result.reason ?? 'no reason given'),
          clientRequestId: result.clientRequestId ?? null, serviceRequestId: result.serviceRequestId ?? null,
          retryAfterMs: result.retryAfterMs ?? null,
        };
        log.deliveries.push(entry);
        if (result.outcome === 'accepted' || result.outcome === 'poison' || result.outcome === 'threw') break;
        await sleep(result.retryAfterMs ?? 1000 * attempt);
      }
    }
  };

  await deliverAll(createSentinelAdapter({ fetchImpl: ingestFetch, tokenProvider, uuid }), 'initial', envelopes);
  // Restart: a fresh adapter instance redelivers under the same event ids.
  await deliverAll(createSentinelAdapter({ fetchImpl: ingestFetch, tokenProvider, uuid }), 'replay', envelopes.slice(replayFromSeq));

  const { rawQuery, logicalQuery } = sentinelReceiverQueries({ tenantRef, destinationId, runId });
  let rawRows = [];
  let logicalRows = [];
  let queriedAt = null;
  for (let poll = 1; poll <= queryAttempts; poll += 1) {
    const run = async (kind, kql) => {
      const at = now().toISOString();
      let response;
      try { response = await query(kql); } catch (error) { response = { status: 0, error: error instanceof Error ? error.message : String(error) }; }
      const rows = response.status === 200 ? tableRows(response.body) : null;
      log.queries.push({ poll, kind, at, status: response.status, rows: rows?.length ?? null, error: rows ? null : (response.error ?? `HTTP ${response.status}`) });
      return { rows, at };
    };
    const raw = await run('raw', rawQuery);
    const logical = await run('logical', logicalQuery);
    if (raw.rows && logical.rows) {
      rawRows = raw.rows;
      logicalRows = logical.rows;
      queriedAt = logical.at;
      const seen = new Set(logicalRows.map((row) => row.KeelEventId));
      if (envelopes.every((envelope) => seen.has(envelope.eventId))) break;
    }
    if (poll < queryAttempts) await sleep(queryDelayMs);
  }

  const probes = envelopes.map((envelope) => ({
    eventId: envelope.eventId, sourceSequence: envelope.sourceSequence, eventType: envelope.eventType,
    tenantRef: envelope.tenantRef, observedAt: envelope.observedAt,
  }));
  log.rawRows = rawRows;
  log.logicalRows = logicalRows;
  const captureLog = `${JSON.stringify(log, null, 2)}\n`;
  const record = {
    contractVersion: QUALIFICATION_CONTRACT_VERSION,
    gate: SENTINEL_LIVE_GATE,
    tenantRef,
    build,
    operation: SENTINEL_LIVE_OPERATION,
    credentialMode: SENTINEL_LIVE_CREDENTIAL_MODE,
    observedAt: now().toISOString(),
    evidenceLevel: 'live-qualified',
    synthetic: false,
    subject: {
      prerequisites: [...SENTINEL_LIVE_PREREQUISITES],
      runId,
      credentials: { sender: credentials.sender, reader: credentials.reader },
      roles: { sender: [...(roles?.sender ?? [])], reader: [...(roles?.reader ?? [])] },
      workspace: {
        workspaceId: workspace.workspaceId.toLowerCase(), cloud: workspace.cloud ?? 'public', endpoint: workspace.endpoint,
        dcrImmutableId: workspace.dcrImmutableId, streamName: SENTINEL_STREAM_NAME, table: SENTINEL_TABLE_NAME,
        apiVersion: LOGS_INGESTION_API_VERSION, schemaColumns: SENTINEL_COLUMNS.map((column) => column.name),
      },
      destination: { id: destinationId, tenantRef, kind: SENTINEL_DESTINATION_KIND },
      deliverySemantics: 'at-least-once',
      dedupKey: [...SENTINEL_DEDUP_KEY],
      claims: ['logical-dedup-by-event-id'],
      probes,
      deliveries: log.deliveries,
      replay: { fromSeq: replayFromSeq, restartedAdapter: true },
      receiver: { rawQuery, logicalQuery, polls: Math.max(0, ...log.queries.map((item) => item.poll)), queriedAt, rawRows, logicalRows },
      results: sentinelResults({ probes, deliveries: log.deliveries, rawRows, logicalRows }),
      documentation,
      captureLogSha256: sha256Hex(captureLog),
    },
  };
  return pseudonymizeCapture({ record, log });
}

/**
 * Writes the record and its capture log side by side, binding the log's digest as
 * the artifact proof, and signs the record when a runner key is given.
 */
export function writeSentinelAcceptanceFiles({ record, captureLog, outPath, hmacKey = null }) {
  const logPath = outPath.replace(/\.json$/, '') + '.capture.json';
  writeFileSync(logPath, captureLog);
  let evidence = { ...record, proof: { artifact: { path: basename(logPath), sha256: sha256Hex(captureLog) } } };
  if (hmacKey) evidence = signEvidence(evidence, hmacKey, 'keel-release-runner');
  writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`);
  return { evidence, logPath };
}

/**
 * The import seam: a record that passes the gate with --require-live becomes one
 * live-qualified Sentinel ingestion claim for its tenant, destination and build.
 * Anything else becomes nothing. Nothing in production consumes it yet.
 */
export function sentinelQualificationFromAcceptance(evidence, options = {}) {
  const result = verifyEvidence(evidence, { ...options, gate: SENTINEL_LIVE_GATE, requireLive: true });
  if (!result.ok) return { ok: false, failures: result.failures, claim: null };
  const { subject } = evidence;
  return {
    ok: true,
    failures: [],
    claim: {
      kind: SENTINEL_DESTINATION_KIND, state: 'live-qualified', tenantRef: evidence.tenantRef, build: evidence.build,
      destinationId: subject.destination.id, deliverySemantics: 'at-least-once', dedup: 'logical', dedupKey: [...subject.dedupKey],
      observedAt: evidence.observedAt, maxDelayMs: subject.results.delayMs.max, physicalDuplicates: subject.results.physicalDuplicates,
      proofRef: `${SENTINEL_LIVE_GATE}@${subject.captureLogSha256}`,
    },
  };
}

/** A fetch-backed read-only query transport for one bearer token. The token never leaves this closure. */
export function logAnalyticsQueryTransport({ token, workspaceId, cloud = 'public', fetchImpl = globalThis.fetch }) {
  const host = LOG_ANALYTICS_QUERY_HOST[cloud];
  if (!host) throw new Error(`unknown cloud '${cloud}'`);
  return async (kql) => {
    const response = await fetchImpl(`${host}/v1/workspaces/${encodeURIComponent(workspaceId)}/query`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query: kql, timespan: 'P1D' }),
    });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    return { status: response.status, body };
  };
}

function parseSentinelArgs(argv) {
  const [command = 'plan', ...rest] = argv;
  const options = { command, confirm: false };
  const names = {
    '--tenant-ref': 'tenantRef', '--destination-id': 'destinationId', '--workspace-id': 'workspaceId', '--endpoint': 'endpoint',
    '--dcr-immutable-id': 'dcrImmutableId', '--cloud': 'cloud', '--sender-ref': 'senderRef', '--reader-ref': 'readerRef',
    '--roles': 'roles', '--docs': 'docs', '--out': 'out', '--build': 'build', '--probe-count': 'probeCount', '--replay-from-seq': 'replayFromSeq',
  };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === '--confirm-live-workspace-ingest') options.confirm = true;
    else if (names[arg]) options[names[arg]] = rest[++index];
    else throw new Error(`unknown argument: ${arg}`);
  }
  for (const key of ['probeCount', 'replayFromSeq']) if (options[key] !== undefined) options[key] = Number(options[key]);
  return options;
}

export async function main(argv = process.argv.slice(2), {
  out = console.log, env = process.env, fetchImpl = globalThis.fetch, readFile = (path) => readFileSync(path, 'utf8'),
} = {}) {
  const options = parseSentinelArgs(argv);
  if (options.command === 'plan') {
    out(JSON.stringify(sentinelCapturePlan(options), null, 2));
    return 0;
  }
  if (options.command !== 'capture') throw new Error('usage: sentinelLive.mjs plan|capture ...');
  if (!options.confirm) {
    out(JSON.stringify(sentinelCapturePlan(options), null, 2));
    out('refused: a capture ingests probe events into the configured workspace; rerun with --confirm-live-workspace-ingest');
    return 2;
  }
  for (const [flag, key] of [
    ['--tenant-ref', 'tenantRef'], ['--destination-id', 'destinationId'], ['--workspace-id', 'workspaceId'], ['--endpoint', 'endpoint'],
    ['--dcr-immutable-id', 'dcrImmutableId'], ['--sender-ref', 'senderRef'], ['--reader-ref', 'readerRef'], ['--roles', 'roles'],
    ['--docs', 'docs'], ['--out', 'out'],
  ]) {
    if (!options[key]) throw new Error(`capture needs ${flag}`);
  }
  if (!env.KEEL_SENTINEL_SENDER_TOKEN || !env.KEEL_SENTINEL_READER_TOKEN) {
    throw new Error('capture needs KEEL_SENTINEL_SENDER_TOKEN and KEEL_SENTINEL_READER_TOKEN in the environment');
  }
  const build = options.build ?? env.KEEL_QUALIFICATION_BUILD;
  if (!build) throw new Error('capture needs --build (or KEEL_QUALIFICATION_BUILD): the build this capture qualifies');
  const outPath = resolve(options.out);
  const cloud = options.cloud ?? 'public';
  const { record, captureLog } = await captureSentinelAcceptance({
    ingestFetch: fetchImpl,
    senderToken: () => env.KEEL_SENTINEL_SENDER_TOKEN,
    query: logAnalyticsQueryTransport({ token: env.KEEL_SENTINEL_READER_TOKEN, workspaceId: options.workspaceId, cloud, fetchImpl }),
    tenantRef: options.tenantRef,
    build,
    destinationId: options.destinationId,
    workspace: { workspaceId: options.workspaceId, endpoint: options.endpoint, dcrImmutableId: options.dcrImmutableId, cloud },
    credentials: { sender: options.senderRef, reader: options.readerRef },
    roles: JSON.parse(readFile(options.roles)),
    documentation: JSON.parse(readFile(options.docs)),
    ...(options.probeCount !== undefined ? { probeCount: options.probeCount } : {}),
    ...(options.replayFromSeq !== undefined ? { replayFromSeq: options.replayFromSeq } : {}),
  });
  const { evidence, logPath } = writeSentinelAcceptanceFiles({ record, captureLog, outPath, hmacKey: env.KEEL_QUALIFICATION_HMAC_KEY ?? null });
  const result = verifyEvidence(evidence, {
    gate: SENTINEL_LIVE_GATE, tenantRef: options.tenantRef, build, requireLive: true, evidenceDir: dirname(outPath),
    hmacKey: env.KEEL_QUALIFICATION_HMAC_KEY ?? null,
  });
  out(JSON.stringify({ evidence: outPath, captureLog: logPath, results: record.subject.results, verify: result }, null, 2));
  return result.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then((code) => { process.exitCode = code; }, (error) => { console.error(error.message); process.exitCode = 2; });
}
