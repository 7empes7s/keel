#!/usr/bin/env node
// tools/qualification/sentinel.mjs
//
// Roadmap task-80 (WS12): setup/qualification check for the Azure Monitor /
// Microsoft Sentinel export adapter.
//
//   node tools/qualification/sentinel.mjs check --config <file> [--tenant <ref>]
//
// READ-ONLY and OFFLINE: validates a Sentinel destination config (the same shape
// stored in siem_destination.config) against the adapter's named setup
// prerequisites and emits a qualification ledger record on stdout. It never
// provisions Azure resources, never calls a live endpoint and never touches the
// tenant — live Sentinel workspace ingestion qualification is the externally
// evidenced gate task-117, run by the orchestrating session, not here.
//
// Per Global Constraint 8 the record pins the official documentation URL, the
// retrieval date, the credential mode and the limits reference this
// implementation was built against.
//
// The emitted record follows the task-45 qualification contract shape (gate,
// tenantRef, build, operation, credentialMode, observedAt, evidenceLevel,
// synthetic, subject). It is always evidenceLevel 'fixture-tested' and
// synthetic:true — this harness can never mint a live-qualified claim.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  LOGS_INGESTION_DOC_SOURCE,
  SENTINEL_COLUMNS,
  SENTINEL_DESTINATION_KIND,
  SENTINEL_STREAM_NAME,
  SENTINEL_TABLE_NAME,
  sentinelSetupPrerequisites,
} from '../../engine/telemetry/adapters/sentinel.mjs';

export const SENTINEL_QUALIFICATION_GATE = 'sentinel-ingestion';

function currentBuild() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

/**
 * Check a destination config and return the qualification ledger record.
 * `ok` is true only when no setup prerequisites are pending; the record is
 * fixture-tested regardless — no live capability is claimed either way.
 */
export function checkSentinelConfig(config, {
  tenantRef = 'tenant:unscoped',
  now = new Date(),
  build = currentBuild(),
} = {}) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('config must be an object (the siem_destination.config shape)');
  }
  const pendingPrerequisites = sentinelSetupPrerequisites(config);
  return {
    contractVersion: 1,
    gate: SENTINEL_QUALIFICATION_GATE,
    tenantRef,
    build,
    operation: 'azure-monitor-logs-ingestion-delivery',
    credentialMode: LOGS_INGESTION_DOC_SOURCE.credentialMode,
    observedAt: now.toISOString(),
    evidenceLevel: 'fixture-tested',
    synthetic: true,
    docSource: LOGS_INGESTION_DOC_SOURCE,
    subject: {
      adapter: SENTINEL_DESTINATION_KIND,
      table: SENTINEL_TABLE_NAME,
      stream: SENTINEL_STREAM_NAME,
      schemaColumns: SENTINEL_COLUMNS.map((column) => column.name),
      deliverySemantics: 'at-least-once',
      dedupKey: ['TenantRef', 'DestinationId', 'KeelEventId'],
      dedupView: 'ops/sentinel-dedup.kql',
      pendingPrerequisites,
      ok: pendingPrerequisites.length === 0,
    },
  };
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

function main() {
  const command = process.argv[2];
  if (command !== 'check' || process.argv.includes('--help')) {
    console.error('usage: sentinel.mjs check --config <file> [--tenant <ref>]');
    process.exit(command === 'check' ? 0 : 2);
  }
  const configPath = arg('config');
  if (!configPath) {
    console.error('missing --config <file>');
    process.exit(2);
  }
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (error) {
    console.error(`config unreadable: ${error.message}`);
    process.exit(2);
  }
  const record = checkSentinelConfig(config, { tenantRef: arg('tenant') ?? 'tenant:unscoped' });
  console.log(JSON.stringify(record, null, 2));
  process.exit(record.subject.ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
