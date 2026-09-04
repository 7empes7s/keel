#!/usr/bin/env node
// /opt/keel/cli/keel-plan.mjs
//
// node keel-plan.mjs --source-config /etc/keel/tenant.json \
//                     --target-config /etc/keel/tenant-target.json \
//                     --db-url $KEEL_DB_URL
import { readFileSync } from 'node:fs';
import { getToken } from '../tools/tenant-probe/auth.mjs';
import { GraphReader } from '../tools/tenant-probe/graph.mjs';
import { collectM1 } from '../engine/collect/entraAdapter.mjs';
import { canonicalizeAll } from '../engine/cir/canonicalize.mjs';
import { resolvePlan } from '../engine/graph/resolver.mjs';
import { buildGapReport, isPlanClean } from '../engine/graph/preflight.mjs';
import { assertBreakGlassCoverage } from '../engine/safety/breakGlassInvariant.mjs';
import { connect, getLatestSnapshot, getResourceVersions, getReferences } from '../engine/store/db.mjs';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}

async function main() {
  const dbUrl = arg('db-url', process.env.KEEL_DB_URL);
  const sourceConfig = JSON.parse(readFileSync(arg('source-config', '/etc/keel/tenant.json'), 'utf8'));
  const targetConfig = JSON.parse(readFileSync(arg('target-config'), 'utf8'));

  const client = await connect(dbUrl);
  const tenantRef = `sha256:${sourceConfig.tenantId}`; // matches keel-collect.mjs's hashing intent; exact digest not required to be identical here since we only need the latest row
  const snapshot = await getLatestSnapshot(client, { tenantRef });
  if (!snapshot) throw new Error(`no snapshot found for ${tenantRef} — run keel-collect.mjs first`);

  const versions = await getResourceVersions(client, { snapshotId: snapshot.id });
  const references = await getReferences(client, { snapshotId: snapshot.id });
  const refsByVersion = new Map();
  for (const r of references) {
    if (!refsByVersion.has(r.from_version)) refsByVersion.set(r.from_version, []);
    refsByVersion.get(r.from_version).push({ field: r.field_path, symbol: r.to_symbol, required: r.required });
  }
  const resources = versions.map((v) => ({
    naturalKey: v.natural_key, resourceType: v.resource_type, payload: v.payload,
    references: refsByVersion.get(v.id) ?? [], blastRadius: v.blast_radius,
  }));

  const targetToken = await getToken(targetConfig);
  const targetReader = new GraphReader(async () => targetToken);
  const targetCollected = await collectM1(targetReader);
  const targetResources = canonicalizeAll(targetCollected);
  const targetIndex = new Map(targetResources.map((r) => [r.naturalKey, r.sourceId]));

  const { resolved, unresolved } = resolvePlan(resources, {
    targetIndex, mappingTable: new Map(), runProvenance: new Map(),
  });
  const report = buildGapReport({ resources, unresolved });
  console.log(report.text);

  if (isPlanClean(report)) {
    const breakGlassUserIds = targetResources
      .filter((r) => r.resourceType === 'roleAssignment' && r.naturalKey.includes('GlobalAdministrator'))
      .map((r) => r.payload.principalId);
    const caInRestoreSet = resolved.filter((r) => r.resourceType === 'conditionalAccessPolicy');
    const bg = assertBreakGlassCoverage({ breakGlassUserIds, caPoliciesInRestoreSet: caInRestoreSet.map((r) => r.payload) });
    if (!bg.ok) console.log(`\nBREAK-GLASS INVARIANT FAILED: ${bg.reason}`);
    else console.log('\nbreak-glass invariant: OK');
  }

  await client.query(
    `INSERT INTO plan (source_snapshot, target_tenant, preflight, clean) VALUES ($1,$2,$3,$4) RETURNING id`,
    [snapshot.id, targetConfig.tenantId, report, isPlanClean(report)],
  ).then(({ rows }) => console.log(`\nplan ${rows[0].id} saved (clean=${isPlanClean(report)})`));

  await client.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
