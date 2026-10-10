#!/usr/bin/env node
// /opt/keel/cli/keel-plan.mjs
//
// node keel-plan.mjs --source-config /etc/keel/tenant.json \
//                     --target-config /etc/keel/tenant-target.json \
//                     --db-url $KEEL_DB_URL
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { getToken } from '../tools/tenant-probe/auth.mjs';
import { GraphReader } from '../tools/tenant-probe/graph.mjs';
import { collectM1 } from '../engine/collect/entraAdapter.mjs';
import { canonicalizeAll } from '../engine/cir/canonicalize.mjs';
import { resolvePlan } from '../engine/graph/resolver.mjs';
import { buildGapReport, isPlanClean } from '../engine/graph/preflight.mjs';
import { assertBreakGlassCoverage } from '../engine/safety/breakGlassInvariant.mjs';
import { globalAdministratorPrincipalIds } from '../engine/safety/protectedPrincipals.mjs';
import { connect, getLatestSnapshot, getResourceVersions, getReferences } from '../engine/store/db.mjs';
import { tenantRefFor } from '../engine/store/tenantRef.mjs';

function arg(name, fallback, argv = process.argv) {
  const i = argv.indexOf(`--${name}`);
  return i > -1 ? argv[i + 1] : fallback;
}

function isUsableSnapshot(snapshot) {
  return snapshot?.status === 'complete' && snapshot.completed_at != null;
}

export async function runPlan({
  sourceConfig,
  targetConfig,
  dbUrl = process.env.KEEL_DB_URL,
  dependencies = {},
  logger = console,
}) {
  const {
    connect: connectFn = connect,
    getLatestSnapshot: getLatestSnapshotFn = getLatestSnapshot,
    getResourceVersions: getResourceVersionsFn = getResourceVersions,
    getReferences: getReferencesFn = getReferences,
    getToken: getTokenFn = getToken,
    GraphReader: GraphReaderClass = GraphReader,
    collectM1: collectM1Fn = collectM1,
  } = dependencies;

  const tenantRef = tenantRefFor(sourceConfig.tenantId);
  let client;
  try {
    client = await connectFn(dbUrl);
    const snapshot = await getLatestSnapshotFn(client, { tenantRef });
    if (!snapshot) throw new Error(`no snapshot found for ${tenantRef} — run keel-collect.mjs first`);
    if (!isUsableSnapshot(snapshot)) {
      throw new Error(`snapshot ${snapshot.id} is not a usable completed snapshot`);
    }

    const versions = await getResourceVersionsFn(client, { snapshotId: snapshot.id });
    const references = await getReferencesFn(client, { snapshotId: snapshot.id });
    const refsByVersion = new Map();
    for (const r of references) {
      if (!refsByVersion.has(r.from_version)) refsByVersion.set(r.from_version, []);
      refsByVersion.get(r.from_version).push({ field: r.field_path, symbol: r.to_symbol, required: r.required });
    }
    const resources = versions.map((v) => ({
      naturalKey: v.natural_key, resourceType: v.resource_type, payload: v.payload,
      references: refsByVersion.get(v.id) ?? [], blastRadius: v.blast_radius,
    }));

    const targetToken = await getTokenFn(targetConfig);
    const targetReader = new GraphReaderClass(async () => targetToken);
    const targetCollected = await collectM1Fn(targetReader);
    const targetResources = canonicalizeAll(targetCollected);
    const targetIndex = new Map(targetResources.map((r) => [r.naturalKey, r.sourceId]));

    const { resolved, unresolved } = resolvePlan(resources, {
      targetIndex, mappingTable: new Map(), runProvenance: new Map(),
    });
    const report = buildGapReport({ resources, unresolved });
    logger.log(report.text);

    if (isPlanClean(report)) {
      const breakGlassUserIds = globalAdministratorPrincipalIds(targetResources);
      const caInRestoreSet = resolved.filter((r) => r.resourceType === 'conditionalAccessPolicy');
      const bg = assertBreakGlassCoverage({ breakGlassUserIds, caPoliciesInRestoreSet: caInRestoreSet.map((r) => r.payload) });
      if (!bg.ok) logger.log(`\nBREAK-GLASS INVARIANT FAILED: ${bg.reason}`);
      else logger.log('\nbreak-glass invariant: OK');
    }

    const { rows } = await client.query(
      `INSERT INTO plan (source_snapshot, target_tenant, preflight, clean) VALUES ($1,$2,$3,$4) RETURNING id`,
      [snapshot.id, targetConfig.tenantId, report, isPlanClean(report)],
    );
    logger.log(`\nplan ${rows[0].id} saved (clean=${isPlanClean(report)})`);

    return { snapshot, resources, resolved, unresolved, report };
  } finally {
    await client?.end();
  }
}

export async function main({
  argv = process.argv,
  readFile = readFileSync,
  dbUrl = process.env.KEEL_DB_URL,
  dependencies,
  logger = console,
} = {}) {
  const sourceConfig = JSON.parse(readFile(arg('source-config', '/etc/keel/tenant.json', argv), 'utf8'));
  const targetConfig = JSON.parse(readFile(arg('target-config', undefined, argv), 'utf8'));
  return runPlan({
    sourceConfig,
    targetConfig,
    dbUrl: arg('db-url', dbUrl, argv),
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
