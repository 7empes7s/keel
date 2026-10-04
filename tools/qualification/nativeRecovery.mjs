#!/usr/bin/env node
/**
 * Native recovery evidence capture (roadmap task-115, gate native-live-acceptance).
 *
 *   # Offline (default): an in-process fake Graph, synthetic, fixture-tested.
 *   node tools/qualification/nativeRecovery.mjs capture --out DIR
 *
 *   # Live: one bounded delete → restore round trip on ONE disposable fixture.
 *   node tools/qualification/nativeRecovery.mjs capture --live \
 *     --resource-type group --object-id <id> --confirm-disposable-fixture <id> \
 *     --target-config /etc/keel/restorer.json \
 *     --docs-retrieved-at YYYY-MM-DD --permission Group.ReadWrite.All --out DIR
 *
 * Writes DIR/native-live-acceptance.json (the record) and
 * DIR/native-live-acceptance.artifact.json (the raw captured Graph exchanges,
 * reduced to ids, names and deletedDateTime; no tokens or content). The record
 * is signed with KEEL_QUALIFICATION_HMAC_KEY when it is set: live runs sign as
 * keel-release-runner, offline runs only ever as keel-fixture-runner.
 *
 * Safety (operator sandbox guardrails):
 *  - offline unless --live is given; --live also requires
 *    --confirm-disposable-fixture equal to --object-id;
 *  - the object is read FIRST and refused, before any write, unless its name
 *    is a disposable KEEL-RT-* or keel-rehearsal-* fixture;
 *  - only directory soft-delete types (group, user, application) are touched,
 *    and only one object per run. Conditional Access routes are recorded as a
 *    manual handoff and never written;
 *  - a failed step stops the run and the record says so; it is never written
 *    as a successful recovery.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { NATIVE_RECOVERY_ROUTES, softDeleteDeadline } from '../../engine/restore/recoveryMechanism.mjs';
import {
  DIRECTORY_RESTORE_DOCS, DIRECTORY_RESTORE_OPERATION, DIRECTORY_RESTORE_ROUTE, DIRECTORY_RESTORE_ROUTES,
  DISPOSABLE_FIXTURE_PATTERN, NATIVE_LIVE_CREDENTIAL_MODE, NATIVE_LIVE_GATE,
  NATIVE_LIVE_OPERATION, expectedExchanges, nativeLivePrerequisite,
} from '../../engine/restore/nativeRecoveryEvidence.mjs';
import { tenantRefFor } from '../../engine/store/tenantRef.mjs';
import { QUALIFICATION_CONTRACT_VERSION, signEvidence } from '../release/qualification.mjs';

export const OFFLINE_FIXTURE = Object.freeze({
  tenantId: 'native-recovery-offline-fixture',
  objectId: '00000000-0000-4000-8000-0000000000f1',
  name: 'KEEL-RT-native-recovery-fixture',
  resourceType: 'group',
});
/** Bounded attempts for reads that trail a directory write (Entra replication lag). */
const LAGGED_READ_ATTEMPTS = 5;

/** In-process Graph honouring read, DELETE (to deleted items) and restore. Offline only. */
export function offlineGraph({ now = () => new Date() } = {}) {
  const live = new Map([[`/groups/${OFFLINE_FIXTURE.objectId}`, { id: OFFLINE_FIXTURE.objectId, displayName: OFFLINE_FIXTURE.name }]]);
  const deleted = new Map();
  return {
    async read(_version, path) {
      const d = /^\/directory\/deletedItems\/([^/]+)$/.exec(path);
      if (d) return deleted.has(d[1]) ? { ok: true, status: 200, body: deleted.get(d[1]).body } : { ok: false, status: 404, body: null };
      return live.has(path) ? { ok: true, status: 200, body: live.get(path) } : { ok: false, status: 404, body: null };
    },
    async write(_version, path, { method }) {
      if (method === 'DELETE' && live.has(path)) {
        const body = live.get(path);
        live.delete(path);
        deleted.set(body.id, { path, body: { ...body, deletedDateTime: now().toISOString() } });
        return { ok: true, status: 204, body: null };
      }
      const r = /^\/directory\/deletedItems\/([^/]+)\/restore$/.exec(path);
      if (method === 'POST' && r && deleted.has(r[1])) {
        const { path: livePath, body } = deleted.get(r[1]);
        deleted.delete(r[1]);
        const { deletedDateTime, ...restored } = body;
        live.set(livePath, restored);
        return { ok: true, status: 200, body: restored };
      }
      return { ok: false, status: 404, body: null };
    },
  };
}

/** Keep only what the verifier needs: ids, names and deletedDateTime. */
function reduce(body, nameField) {
  if (!body || typeof body !== 'object') return null;
  const out = { id: body.id ?? null };
  if (nameField && body[nameField] !== undefined) out[nameField] = body[nameField];
  if (body.deletedDateTime !== undefined) out.deletedDateTime = body.deletedDateTime;
  return out;
}

/**
 * Runs one bounded delete → restore round trip against `graph` and returns
 * the operation record plus its raw exchanges. Refuses before any write when
 * the object is not a disposable fixture or the type has no soft-delete route.
 */
export async function captureRoundTrip({ graph, resourceType, objectId, now = () => new Date(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const route = DIRECTORY_RESTORE_ROUTES[resourceType];
  if (!route) throw new Error(`refused: ${resourceType} has no directory soft-delete route (Conditional Access stays manual)`);
  const steps = expectedExchanges(resourceType, objectId);
  const exchanges = [];
  const call = async (step, fn, extra = {}) => {
    const want = steps.find((s) => s.step === step);
    const res = await fn(want);
    exchanges.push({ step, method: want.method, path: want.path, status: res.status, body: reduce(res.body, route.nameField), ...extra });
    return res;
  };
  // Re-reads with linear backoff until the object shows up or the bound is
  // hit; the exchange records the last response plus every attempt's status.
  const laggedRead = async (step) => {
    const want = steps.find((s) => s.step === step);
    const attempts = [];
    for (let attempt = 1; ; attempt += 1) {
      const res = await graph.read('v1.0', want.path);
      attempts.push(res.status);
      if (res.ok || attempt === LAGGED_READ_ATTEMPTS) return call(step, async () => res, { attempts });
      await sleep(2000 * attempt);
    }
  };

  const liveRead = await call('read-live', (w) => graph.read('v1.0', w.path));
  if (!liveRead.ok || liveRead.body?.id !== objectId) throw new Error(`refused: object ${objectId} could not be read (status ${liveRead.status})`);
  const name = liveRead.body[route.nameField];
  if (!DISPOSABLE_FIXTURE_PATTERN.test(name ?? '')) {
    throw new Error(`refused: '${name}' is not a disposable KEEL-RT-* or keel-rehearsal-* fixture; nothing was written`);
  }

  const started = now();
  const result = { resourceType, objectId, operation: null, exchanges, failed: null };
  const stop = (reason) => { result.failed = reason; return result; };

  const del = await call('delete', (w) => graph.write('v1.0', w.path, { method: 'DELETE' }));
  if (del.status !== 204) return stop(`delete returned ${del.status}`);
  const deletedRead = await laggedRead('read-deleted');
  if (!deletedRead.ok) return stop(`deleted-items read returned ${deletedRead.status}; the object is deleted and must be restored manually within retention`);
  const restore = await call('restore', (w) => graph.write('v1.0', w.path, { method: 'POST', body: {} }));
  if (restore.status !== 200) return stop(`restore returned ${restore.status}; restore manually within retention`);
  const restoredAt = now();
  const readBack = await laggedRead('read-back');
  if (!readBack.ok) return stop(`read-back returned ${readBack.status}`);

  result.operation = {
    resourceType,
    operation: DIRECTORY_RESTORE_OPERATION,
    route: DIRECTORY_RESTORE_ROUTE,
    outcome: 'automated',
    fixture: { objectId, name },
    deletedDateTime: deletedRead.body?.deletedDateTime ?? null,
    retentionDeadline: softDeleteDeadline(deletedRead.body),
    restoredAt: restoredAt.toISOString(),
    restoredObjectId: readBack.body?.id ?? null,
    idPreserved: readBack.body?.id === objectId && restore.body?.id === objectId,
  };
  result.elapsedMs = now().getTime() - started.getTime();
  return result;
}

/** Manual-handoff entries for every native route that is not qualified (all of them today). */
export function manualHandoffs() {
  return Object.entries(NATIVE_RECOVERY_ROUTES).map(([resourceType, route]) => ({
    resourceType, route: route.route, outcome: 'manual-handoff', reason: route.reason,
  }));
}

/**
 * Builds the record and artifact. `live` decides the evidence level: offline
 * output is always synthetic and fixture-tested, whatever else is passed.
 */
export function buildEvidence({ live, tenantRef, build, capture, permissions, clientRef, docsRetrievedAt, observedAt }) {
  const artifact = {
    gate: NATIVE_LIVE_GATE, tenantRef, build, capturedAt: observedAt,
    operations: [{ resourceType: capture.resourceType, objectId: capture.objectId, exchanges: capture.exchanges }],
  };
  const artifactText = `${JSON.stringify(artifact, null, 2)}\n`;
  const sha256 = createHash('sha256').update(artifactText).digest('hex');
  const operations = [];
  if (capture.operation) {
    operations.push({ ...capture.operation, docs: { url: DIRECTORY_RESTORE_DOCS, apiVersion: 'v1.0', retrievedAt: docsRetrievedAt } });
  } else {
    operations.push({ resourceType: capture.resourceType, outcome: 'failed', reason: capture.failed });
  }
  operations.push(...manualHandoffs());
  const evidence = {
    contractVersion: QUALIFICATION_CONTRACT_VERSION,
    gate: NATIVE_LIVE_GATE,
    tenantRef,
    build,
    operation: NATIVE_LIVE_OPERATION,
    credentialMode: NATIVE_LIVE_CREDENTIAL_MODE,
    observedAt,
    evidenceLevel: live ? 'live-qualified' : 'fixture-tested',
    synthetic: !live,
    subject: {
      prerequisite: nativeLivePrerequisite(),
      credential: { mode: NATIVE_LIVE_CREDENTIAL_MODE, auth: 'certificate', clientRef, permissions },
      bounds: { maxObjects: 1, objectsTouched: capture.operation ? 1 : 0, elapsedMs: capture.elapsedMs ?? null },
      operations,
      captureSha256: sha256,
    },
    proof: { artifact: { path: `${NATIVE_LIVE_GATE}.artifact.json`, sha256 } },
  };
  return { evidence, artifactText };
}

function arg(argv, name) {
  const i = argv.indexOf(`--${name}`);
  return i > -1 ? argv[i + 1] : undefined;
}

function args(argv, name) {
  return argv.flatMap((v, i) => (v === `--${name}` ? [argv[i + 1]] : []));
}

export async function main({ argv = process.argv.slice(2), env = process.env, out = console, deps = {} } = {}) {
  if (argv[0] !== 'capture') {
    out.error('usage: nativeRecovery.mjs capture --out DIR [--live --resource-type T --object-id ID --confirm-disposable-fixture ID --target-config FILE --docs-retrieved-at DATE --permission P]');
    return 2;
  }
  const outDir = arg(argv, 'out');
  if (!outDir) { out.error('missing --out DIR'); return 2; }
  const live = argv.includes('--live');
  const now = deps.now ?? (() => new Date());
  const build = arg(argv, 'build') ?? deps.build ?? execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

  let graph; let tenantRef; let resourceType; let objectId; let clientRef; let permissions; let docsRetrievedAt;
  if (!live) {
    graph = offlineGraph({ now });
    tenantRef = tenantRefFor(OFFLINE_FIXTURE.tenantId);
    ({ resourceType, objectId } = OFFLINE_FIXTURE);
    clientRef = 'offline-fixture';
    permissions = [DIRECTORY_RESTORE_ROUTES.group.permission];
    docsRetrievedAt = now().toISOString();
  } else {
    resourceType = arg(argv, 'resource-type');
    objectId = arg(argv, 'object-id');
    const targetConfigPath = arg(argv, 'target-config');
    docsRetrievedAt = arg(argv, 'docs-retrieved-at');
    permissions = args(argv, 'permission');
    if (!DIRECTORY_RESTORE_ROUTES[resourceType]) { out.error(`refused: --resource-type must be one of ${Object.keys(DIRECTORY_RESTORE_ROUTES).join(', ')}`); return 2; }
    if (!objectId || arg(argv, 'confirm-disposable-fixture') !== objectId) {
      out.error('refused: --live needs --object-id and a matching --confirm-disposable-fixture'); return 2;
    }
    if (!targetConfigPath || !docsRetrievedAt || permissions.length === 0) {
      out.error('refused: --live needs --target-config, --docs-retrieved-at and at least one --permission'); return 2;
    }
    const readFile = deps.readFile ?? readFileSync;
    const target = JSON.parse(readFile(targetConfigPath, 'utf8'));
    tenantRef = tenantRefFor(target.tenantId);
    clientRef = targetConfigPath; // a reference only; no key material enters the record
    if (deps.graph) graph = deps.graph;
    else {
      const { getToken } = await import('../tenant-probe/auth.mjs');
      const { GraphWriter } = await import('../../engine/restore/graphWriter.mjs');
      const { accessToken } = await getToken(target);
      graph = new GraphWriter(async () => accessToken);
    }
  }

  let capture;
  try {
    capture = await captureRoundTrip({ graph, resourceType, objectId, now, sleep: deps.sleep });
  } catch (error) {
    out.error(error.message);
    return 1;
  }
  const { evidence, artifactText } = buildEvidence({
    live, tenantRef, build, capture, permissions, clientRef, docsRetrievedAt, observedAt: now().toISOString(),
  });
  const key = env.KEEL_QUALIFICATION_HMAC_KEY;
  const record = key ? signEvidence(evidence, key, live ? 'keel-release-runner' : 'keel-fixture-runner') : evidence;
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `${NATIVE_LIVE_GATE}.artifact.json`), artifactText);
  writeFileSync(join(outDir, `${NATIVE_LIVE_GATE}.json`), `${JSON.stringify(record, null, 2)}\n`);
  out.log(`${capture.failed ? 'FAILED' : 'captured'} ${evidence.evidenceLevel} native recovery evidence in ${outDir}${key ? '' : ' (unsigned: KEEL_QUALIFICATION_HMAC_KEY not set)'}`);
  if (capture.failed) out.error(capture.failed);
  return capture.failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; });
}
