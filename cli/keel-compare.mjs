#!/usr/bin/env node
// /opt/keel/cli/keel-compare.mjs
//
// Wave 2 CMP: compare two snapshots, a snapshot with the tenant now, or two tenants.
// Read-only: it stores nothing, and the live read is the collector's GETs only.
// Every command needs a principal holding the `read` capability.
//
// node keel-compare.mjs snapshots --left <snapshotId> --right <snapshotId> --principal-id <uuid>
// node keel-compare.mjs live [--snapshot <snapshotId>] --principal-id <uuid> [--config /etc/keel/tenant.json]
// node keel-compare.mjs tenants --left <tenantRef> --right <tenantRef> --principal-id <uuid>
// node keel-compare.mjs sources --principal-id <uuid>
//
// Options: --only settings,workloads,content   --json   --db-url $KEEL_DB_URL
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { can } from '../engine/authz/can.mjs';
import { findPrincipalById } from '../engine/authz/principals.mjs';
import {
  CompareError, compareSnapshots, compareTenants, compareWithLive, differenceCount, latestCompletedSnapshot, listCompareSources,
} from '../engine/govern/compare.mjs';
import { connect } from '../engine/store/db.mjs';

const USAGE = `usage:
  keel-compare.mjs snapshots --left <snapshotId> --right <snapshotId> --principal-id <uuid>
  keel-compare.mjs live [--snapshot <snapshotId>] --principal-id <uuid> [--config /etc/keel/tenant.json]
  keel-compare.mjs tenants --left <tenantRef> --right <tenantRef> --principal-id <uuid>
  keel-compare.mjs sources --principal-id <uuid>
options: --only settings,workloads,content  --json  --db-url $KEEL_DB_URL`;

function arg(name, fallback = undefined) {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 ? process.argv[index + 1] : fallback;
}

function required(name) {
  const value = arg(name);
  if (!value) throw new UsageError(`--${name} is required`);
  return value;
}

class UsageError extends Error {}

function dbUrl() {
  const url = arg('db-url', process.env.KEEL_DB_URL);
  if (!url) throw new UsageError('KEEL_DB_URL not set (source /etc/keel/db.env or pass --db-url)');
  return url;
}

function tenantRefFor(config) {
  return `sha256:${createHash('sha256').update(config.tenantId).digest('hex').slice(0, 16)}`;
}

const words = (code) => code.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/-/g, ' ').toLowerCase();
const CHANGE = { added: '+', removed: '-', changed: '~' };
const short = (value) => {
  const text = JSON.stringify(value);
  return text === undefined ? 'none' : text.length > 80 ? `${text.slice(0, 77)}...` : text;
};

function side(entry) {
  return entry.kind === 'live' ? `the tenant now (${entry.at})` : `snapshot ${entry.snapshotId} (${entry.at})`;
}

/** Plain text: totals first, then each service and type, then the raw keys. */
export function formatCompare(result) {
  const lines = [];
  const counts = differenceCount(result);
  lines.push(`compare ${result.mode}: ${counts.total} differences`);
  lines.push(`  from ${side(result.left)}${result.portable ? ` in ${result.left.tenantRef}` : ''}`);
  lines.push(`  to   ${side(result.right)}${result.portable ? ` in ${result.right.tenantRef}` : ''}`);
  if (result.portable) lines.push('  two tenants: matched by name; differences in ids alone are ignored');
  if (result.right.latestStored?.length) lines.push(`  ${result.right.latestStored.join(' and ')}: newest stored collection, not read live`);
  if (result.settings) {
    const { totals, groups, notCompared, unmatched } = result.settings;
    lines.push('', `settings: ${totals.added} added, ${totals.removed} removed, ${totals.changed} changed, ${totals.unchanged} unchanged`);
    for (const group of groups) {
      lines.push(`  ${group.service} / ${words(group.resourceType)}: ${group.added} added, ${group.removed} removed, ${group.changed} changed`);
      for (const item of group.items) {
        lines.push(`    ${CHANGE[item.changeType]} ${item.name ?? item.naturalKey}  [${item.naturalKey}]`);
        for (const field of item.fields ?? []) lines.push(`        ${field.path}: ${short(field.before)} -> ${short(field.after)}`);
        if ((item.fieldsTotal ?? 0) > (item.fields?.length ?? 0)) lines.push(`        and ${item.fieldsTotal - item.fields.length} more settings`);
      }
      if (group.total > group.items.length) lines.push(`    and ${group.total - group.items.length} more`);
    }
    for (const entry of notCompared) lines.push(`  not compared: ${words(entry.resourceType)} (read ${entry.left} / ${entry.right})`);
    for (const entry of unmatched) lines.push(`  not matchable across tenants: ${words(entry.resourceType)} (${entry.left} / ${entry.right}; keyed by a tenant id)`);
  }
  if (result.workloads) {
    const { totals, groups } = result.workloads;
    lines.push('', `workloads: ${totals.added} added, ${totals.removed} removed, ${totals.changed} changed, ${totals.notCompared} not compared`);
    for (const group of groups) {
      if (group.state !== 'compared') { lines.push(`  ${group.service} / ${group.workload}: not compared (${group.reason})`); continue; }
      lines.push(`  ${group.service} / ${group.workload}: ${group.added} added, ${group.removed} removed, ${group.changed} changed${group.unverified ? `, ${group.unverified} not verifiable` : ''}`);
      for (const item of group.items) {
        lines.push(`    ${CHANGE[item.changeType]} ${item.resourceKey}`);
        for (const field of item.fields ?? []) lines.push(`        ${field.path}: ${short(field.before)} -> ${short(field.after)}`);
      }
    }
  }
  if (result.content) {
    const content = result.content;
    if (content.by === 'item') {
      lines.push('', `content: ${content.totals.added} added, ${content.totals.removed} removed, ${content.totals.changed} changed`);
      for (const group of content.groups) {
        if (group.added + group.removed + group.changed === 0) continue;
        lines.push(`  ${group.service} / ${group.workload}: ${group.added} added, ${group.removed} removed, ${group.changed} changed`);
        for (const container of group.containers) {
          lines.push(`    ${container.container}: ${container.added} added, ${container.removed} removed, ${container.changed} changed`);
          for (const item of container.items) lines.push(`      ${CHANGE[item.changeType]} ${item.name ?? item.itemKey}`);
        }
      }
      if (content.total > content.shown) lines.push(`  listed ${content.shown} of ${content.total} items`);
    } else {
      lines.push('', `content held: ${content.totals.inBoth} in both, ${content.totals.onlyLeft} only in the first, ${content.totals.onlyRight} only in the second`);
      for (const group of content.groups) {
        lines.push(`  ${group.service} / ${group.workload}: ${group.leftItems} / ${group.rightItems} items, ${group.inBoth} in both`);
      }
    }
  }
  return lines.join('\n');
}

async function main() {
  const command = process.argv[2];
  if (!['snapshots', 'live', 'tenants', 'sources'].includes(command)) {
    console.log(USAGE);
    process.exitCode = command ? 1 : 0;
    return;
  }
  const principalId = required('principal-id');
  const sections = arg('only') ? arg('only').split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  const client = await connect(dbUrl());
  try {
    if (!(await can(client, await findPrincipalById(client, principalId), 'read'))) {
      console.error('refused: this principal does not hold the read capability');
      process.exitCode = 2;
      return;
    }
    let result;
    if (command === 'sources') {
      const sources = await listCompareSources(client);
      if (process.argv.includes('--json')) console.log(JSON.stringify(sources, null, 2));
      else for (const tenant of sources) {
        console.log(tenant.tenantRef);
        for (const snapshot of tenant.snapshots) console.log(`  ${snapshot.id}  ${snapshot.completedAt}  ${snapshot.resourceCount} objects`);
      }
      return;
    }
    if (command === 'snapshots') {
      result = await compareSnapshots(client, { leftSnapshotId: required('left'), rightSnapshotId: required('right'), sections });
    } else if (command === 'tenants') {
      result = await compareTenants(client, { leftTenantRef: required('left'), rightTenantRef: required('right'), sections });
    } else {
      // /etc/keel/tenant.json is the Collector registration. GraphReader has no write
      // method, so this path cannot issue a tenant mutation.
      const config = JSON.parse(readFileSync(arg('config', '/etc/keel/tenant.json'), 'utf8'));
      const tenantRef = tenantRefFor(config);
      const snapshotId = arg('snapshot') ?? await latestCompletedSnapshot(client, { tenantRef });
      if (!snapshotId) throw new CompareError('no-snapshot', `no completed snapshot for ${tenantRef}`);
      const { getToken } = await import('../tools/tenant-probe/auth.mjs');
      const { GraphReader } = await import('../tools/tenant-probe/graph.mjs');
      const { accessToken } = await getToken(config);
      const reader = new GraphReader(async () => accessToken);
      result = await compareWithLive(client, { snapshotId, tenantRef, reader, tenantId: config.tenantId, sections });
    }
    console.log(process.argv.includes('--json') ? JSON.stringify(result, null, 2) : formatCompare(result));
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof UsageError ? `${error.message}\n${USAGE}` : `compare failed: ${error.message}`);
    process.exitCode = error instanceof UsageError || error instanceof CompareError ? 1 : 3;
  });
}
