#!/usr/bin/env node
/**
 * Roadmap task-72: offline and bounded same-tenant recovery drills.
 *
 * Two modes, and only two:
 *
 *  - offline (the default) validates a drill manifest against the loaded
 *    Collector/Restorer configuration and the rehearsal database URL. It reads
 *    configuration files and nothing else: no token, no database connection,
 *    no Graph call, no evidence row. Its verdict is a plan check and never
 *    counts as a recovery drill (countsAsRecoveryDrill is always false).
 *  - live runs the existing disposable-object round trip
 *    (tools/rehearsal/roundTrip.mjs) only when the caller opts in explicitly
 *    (confirm: true / --confirm-bounded-drill), only against the rehearsal
 *    database, only for the allowlisted disposable objects the manifest pins
 *    to the Collector's tenant, and only inside its write and time bounds.
 *    Elapsed time is read from the injected clock around the run; cleanup is
 *    verified by reading every created object back as absent, and a residual
 *    is reported, never hidden. The drill's evidence row is written to the
 *    rehearsal database the round trip already uses.
 *
 * There is no cloned tenant and no tenant-wide policy rehearsal: the only
 * resource type a manifest may name is the round trip's disposable group.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { appendEvidence } from '../../engine/govern/evidence.mjs';
import { RECOVERY_DRILL_EVIDENCE_KIND } from '../../engine/coverage/recoveryReadiness.mjs';
import { connect } from '../../engine/store/db.mjs';
import {
  DISPOSABLE_PREFIX, INTENDED_SEQUENCE, assertDisposable, assertRehearsalDatabase,
  assertSeparateRestorer, rehearsalGroup, runRoundTrip, tenantRefFor,
} from './roundTrip.mjs';

export const DRILL_MANIFEST_VERSION = 1;
export const DRILL_MANIFEST_KIND = 'bounded-same-tenant-drill';

/** Hard ceilings a manifest may ask for, never exceed. One round trip touches one object. */
export const DRILL_LIMITS = Object.freeze({
  maxObjects: 1,
  maxElapsedMs: 30 * 60_000,
  maxWrites: 40,
});

const MANIFEST_FIELDS = new Set(['version', 'kind', 'tenantRef', 'startAt', 'objects', 'bounds']);
const DRILL_RESOURCE_TYPES = new Set(['group']);

function finding(code, message) {
  return { code, message };
}

/** A manifest for one round trip starting now, pinned to the Collector's tenant. */
export function buildDrillManifest({ collectorConfig, now = new Date(), bounds = {} }) {
  if (!collectorConfig?.tenantId) throw new Error('a drill manifest needs the Collector tenantId');
  const startAt = now.toISOString();
  const { naturalKey } = rehearsalGroup(startAt);
  return {
    version: DRILL_MANIFEST_VERSION,
    kind: DRILL_MANIFEST_KIND,
    tenantRef: tenantRefFor(collectorConfig),
    startAt,
    objects: [{ resourceType: 'group', naturalKey }],
    bounds: {
      maxElapsedMs: bounds.maxElapsedMs ?? 15 * 60_000,
      maxWrites: bounds.maxWrites ?? 30,
    },
  };
}

/**
 * Pure manifest check. Every refusal is a named finding; an empty list is the
 * only passing result. Reads nothing and writes nothing.
 */
export function validateDrillManifest(manifest, {
  collectorConfig, restorerConfig, dbUrl, productionUrl = process.env.KEEL_DB_URL,
} = {}) {
  const findings = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return [finding('manifest-missing', 'the drill manifest is not an object')];
  }
  for (const field of Object.keys(manifest)) {
    if (!MANIFEST_FIELDS.has(field)) {
      findings.push(finding('unknown-field', `the manifest field "${field}" is not part of a bounded drill (no cloned tenant, no tenant-wide rehearsal)`));
    }
  }
  if (manifest.version !== DRILL_MANIFEST_VERSION) {
    findings.push(finding('manifest-version', `unsupported drill manifest version ${manifest.version}`));
  }
  if (manifest.kind !== DRILL_MANIFEST_KIND) {
    findings.push(finding('manifest-kind', `the manifest kind must be ${DRILL_MANIFEST_KIND}`));
  }

  // Tenant pin: the manifest names exactly the tenant the loaded Collector reads.
  if (!collectorConfig?.tenantId) {
    findings.push(finding('tenant-config-missing', 'no Collector tenantId is configured'));
  } else if (!manifest.tenantRef) {
    findings.push(finding('tenant-pin-missing', 'the manifest does not pin a tenant'));
  } else if (manifest.tenantRef !== tenantRefFor(collectorConfig)) {
    findings.push(finding('foreign-tenant', 'the manifest pins a tenant other than the configured Collector tenant'));
  }
  if (collectorConfig?.tenantId && restorerConfig) {
    try {
      assertSeparateRestorer(collectorConfig, restorerConfig);
    } catch (error) {
      findings.push(finding(
        /tenantId/.test(error.message) ? 'foreign-tenant' : 'shared-credentials',
        error.message,
      ));
    }
  } else if (!restorerConfig) {
    findings.push(finding('restorer-config-missing', 'no Restorer configuration is loaded'));
  }

  // Allowlisted objects: disposable, planned by this manifest's own start time, few.
  const startAt = typeof manifest.startAt === 'string' ? new Date(manifest.startAt) : null;
  if (!startAt || Number.isNaN(startAt.getTime()) || startAt.toISOString() !== manifest.startAt) {
    findings.push(finding('start-missing', 'the manifest needs an exact ISO startAt'));
  }
  const objects = Array.isArray(manifest.objects) ? manifest.objects : [];
  if (objects.length === 0) findings.push(finding('no-objects', 'the manifest allowlists no object'));
  if (objects.length > DRILL_LIMITS.maxObjects) {
    findings.push(finding('too-many-objects', `a bounded drill allowlists at most ${DRILL_LIMITS.maxObjects} object`));
  }
  const planned = findings.some((item) => item.code === 'start-missing') ? null : rehearsalGroup(manifest.startAt).naturalKey;
  for (const object of objects) {
    if (!DRILL_RESOURCE_TYPES.has(object?.resourceType)) {
      findings.push(finding('unsupported-resource-type', `${object?.resourceType} is not a disposable drill type`));
    }
    try {
      assertDisposable(object?.naturalKey);
    } catch {
      findings.push(finding('non-disposable-target', `${object?.naturalKey} is not a disposable ${DISPOSABLE_PREFIX}* object`));
      continue;
    }
    if (planned && object.naturalKey !== planned) {
      findings.push(finding('object-not-planned', `${object.naturalKey} is not the object this drill creates (${planned})`));
    }
  }

  const bounds = manifest.bounds ?? {};
  for (const [name, limit] of [['maxElapsedMs', DRILL_LIMITS.maxElapsedMs], ['maxWrites', DRILL_LIMITS.maxWrites]]) {
    const value = bounds[name];
    if (!Number.isInteger(value) || value <= 0) {
      findings.push(finding('bounds-missing', `bounds.${name} must be a positive integer`));
    } else if (value > limit) {
      findings.push(finding('bounds-exceeded', `bounds.${name} ${value} exceeds the ceiling ${limit}`));
    }
  }

  try {
    assertRehearsalDatabase(dbUrl, productionUrl);
  } catch (error) {
    findings.push(finding(dbUrl ? 'production-db' : 'test-db-missing', error.message));
  }
  return findings;
}

function readJson(path) {
  return path ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
}

/**
 * Offline plan validation. Reads the two configuration files; makes no write,
 * no connection and no Graph call, and never counts as a recovery drill.
 */
export function validateDrillPlan({
  manifest, collectorConfigPath = '/etc/keel/tenant.json', restorerConfigPath,
  dbUrl = process.env.KEEL_DB_TEST_URL, productionUrl = process.env.KEEL_DB_URL,
}) {
  const collectorConfig = readJson(collectorConfigPath);
  const restorerConfig = readJson(restorerConfigPath);
  const findings = validateDrillManifest(manifest, { collectorConfig, restorerConfig, dbUrl, productionUrl });
  return {
    mode: 'offline',
    ok: findings.length === 0,
    findings,
    countsAsRecoveryDrill: false,
    note: 'offline validation checks the plan only; it is not a recovery drill',
    sequence: INTENDED_SEQUENCE,
    writes: 0,
  };
}

function objectIdFromPath(path) {
  const match = /^\/(?:groups|directory\/deletedItems)\/([^/?]+)$/.exec(path);
  return match ? match[1] : null;
}

/**
 * The write boundary of a live drill. It permits the one POST that creates the
 * allowlisted object, later writes only to objects created through it, no
 * non-cleanup write after the time bound, and no write beyond the write bound
 * (cleanup keeps a small reserve so a bounded drill can still remove its object).
 */
export function boundedWriter(writer, { manifest, clock, startedAt }) {
  const allowlisted = new Set(manifest.objects.map((object) => object.naturalKey));
  const created = new Map();
  let writes = 0;
  const cleanupReserve = 4;
  return {
    created,
    get writes() { return writes; },
    read: (...args) => writer.read(...args),
    async write(version, path, request) {
      const method = request?.method;
      const isCleanup = method === 'DELETE' && created.has(objectIdFromPath(path));
      if (writes >= manifest.bounds.maxWrites + (isCleanup ? cleanupReserve : 0)) {
        throw new Error(`drill write bound reached (${manifest.bounds.maxWrites}); refusing ${method} ${path}`);
      }
      if (!isCleanup && clock() - startedAt > manifest.bounds.maxElapsedMs) {
        throw new Error(`drill time bound reached (${manifest.bounds.maxElapsedMs} ms); refusing ${method} ${path}`);
      }
      if (method === 'POST' && path === '/groups') {
        const naturalKey = `group:${request.body?.mailNickname}`;
        assertDisposable(naturalKey);
        if (!allowlisted.has(naturalKey)) throw new Error(`refusing to create ${naturalKey}: not in the drill allowlist`);
        writes += 1;
        const result = await writer.write(version, path, request);
        if (result?.ok && result.body?.id) created.set(result.body.id, naturalKey);
        return result;
      }
      const id = objectIdFromPath(path);
      if (!id || !created.has(id)) throw new Error(`refusing ${method} ${path}: not an object this drill created`);
      if (request?.body?.mailNickname !== undefined) assertDisposable(`group:${request.body.mailNickname}`);
      writes += 1;
      return writer.write(version, path, request);
    },
  };
}

/** Reads every created object back; anything still readable is a residual. */
export async function verifyCleanup(reader, created) {
  const verifiedAbsent = [];
  const residuals = [];
  for (const [id, naturalKey] of created) {
    for (const [surface, path] of [['live', `/groups/${id}`], ['deleted-items', `/directory/deletedItems/${id}`]]) {
      let result;
      try {
        result = await reader.get('v1.0', path);
      } catch (error) {
        residuals.push({ objectId: id, naturalKey, surface, state: 'unknown', error: error.message });
        continue;
      }
      if (result?.ok === false && result.status === 404) continue;
      residuals.push({
        objectId: id, naturalKey, surface, state: result?.ok ? 'present' : 'unknown', status: result?.status ?? null,
      });
    }
    if (!residuals.some((residual) => residual.objectId === id)) verifiedAbsent.push({ objectId: id, naturalKey });
  }
  return { status: residuals.length ? 'failed' : 'complete', verifiedAbsent, residuals };
}

/**
 * Runs a drill. mode defaults to offline; live needs confirm === true and a
 * manifest that passes every check before the first write. Returns the drill
 * record (also appended as evidence for a live run); never throws for a drill
 * that started, so a failed run or a failed cleanup is reported, not lost.
 */
export async function runBoundedDrill({
  mode = 'offline',
  confirm = false,
  manifest,
  collectorConfigPath = '/etc/keel/tenant.json',
  restorerConfigPath,
  dbUrl = process.env.KEEL_DB_TEST_URL,
  productionUrl = process.env.KEEL_DB_URL,
  writer,
  reader,
  client,
  clock = () => Date.now(),
  log = (line) => process.stdout.write(`${line}\n`),
  actor = 'keel-drill',
  roundTrip = runRoundTrip,
} = {}) {
  if (mode === 'offline') {
    return validateDrillPlan({ manifest, collectorConfigPath, restorerConfigPath, dbUrl, productionUrl });
  }
  if (mode !== 'live') throw new Error(`unknown drill mode: ${mode}`);
  if (confirm !== true) {
    throw new Error('a live drill writes to the tenant: opt in explicitly with --confirm-bounded-drill');
  }
  const collectorConfig = readJson(collectorConfigPath);
  const restorerConfig = readJson(restorerConfigPath);
  const findings = validateDrillManifest(manifest, { collectorConfig, restorerConfig, dbUrl, productionUrl });
  if (findings.length) {
    throw new Error(`drill refused before any write: ${findings.map((item) => item.code).join(', ')}`);
  }
  assertRehearsalDatabase(dbUrl, productionUrl);
  if (!reader) throw new Error('a live drill needs the Collector reader to verify cleanup');

  let ownedClient = false;
  if (!client) {
    client = await connect(dbUrl);
    ownedClient = true;
  }
  try {
    const startedAt = clock();
    const guarded = writer ? boundedWriter(writer, { manifest, clock, startedAt }) : null;
    if (!guarded) throw new Error('a live drill needs an explicit Restorer writer');
    let error = null;
    try {
      await roundTrip({
        mode: 'live',
        log,
        collectorConfigPath,
        restorerConfigPath,
        dbUrl,
        writer: guarded,
        reader,
        client,
        now: () => new Date(manifest.startAt),
      });
    } catch (caught) {
      error = caught.message;
    }
    const cleanup = await verifyCleanup(reader, guarded.created);
    const finishedAt = clock();
    const elapsedMs = finishedAt - startedAt;
    let outcome = 'passed';
    if (error) outcome = 'failed';
    else if (elapsedMs > manifest.bounds.maxElapsedMs) outcome = 'exceeded-bound';
    if (cleanup.status !== 'complete') outcome = outcome === 'passed' ? 'cleanup-failed' : outcome;
    const record = {
      mode: 'live',
      scope: 'bounded-same-tenant',
      manifestVersion: manifest.version,
      tenantRef: manifest.tenantRef,
      objects: manifest.objects.map((object) => object.naturalKey),
      createdObjects: [...guarded.created].map(([objectId, naturalKey]) => ({ objectId, naturalKey })),
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date(finishedAt).toISOString(),
      elapsedMs,
      elapsedSource: 'observed-clock',
      bounds: manifest.bounds,
      writes: guarded.writes,
      outcome,
      error,
      cleanup,
      countsAsRecoveryDrill: outcome === 'passed' && cleanup.status === 'complete',
    };
    await appendEvidence(client, { tenantRef: manifest.tenantRef, kind: RECOVERY_DRILL_EVIDENCE_KIND, subject: record, actor });
    log(`drill ${outcome}: ${elapsedMs} ms observed, cleanup ${cleanup.status}`);
    for (const residual of cleanup.residuals) log(`cleanup residual: ${JSON.stringify(residual)}`);
    return record;
  } finally {
    if (ownedClient) await client.end();
  }
}

function argValue(argv, name) {
  const index = argv.indexOf(`--${name}`);
  return index > -1 ? argv[index + 1] : undefined;
}

/**
 * CLI. Default is offline validation of --manifest; --build-manifest prints a
 * fresh manifest; --live needs --confirm-bounded-drill and injected or
 * credential-built Graph clients (dependencies.makeClients). Exit 0 only for a
 * valid plan (offline) or a counted drill (live).
 */
export async function runCli({ argv = process.argv.slice(2), log = (line) => process.stdout.write(`${line}\n`), dependencies = {} } = {}) {
  const collectorConfigPath = argValue(argv, 'config') ?? '/etc/keel/tenant.json';
  const restorerConfigPath = argValue(argv, 'restorer-config');
  const dbUrl = argValue(argv, 'db-url') ?? process.env.KEEL_DB_TEST_URL;
  if (argv.includes('--build-manifest')) {
    const manifest = buildDrillManifest({ collectorConfig: readJson(collectorConfigPath), now: dependencies.now?.() ?? new Date() });
    const out = argValue(argv, 'out');
    if (out) writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
    log(JSON.stringify(manifest));
    return 0;
  }
  const manifest = readJson(argValue(argv, 'manifest'));
  if (!argv.includes('--live')) {
    const result = validateDrillPlan({ manifest, collectorConfigPath, restorerConfigPath, dbUrl });
    log(JSON.stringify({ mode: result.mode, ok: result.ok, countsAsRecoveryDrill: false, findings: result.findings }));
    return result.ok ? 0 : 1;
  }
  // Refuse before any credential is used: no opt-in, or a manifest that fails offline validation.
  if (!argv.includes('--confirm-bounded-drill')) {
    throw new Error('a live drill writes to the tenant: opt in explicitly with --confirm-bounded-drill');
  }
  const plan = validateDrillPlan({ manifest, collectorConfigPath, restorerConfigPath, dbUrl });
  if (!plan.ok) throw new Error(`drill refused before any write: ${plan.findings.map((item) => item.code).join(', ')}`);
  const clients = dependencies.makeClients
    ? await dependencies.makeClients({ collectorConfigPath, restorerConfigPath })
    : await credentialClients({ collectorConfigPath, restorerConfigPath });
  const record = await runBoundedDrill({
    mode: 'live',
    confirm: argv.includes('--confirm-bounded-drill'),
    manifest,
    collectorConfigPath,
    restorerConfigPath,
    dbUrl,
    log,
    ...clients,
  });
  return record.countsAsRecoveryDrill ? 0 : 1;
}

async function credentialClients({ collectorConfigPath, restorerConfigPath }) {
  const [{ getToken }, { GraphReader }, { GraphWriter }] = await Promise.all([
    import('../tenant-probe/auth.mjs'),
    import('../tenant-probe/graph.mjs'),
    import('../../engine/restore/graphWriter.mjs'),
  ]);
  const collector = await getToken(readJson(collectorConfigPath));
  const restorer = await getToken(readJson(restorerConfigPath));
  return {
    reader: new GraphReader(async () => collector.accessToken),
    writer: new GraphWriter(async () => restorer.accessToken),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCli().then((code) => process.exit(code), (error) => {
    console.error(error.message);
    process.exit(1);
  });
}
