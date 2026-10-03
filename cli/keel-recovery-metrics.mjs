#!/usr/bin/env node
// /opt/keel/cli/keel-recovery-metrics.mjs
//
// Roadmap task-73: measured freshness, recoverable point and recovery time.
//
//   node keel-recovery-metrics.mjs report [--tenant-ref REF | --config /etc/keel/tenant.json] [--db-url $KEEL_DB_URL]
//       Prints the tenant's recovery metrics as JSON (engine/coverage/recoveryMetrics.mjs).
//
//   node keel-recovery-metrics.mjs record-offsite --recovery-manifest RECOVERY.json
//       --remote-sha256 HEX --shipped-at ISO --actor NAME
//       --build-revision REV --schema-pin HEX --config-export-dir DIR
//       [--dump DUMP.sql.gz] [--evidence-head SEQ:HASH:COUNT]
//       [--tenant-ref REF | --config /etc/keel/tenant.json] [--db-url $KEEL_DB_URL]
//       Verifies the recovery manifest against the actual artifact bytes and records
//       the off-site copy as evidence. A copy that fails verification is recorded as
//       not verified and the command exits 1; only a verified copy whose remote
//       checksum matches the dump can move the recoverable point.
//
// Read-side plus one evidence append: no Graph token, no tenant write.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { DESCRIPTORS } from '../engine/collect/descriptors.mjs';
import { loadRecoveryMetrics, recordOffsiteCopy } from '../engine/coverage/recoveryMetrics.mjs';
import { connect } from '../engine/store/db.mjs';

function arg(argv, name) {
  const i = argv.indexOf(`--${name}`);
  return i > -1 ? argv[i + 1] : undefined;
}

function resolveTenantRef(argv, readFile) {
  const explicit = arg(argv, 'tenant-ref');
  if (explicit) return explicit;
  const config = JSON.parse(readFile(arg(argv, 'config') ?? '/etc/keel/tenant.json', 'utf8'));
  return `sha256:${createHash('sha256').update(config.tenantId).digest('hex').slice(0, 16)}`;
}

function parseEvidenceHead(value) {
  if (!value) return undefined;
  const [headSeq, headHash, recordCount] = value.split(':');
  return { headSeq: Number(headSeq), headHash, recordCount: Number(recordCount) };
}

const USAGE = 'usage: keel-recovery-metrics.mjs report | record-offsite --recovery-manifest PATH --remote-sha256 HEX --shipped-at ISO --actor NAME --build-revision REV --schema-pin HEX --config-export-dir DIR [--dump PATH] [--evidence-head SEQ:HASH:COUNT] [--tenant-ref REF | --config PATH] [--db-url URL]';

export async function main({
  argv = process.argv.slice(2),
  readFile = readFileSync,
  connectFn = connect,
  logger = console,
  now = () => new Date(),
} = {}) {
  const [command] = argv;
  if (!['report', 'record-offsite'].includes(command) || argv.includes('--help')) {
    logger.log(USAGE);
    return command === undefined || argv.includes('--help') ? 0 : 2;
  }
  const dbUrl = arg(argv, 'db-url') ?? process.env.KEEL_DB_URL;
  if (!dbUrl) throw new Error('KEEL_DB_URL not set (source /etc/keel/db.env or pass --db-url)');
  const tenantRef = resolveTenantRef(argv, readFile);
  const client = await connectFn(dbUrl);
  try {
    if (command === 'report') {
      const metrics = await loadRecoveryMetrics(client, { tenantRef, requiredTypes: DESCRIPTORS.map((d) => d.type), now: now() });
      logger.log(JSON.stringify(metrics, null, 2));
      return 0;
    }
    const manifestPath = arg(argv, 'recovery-manifest');
    if (!manifestPath) throw new Error('--recovery-manifest is required');
    const { subject, verdict } = await recordOffsiteCopy(client, {
      tenantRef,
      manifest: JSON.parse(readFile(manifestPath, 'utf8')),
      remoteSha256: arg(argv, 'remote-sha256'),
      shippedAt: arg(argv, 'shipped-at'),
      actor: arg(argv, 'actor'),
      verifyOptions: {
        dumpPath: arg(argv, 'dump'),
        expectedBuild: { revision: arg(argv, 'build-revision'), schemaPin: arg(argv, 'schema-pin') },
        configExportDir: arg(argv, 'config-export-dir'),
        expectedCheckpoint: parseEvidenceHead(arg(argv, 'evidence-head')),
      },
    });
    for (const failure of subject.verification.failures) logger.error(`verify: ${failure}`);
    if (!verdict.counts) {
      logger.error(`off-site copy recorded as NOT verified (${verdict.reason})`);
      return 1;
    }
    logger.log(`off-site copy recorded as verified (${subject.observationIds.length} observations)`);
    return 0;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code), (error) => {
    console.error(error.message);
    process.exit(1);
  });
}
