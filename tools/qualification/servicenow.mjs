#!/usr/bin/env node
// tools/qualification/servicenow.mjs
//
// Roadmap task-97 (WS8): setup check for the ServiceNow approval mirror adapter.
//
//   node tools/qualification/servicenow.mjs check --config <file> [--tenant <ref>]
//
// READ-ONLY and OFFLINE: validates a ServiceNow adapter config (the shape stored in
// itsm_adapter_config.config) and prints a qualification ledger record on stdout. It
// never contacts an instance, never resolves a credential reference and never writes to
// the database. Live qualification against a real instance, mapped test users and an
// instance-side workflow is the externally evidenced gate task-118, not this tool.
//
// The record follows the task-45 qualification contract shape (gate, tenantRef, build,
// operation, credentialMode, observedAt, evidenceLevel, synthetic, subject). It is always
// evidenceLevel 'fixture-tested' and synthetic: true, so it can never mint a live claim.
// Exit code: 0 when every mapping is present, 1 when any is missing, 2 on usage errors.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  SERVICENOW_ADAPTER_NAME, SERVICENOW_DOC_SOURCE, SERVICENOW_FIELD_ROLES, SERVICENOW_SIGNATURE_HEADER, serviceNowConfigProblems,
} from '../../engine/itsm/adapters/servicenow.mjs';

export const SERVICENOW_QUALIFICATION_GATE = 'servicenow-approval-mirror';

function currentBuild() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

/** Checks a config and returns the ledger record. `subject.ok` is true only when no
 * mapping is missing; the record is fixture-tested either way. */
export function checkServiceNowConfig(config, { tenantRef = 'tenant:unscoped', now = new Date(), build = currentBuild() } = {}) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('config must be an object (the itsm_adapter_config.config shape)');
  }
  const problems = serviceNowConfigProblems(config);
  const fields = config.fields && typeof config.fields === 'object' ? config.fields : {};
  return {
    contractVersion: 1,
    gate: SERVICENOW_QUALIFICATION_GATE,
    tenantRef,
    build,
    operation: 'servicenow-table-api-approval-mirror',
    credentialMode: SERVICENOW_DOC_SOURCE.credentialMode,
    observedAt: now.toISOString(),
    evidenceLevel: 'fixture-tested',
    synthetic: true,
    docSource: SERVICENOW_DOC_SOURCE,
    subject: {
      adapter: SERVICENOW_ADAPTER_NAME,
      table: typeof config.table === 'string' ? config.table : null,
      fieldMapping: Object.fromEntries(Object.keys(SERVICENOW_FIELD_ROLES).map((role) => [role, typeof fields[role] === 'string' ? fields[role] : null])),
      stateMapping: {
        approved: Array.isArray(config.states?.approved) ? config.states.approved : [],
        rejected: Array.isArray(config.states?.rejected) ? config.states.rejected : [],
      },
      credentialRef: config.credential?.tokenRef ?? null,
      inbound: config.callback ? { mode: 'signed-callback-and-polling', signatureHeader: SERVICENOW_SIGNATURE_HEADER, secretRef: config.callback.secretRef ?? null } : { mode: 'polling-only' },
      deliverySemantics: 'at-least-once',
      problems,
      ok: problems.length === 0,
      liveQualified: false,
      liveGate: 'task-118',
    },
  };
}

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 ? process.argv[index + 1] : undefined;
}

function main() {
  const command = process.argv[2];
  if (command !== 'check' || process.argv.includes('--help')) {
    console.error('usage: servicenow.mjs check --config <file> [--tenant <ref>]');
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
  const record = checkServiceNowConfig(config, { tenantRef: arg('tenant') ?? 'tenant:unscoped' });
  console.log(JSON.stringify(record, null, 2));
  process.exit(record.subject.ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
