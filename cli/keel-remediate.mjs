#!/usr/bin/env node
// /opt/keel/cli/keel-remediate.mjs
//
// node keel-remediate.mjs --drift-id <uuid> [--drift-id <uuid>...] --collector-config /etc/keel/tenant-target.json --target-config /etc/keel/restorer-target.json [--enforce]
//
// Plan task 19: automatic remediation execution. A `remediate` job — whether minted by
// an operator's approved remediate request (plan task 15) or by policy automation
// (engine/policy/execute.mjs) — carries only drift ids (§3.1's job.params). This CLI
// resolves those ids to a restore scope (the drift's own baseline's underlying
// snapshot, and the drifted natural keys) and dispatches through the EXISTING restore
// path, runRestore. Remediation therefore inherits every one of restore's safety gates,
// the §10.3 sign-in path gate included, rather than re-implementing any of them —
// exactly the "same job path, same safety gates" plan task 19 requires. Nothing here
// has its own notion of how to apply a change; it only translates drift ids into a
// restore scope.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { connect } from '../engine/store/db.mjs';
import { assertSeparateRestorer, runRestore } from './keel-restore.mjs';

function arg(name, fallback, argv = process.argv) {
  const i = argv.indexOf(`--${name}`);
  return i > -1 ? argv[i + 1] : fallback;
}
// Repeatable flag (e.g. --drift-id): every occurrence contributes one value.
function argAll(name, argv = process.argv) {
  const values = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === `--${name}` && argv[i + 1] !== undefined) values.push(argv[i + 1]);
  }
  return values;
}
function flag(name, argv = process.argv) {
  return argv.includes(`--${name}`);
}

/** Resolves drift ids to a restore scope: the natural keys that drifted, and the ONE
 * snapshot the shared baseline's resources were seeded from (seedFromSnapshot seeds a
 * whole baseline from a single snapshot, so this is an invariant, not a heuristic — the
 * multi-snapshot case below is defense in depth, not an expected path). Every selected
 * drift row must share one baseline: remediation restores toward one point-in-time
 * baseline, never a mix of two. */
export async function resolveRestoreScope(client, { driftIds }) {
  if (!Array.isArray(driftIds) || driftIds.length === 0
    || driftIds.some((id) => typeof id !== 'string' || id.length === 0)) {
    throw new Error('driftIds must be a non-empty array of drift ids');
  }

  const { rows: driftRows } = await client.query(
    'SELECT * FROM drift WHERE id = ANY($1::uuid[])',
    [driftIds],
  );
  const found = new Set(driftRows.map((row) => row.id));
  const missing = driftIds.filter((id) => !found.has(id));
  if (missing.length > 0) throw new Error(`drift not found: ${missing.join(', ')}`);

  const baselineIds = new Set(driftRows.map((row) => row.baseline_id));
  if (baselineIds.size > 1) {
    throw new Error('all selected drift rows must share the same baseline');
  }
  const [baselineId] = baselineIds;

  const { rows: snapshotRows } = await client.query(
    `SELECT DISTINCT rv.snapshot_id
     FROM baseline_resource br
     JOIN resource_version rv ON rv.id = br.resource_version_id
     WHERE br.baseline_id = $1`,
    [baselineId],
  );
  if (snapshotRows.length === 0) {
    throw new Error(`baseline ${baselineId} has no resources to restore from`);
  }
  if (snapshotRows.length > 1) {
    throw new Error(`baseline ${baselineId} spans more than one snapshot — cannot select a single restore source`);
  }

  return {
    snapshotId: snapshotRows[0].snapshot_id,
    selection: [...new Set(driftRows.map((row) => row.natural_key))],
  };
}

export async function runRemediate({
  driftIds,
  targetConfig,
  collectorConfig,
  mode,
  acceptDegradation,
  dbUrl = process.env.KEEL_DB_URL,
  dependencies = {},
  logger = console,
}) {
  const {
    connect: connectFn = connect,
    resolveRestoreScope: resolveRestoreScopeFn = resolveRestoreScope,
    runRestore: runRestoreFn = runRestore,
  } = dependencies;

  let client;
  let scope;
  try {
    client = await connectFn(dbUrl);
    scope = await resolveRestoreScopeFn(client, { driftIds });
  } finally {
    await client?.end();
  }

  logger.log(`remediating ${scope.selection.length} natural key(s) from snapshot ${scope.snapshotId}`);
  return runRestoreFn({
    snapshotId: scope.snapshotId,
    selection: scope.selection,
    targetConfig,
    collectorConfig,
    mode,
    acceptDegradation,
    dbUrl,
    dependencies,
    logger,
  });
}

export async function main({
  argv = process.argv,
  readFile = readFileSync,
  dbUrl = process.env.KEEL_DB_URL,
  dependencies,
  logger = console,
} = {}) {
  const driftIds = argAll('drift-id', argv);
  if (driftIds.length === 0) throw new Error('--drift-id <uuid> required (repeatable)');
  const targetConfig = JSON.parse(readFile(arg('target-config', undefined, argv), 'utf8'));
  const collectorConfigPath = arg('collector-config', undefined, argv);
  if (!collectorConfigPath) throw new Error('--collector-config <path> required for read-only sign-in-path evidence');
  const collectorConfig = JSON.parse(readFile(collectorConfigPath, 'utf8'));
  assertSeparateRestorer(collectorConfig, targetConfig);
  const mode = flag('enforce', argv) ? 'enforce' : 'dry-run';

  return runRemediate({
    driftIds,
    targetConfig,
    collectorConfig,
    mode,
    acceptDegradation: flag('accept-degradation', argv),
    dbUrl,
    dependencies,
    logger,
  });
}

export async function runCli(options = {}) {
  try {
    await main(options);
    return 0;
  } catch (err) {
    (options.logger ?? console).error(err);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().then((exitCode) => { process.exitCode = exitCode; });
}
