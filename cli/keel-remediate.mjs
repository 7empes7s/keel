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
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { connect } from '../engine/store/db.mjs';
import { buildRollbackPlan } from '../engine/govern/rollbackPlan.mjs';
import { resolveQueuedAutomationPolicies } from '../engine/policy/execute.mjs';
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

  const { rows: baselineRows } = await client.query(
    `SELECT rv.*
     FROM baseline_resource br
     JOIN resource_version rv ON rv.id = br.resource_version_id
     WHERE br.baseline_id = $1`,
    [baselineId],
  );
  const reconciliation = buildRollbackPlan(driftRows, baselineRows);

  return {
    snapshotId: snapshotRows[0].snapshot_id,
    selection: [...new Set(driftRows.map((row) => row.natural_key))],
    reconciliationResources: reconciliation.resources,
  };
}

export async function runRemediate({
  driftIds,
  previewOnly = false,
  targetConfig,
  collectorConfig,
  // Plan task 8 parameters. Optional here so the task-46 preview binding — which
  // never persists or promotes an artifact — can call the same job path without
  // them; runRestore applies its own defaults when they are absent.
  targetConfigPath = /** @type {string | undefined} */ (undefined),
  collectorConfigPath = /** @type {string | undefined} */ (undefined),
  mode,
  acceptDegradation,
  requestedBy = /** @type {string | undefined} */ (undefined),
  readFile = /** @type {((path: string) => string) | undefined} */ (undefined),
  dbUrl = process.env.KEEL_DB_URL,
  dependencies = {},
  logger = console,
}) {
  const {
    connect: connectFn = connect,
    resolveRestoreScope: resolveRestoreScopeFn = resolveRestoreScope,
    runRestore: runRestoreFn = runRestore,
    resolveQueuedAutomationPolicies: resolveQueuedAutomationPoliciesFn = resolveQueuedAutomationPolicies,
    createArtifactId = randomUUID,
  } = dependencies;

  let client;
  let scope;
  let automationPolicyIds = [];
  try {
    client = await connectFn(dbUrl);
    scope = await resolveRestoreScopeFn(client, { driftIds });
    // Roadmap task-55: rediscover server-side, at execution time, which automation
    // policies are still queued on these drift ids (the job payload carries only
    // drift ids by design). A human remediation has no auto_remediation_execution
    // rows and keeps its unchanged, operator-driven path. Only policy identities
    // travel onward — runRestore re-derives the ceiling and run-as constraints from
    // the live policy rows, at both the dry run and again at artifact promotion.
    automationPolicyIds = (await resolveQueuedAutomationPoliciesFn(client, { driftIds }))
      .map((policy) => policy.id);
  } finally {
    await client?.end();
  }

  logger.log(`remediating ${scope.selection.length} natural key(s) from snapshot ${scope.snapshotId}`);
  // Plan task 8: automatic remediation must take the exact immutable dry-run ->
  // promotion path as an operator restore. It never weakens runRestore's raw-selection
  // enforce gate or carries the scope beside the promotion: the dry run persists the
  // server-computed closure, plan digest, target identity and current-state
  // fingerprint, then the enforce invocation is artifact-only. The reconciliation
  // scope (including desired absence for an added-drift delete) is stored in that
  // immutable artifact, so promotion preserves Task 30's exact verb plan.
  if (mode === 'enforce') {
    const artifactId = createArtifactId();
    const dryRun = await runRestoreFn({
      snapshotId: scope.snapshotId,
      reconciliationResources: scope.reconciliationResources,
      targetConfig,
      collectorConfig,
      targetConfigPath,
      collectorConfigPath,
      mode: 'dry-run',
      persistArtifactId: artifactId,
      ...(automationPolicyIds.length ? { automationPolicyIds } : {}),
      requestedBy,
      readFile,
      acceptDegradation,
      dbUrl,
      dependencies,
      logger,
    });
    if (dryRun.artifactId !== artifactId) {
      throw new Error('automatic remediation dry run did not persist its immutable review artifact');
    }
    return runRestoreFn({
      artifactId,
      mode: 'enforce',
      acceptDegradation,
      readFile,
      dbUrl,
      dependencies,
      logger,
    });
  }

  return runRestoreFn({
    ...(previewOnly ? { previewOnly: true } : {}),
    snapshotId: scope.snapshotId,
    reconciliationResources: scope.reconciliationResources,
    targetConfig,
    collectorConfig,
    targetConfigPath,
    collectorConfigPath,
    mode,
    requestedBy,
    readFile,
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
  const targetConfigPath = arg('target-config', undefined, argv);
  if (!targetConfigPath) throw new Error('--target-config <path> required');
  const targetConfig = JSON.parse(readFile(targetConfigPath, 'utf8'));
  const collectorConfigPath = arg('collector-config', undefined, argv);
  if (!collectorConfigPath) throw new Error('--collector-config <path> required for read-only sign-in-path evidence');
  const collectorConfig = JSON.parse(readFile(collectorConfigPath, 'utf8'));
  assertSeparateRestorer(collectorConfig, targetConfig);
  const mode = flag('enforce', argv) ? 'enforce' : 'dry-run';

  return runRemediate({
    driftIds,
    targetConfig,
    collectorConfig,
    targetConfigPath,
    collectorConfigPath,
    mode,
    requestedBy: arg('requested-by', undefined, argv),
    readFile,
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
