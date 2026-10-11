#!/usr/bin/env node
// /opt/keel/cli/keel-collect.mjs
//
// node keel-collect.mjs [--config /etc/keel/tenant.json] [--db-url $KEEL_DB_URL] [--tier tier1|tier2|tier3]
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { getToken } from '../tools/tenant-probe/auth.mjs';
import { GraphReader } from '../tools/tenant-probe/graph.mjs';
import { collectSnapshot } from '../engine/collect/snapshot.mjs';
import { connect } from '../engine/store/db.mjs';
import { tenantRefFor } from '../engine/store/tenantRef.mjs';

function arg(name, fallback, argv = process.argv) {
  const i = argv.indexOf(`--${name}`);
  return i > -1 ? argv[i + 1] : fallback;
}

/**
 * The relationship families every scheduled collection reads: each Intune
 * policy's assignments (issue #155) and each group's direct members and owners,
 * so a restore can put a group's membership back.
 */
export const COLLECT_RELATIONSHIPS = Object.freeze({ families: Object.freeze(['assignment', 'member', 'owner']) });

/**
 * One log line with how many policy assignment reads ended in each outcome
 * (counts only), so a missing read permission shows up instead of passing
 * silently. Null when nothing was read.
 */
export function describeAssignmentReads(summary) {
  if (!summary || Object.keys(summary).length === 0) return null;
  const count = (outcome) => summary[outcome] ?? 0;
  const parts = [
    `${count('complete') + count('complete-empty')} complete`,
    `${count('partial')} partial`,
    `${count('failed')} failed`,
    `${count('unsupported')} not supported`,
  ];
  const problems = count('partial') + count('failed');
  return `policy assignment reads: ${parts.join(', ')}${problems > 0
    ? ' — those policies\' assignments will not be restored; a failed read is often a missing Intune read permission'
    : ''}`;
}

/**
 * One log line with how many group member and owner reads ended in each outcome
 * (counts only). Null when no group was read.
 */
export function describeGroupMembershipReads(byFamily) {
  const families = ['member', 'owner'].filter((family) => byFamily?.[family]);
  if (families.length === 0) return null;
  const count = (outcome) => families.reduce((sum, family) => sum + (byFamily[family][outcome] ?? 0), 0);
  const problems = count('partial') + count('failed');
  return `group member and owner reads: ${count('complete') + count('complete-empty')} complete, ${count('partial')} partial, ${count('failed')} failed${problems > 0
    ? ' — those groups\' memberships will not be restored; a failed read is often a missing Group.Read.All or GroupMember.Read.All permission'
    : ''}`;
}

// A partial read fails completeness exactly like a failure; only
// complete / complete-empty / not-requested outcomes keep a zero exit.
export function exitCodeForDigest(coverageDigest) {
  return Object.values(coverageDigest).some((entry) => entry.outcome === 'failed' || entry.outcome === 'partial') ? 1 : 0;
}

export async function runCollect({
  config,
  dbUrl = process.env.KEEL_DB_URL,
  tier,
  dependencies = {},
  logger = console,
}) {
  const {
    connect: connectFn = connect,
    getToken: getTokenFn = getToken,
    GraphReader: GraphReaderClass = GraphReader,
    collectSnapshot: collectSnapshotFn = collectSnapshot,
  } = dependencies;
  if (!dbUrl) throw new Error('KEEL_DB_URL not set (source /etc/keel/db.env or pass --db-url)');

  const tenantRef = tenantRefFor(config.tenantId);
  const { accessToken } = await getTokenFn(config);
  const reader = new GraphReaderClass(async () => accessToken);
  const client = await connectFn(dbUrl);
  logger.log('collecting graph-native types…');
  try {
    // Issue #155: each Intune policy's assignments (which groups get it) are read
    // beside the policy, and each group's members and owners beside the group, so
    // a restore can put them back. A failed edge read is recorded as its own
    // observation and never changes a type's outcome.
    const { snapshotId, coverageDigest, relationshipsByFamily } = await collectSnapshotFn(client, {
      reader, tenantRef, tenantId: config.tenantId, tier, relationships: COLLECT_RELATIONSHIPS,
    });
    logger.log(`snapshot ${snapshotId} complete`);
    const assignmentLine = describeAssignmentReads(relationshipsByFamily?.assignment);
    if (assignmentLine) logger.log(assignmentLine);
    const membershipLine = describeGroupMembershipReads(relationshipsByFamily);
    if (membershipLine) logger.log(membershipLine);
    logger.table?.(coverageDigest);
    return { snapshotId, coverageDigest, exitCode: exitCodeForDigest(coverageDigest) };
  } finally {
    await client.end();
  }
}

export async function main({
  argv = process.argv,
  readFile = readFileSync,
  dependencies,
  logger = console,
} = {}) {
  if (argv.includes('--help')) {
    logger.log('usage: keel-collect.mjs [--config /etc/keel/tenant.json] [--db-url $KEEL_DB_URL] [--tier tier1|tier2|tier3]');
    return 0;
  }
  const tier = arg('tier', undefined, argv);
  if (tier && !['tier1', 'tier2', 'tier3'].includes(tier)) {
    throw new Error('--tier must be tier1, tier2, or tier3');
  }
  const config = JSON.parse(readFile(arg('config', '/etc/keel/tenant.json', argv), 'utf8'));
  const dbUrl = arg('db-url', process.env.KEEL_DB_URL, argv);
  const { exitCode } = await runCollect({ config, dbUrl, tier, dependencies, logger });
  return exitCode;
}

export async function runCli(options = {}) {
  try {
    return await main(options);
  } catch (err) {
    (options.logger ?? console).error(err);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().then((exitCode) => { process.exitCode = exitCode; });
}
