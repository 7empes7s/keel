#!/usr/bin/env node
// /opt/keel/cli/keel-drift.mjs
//
// node keel-drift.mjs detect --config /etc/keel/tenant.json [--db-url $KEEL_DB_URL]
// node keel-drift.mjs list [--config /etc/keel/tenant.json] [--db-url $KEEL_DB_URL]
// node keel-drift.mjs show <driftId> [--db-url $KEEL_DB_URL]
import { snapshotHasFullCoverage } from '../engine/schedules/completions.mjs';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { getToken } from '../tools/tenant-probe/auth.mjs';
import { GraphReader } from '../tools/tenant-probe/graph.mjs';
import { collectM1 } from '../engine/collect/entraAdapter.mjs';
import { canonicalizeAll } from '../engine/cir/canonicalize.mjs';
import {
  completeSnapshot, connect, createSnapshot, getResourceVersions, insertReferences,
  insertResourceVersion,
} from '../engine/store/db.mjs';
import { getActiveBaseline, listOpenDrift, recordDrift } from '../engine/store/governance.mjs';
import { diffSnapshots } from '../engine/govern/diffSnapshots.mjs';
import { isSuppressed } from '../engine/govern/disposition.mjs';
import { syncDriftAlerts } from '../engine/notify/alerts.mjs';

function usage() {
  console.log(`usage:
  keel-drift.mjs detect --config /etc/keel/tenant.json [--db-url $KEEL_DB_URL]
  keel-drift.mjs list [--config /etc/keel/tenant.json] [--db-url $KEEL_DB_URL]
  keel-drift.mjs show <driftId> [--db-url $KEEL_DB_URL]`);
}

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 ? process.argv[index + 1] : fallback;
}

function tenantRefFor(config) {
  return `sha256:${createHash('sha256').update(config.tenantId).digest('hex').slice(0, 16)}`;
}

function readConfig() {
  return JSON.parse(readFileSync(arg('config', '/etc/keel/tenant.json'), 'utf8'));
}

function dbUrl() {
  const url = arg('db-url', process.env.KEEL_DB_URL);
  if (!url) throw new Error('KEEL_DB_URL not set (source /etc/keel/db.env or pass --db-url)');
  return url;
}

async function baselineRows(client, baselineId) {
  const { rows } = await client.query(
    `SELECT rv.*
     FROM baseline_resource br
     JOIN resource_version rv ON rv.id = br.resource_version_id
     WHERE br.baseline_id = $1`,
    [baselineId],
  );
  return rows;
}

async function activeIgnoreDispositions(client, tenantRef) {
  const { rows } = await client.query(
    `SELECT d.natural_key, d.after_hash, p.expires_at
     FROM disposition p
     JOIN drift d ON d.id = p.drift_id
     WHERE d.tenant_ref = $1
       AND p.action = 'ignore'
       AND p.expires_at > now()`,
    [tenantRef],
  );
  return rows.map((row) => ({
    action: 'ignore',
    expiresAt: row.expires_at,
    drift: { naturalKey: row.natural_key, afterHash: row.after_hash },
  }));
}

function printReport(drift, suppressed) {
  const suppressedKeys = new Set(suppressed.map((item) => item.naturalKey));
  const groups = new Map();
  for (const item of drift) {
    if (!groups.has(item.blastRadius)) groups.set(item.blastRadius, []);
    groups.get(item.blastRadius).push(item);
  }

  console.log(`drift report: ${drift.length} detected`);
  console.log(`suppressed drifts: ${suppressed.length}`);
  for (const [blastRadius, items] of [...groups.entries()].sort(([left], [right]) => {
    if (left === 'tenant-lockout') return -1;
    if (right === 'tenant-lockout') return 1;
    return left.localeCompare(right);
  })) {
    console.log(`\n${blastRadius} (${items.length})`);
    for (const item of items) {
      const marker = suppressedKeys.has(item.naturalKey) ? ' [suppressed]' : '';
      console.log(`  ${item.changeType}\t${item.naturalKey}${marker}`);
    }
  }
}

function fieldDiff(before, after, path = '') {
  if (isDeepStrictEqual(before, after)) return [];

  if (Array.isArray(before) && Array.isArray(after)) {
    const fields = [];
    for (let index = 0; index < Math.max(before.length, after.length); index++) {
      fields.push(...fieldDiff(before[index], after[index], `${path}[${index}]`));
    }
    return fields;
  }

  if (isObject(before) && isObject(after)) {
    const fields = [];
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of [...keys].sort()) {
      fields.push(...fieldDiff(before[key], after[key], path ? `${path}.${key}` : key));
    }
    return fields;
  }

  return [{ path: path || '(root)', before, after }];
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function detect() {
  const suppliedSnapshotId = arg('snapshot-id');
  const config = suppliedSnapshotId ? null : readConfig();
  const tenantRef = suppliedSnapshotId ? arg('tenant-ref') : tenantRefFor(config);
  if (!tenantRef) throw new Error('--tenant-ref is required with --snapshot-id');
  const client = await connect(dbUrl());
  try {
    const baseline = await getActiveBaseline(client, { tenantRef });
    if (!baseline) throw new Error(`no active baseline for ${tenantRef}`);

    // /etc/keel/tenant.json is the Collector registration. GraphReader has no
    // write method, so this collection path cannot issue a tenant mutation.
    let snapshotId = suppliedSnapshotId;
    if (suppliedSnapshotId) {
      const { rows: [snapshot] } = await client.query('SELECT * FROM snapshot WHERE id = $1 AND tenant_ref = $2', [snapshotId, tenantRef]);
      if (!snapshotHasFullCoverage(snapshot)) throw new Error('drift-detect deferred: snapshot coverage is incomplete');
    } else {
      const { accessToken } = await getToken(config);
      const reader = new GraphReader(async () => accessToken);
      const resources = canonicalizeAll(await collectM1(reader));
      snapshotId = await createSnapshot(client, { tenantRef });
      const coverageDigest = {};

      for (const resource of resources) {
        coverageDigest[resource.resourceType] = (coverageDigest[resource.resourceType] ?? 0) + 1;
        const versionId = await insertResourceVersion(client, {
          snapshotId,
          resource: { ...resource, fidelity: resource.provenance.fidelity },
        });
        await insertReferences(client, { fromVersion: versionId, references: resource.references });
      }
      await completeSnapshot(client, { id: snapshotId, status: 'complete', coverageDigest });
    }

    const [before, after, dispositions] = await Promise.all([
      baselineRows(client, baseline.id),
      getResourceVersions(client, { snapshotId }),
      activeIgnoreDispositions(client, tenantRef),
    ]);
    const coveredTypes = suppliedSnapshotId
      ? Object.entries((await client.query('SELECT coverage_digest FROM snapshot WHERE id = $1', [snapshotId])).rows[0].coverage_digest)
        .filter(([, entry]) => ['complete', 'complete-empty'].includes(entry?.outcome)).map(([type]) => type)
      : null;
    const drift = diffSnapshots(coveredTypes ? before.filter((row) => coveredTypes.includes(row.resource_type)) : before, after);
    const beforeByNaturalKey = new Map(before.map((row) => [row.natural_key, row]));
    const afterByNaturalKey = new Map(after.map((row) => [row.natural_key, row]));

    for (const item of drift) {
      const beforeRow = beforeByNaturalKey.get(item.naturalKey);
      const afterRow = afterByNaturalKey.get(item.naturalKey);
      await recordDrift(client, {
        tenantRef,
        baselineId: baseline.id,
        observedSnapshot: snapshotId,
        naturalKey: item.naturalKey,
        resourceType: item.resourceType,
        changeType: item.changeType,
        beforeHash: item.beforeHash,
        afterHash: item.afterHash,
        beforePayload: beforeRow?.payload,
        afterPayload: afterRow?.payload,
        blastRadius: item.blastRadius,
      });
    }

    // Task 82: drift rows become alert observations at the snapshot's completion
    // instant, so an older snapshot re-detected later cannot close a newer alert.
    const { rows: [observed] } = await client.query('SELECT completed_at, started_at FROM snapshot WHERE id = $1', [snapshotId]);
    await syncDriftAlerts(client, {
      tenantRef,
      snapshotId,
      observedAt: observed.completed_at ?? observed.started_at,
      drift,
      coveredTypes: coveredTypes ?? [...new Set([...before, ...after].map((row) => row.resource_type))],
    });

    const suppressed = drift.filter((item) => isSuppressed(item, dispositions, new Date()));
    console.log(`snapshot ${snapshotId} complete`);
    printReport(drift, suppressed);
  } finally {
    await client.end();
  }
}

async function list() {
  const config = readConfig();
  const client = await connect(dbUrl());
  try {
    const drift = await listOpenDrift(client, { tenantRef: tenantRefFor(config) });
    console.log('drift id\tnatural key\tchange type\tblast radius');
    for (const item of drift) {
      console.log(`${item.id}\t${item.natural_key}\t${item.change_type}\t${item.blast_radius}`);
    }
  } finally {
    await client.end();
  }
}

async function show(driftId) {
  if (!driftId) throw new Error('show requires a drift id');

  const client = await connect(dbUrl());
  try {
    const { rows } = await client.query('SELECT * FROM drift WHERE id = $1', [driftId]);
    const drift = rows[0];
    if (!drift) throw new Error(`drift not found: ${driftId}`);

    console.log(`drift ${drift.id}`);
    console.log(`natural key: ${drift.natural_key}`);
    console.log(`change type: ${drift.change_type}`);
    console.log(`blast radius: ${drift.blast_radius}`);
    console.log('field\tbefore\tafter');
    for (const item of fieldDiff(drift.before_payload, drift.after_payload)) {
      console.log(`${item.path}\t${JSON.stringify(item.before)}\t${JSON.stringify(item.after)}`);
    }
  } finally {
    await client.end();
  }
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    usage();
    return;
  }

  const [command, driftId] = process.argv.slice(2);
  if (command === 'detect') return detect();
  if (command === 'list') return list();
  if (command === 'show') return show(driftId);
  usage();
  throw new Error(`unknown command: ${command ?? '(none)'}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
