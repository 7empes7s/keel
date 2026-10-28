#!/usr/bin/env node
// /opt/keel/cli/keel-policy-scenario.mjs
//
// Roadmap task-95: bounded proposed-policy scenario evaluation.
//
//   node keel-policy-scenario.mjs evaluate --proposal FILE [--tenant-ref REF | --config /etc/keel/tenant.json]
//       [--max-scenarios N] [--max-steps N] [--what-if FILE] [--db-url $KEEL_DB_URL]
//
// FILE is JSON: { "changes": [{ "verb": "create|update|delete", "naturalKey": "...",
// "payload": { ...conditionalAccessPolicy } }], "principals": [{ "id": OBJECT_ID,
// "label": NAME, "capabilities": { "mfa": true, "compliantDevice": false, ... },
// "paths": { "platforms": [...], ... } }] }.
//
// The proposal is laid over the newest covered Conditional Access collection and the
// combined set is evaluated for the registered emergency accounts and the principals
// the file names. --what-if attaches a captured What If read ({ principalId, readAt,
// response }) as separate live-policy evidence; it never changes a verdict.
//
// Prints the evaluation and its gate outcome as JSON. Exits 0 only for a sampled pass,
// 1 for lockout or unknown, 2 for usage. Read-only: no Graph token, no tenant write.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readConfigFile } from '../engine/config/configFile.mjs';
import { pathToFileURL } from 'node:url';

import { attachLiveReads, evaluateProposalForTenant, readLiveWhatIf } from '../engine/safety/policyScenario.mjs';
import { proposedPolicyGate } from '../engine/safety/simulationGate.mjs';
import { connect } from '../engine/store/db.mjs';
import { parseCliArgs } from './args.mjs';

const USAGE = 'usage: keel-policy-scenario.mjs evaluate --proposal FILE [--tenant-ref REF | --config PATH] [--max-scenarios N] [--max-steps N] [--what-if FILE] [--db-url URL]';

const ARGS = {
  name: 'keel-policy-scenario',
  strings: ['proposal', 'max-scenarios', 'max-steps', 'what-if', 'tenant-ref', 'config', 'db-url'],
  booleans: ['help'],
  positionals: 1,
};

function arg(opts, name) {
  return opts[name];
}

function integer(opts, name) {
  const value = arg(opts, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`--${name} must be an integer`);
  return parsed;
}

function resolveTenantRef(opts, readFile) {
  const explicit = arg(opts, 'tenant-ref');
  if (explicit) return explicit;
  const config = readConfigFile(arg(opts, 'config') ?? '/etc/keel/tenant.json', { readFile, what: 'collector settings' });
  return `sha256:${createHash('sha256').update(config.tenantId).digest('hex').slice(0, 16)}`;
}

export async function main({
  argv = process.argv.slice(2),
  readFile = readFileSync,
  connectFn = connect,
  logger = console,
  now = () => new Date(),
} = {}) {
  const { values: opts, positionals: [command] } = parseCliArgs(argv, ARGS);
  if (command !== 'evaluate' || opts.help) {
    logger.log(USAGE);
    return command === undefined || opts.help ? 0 : 2;
  }
  const proposalPath = arg(opts, 'proposal');
  if (!proposalPath) { logger.log(USAGE); return 2; }
  const proposal = JSON.parse(readFile(proposalPath, 'utf8'));
  const budget = {};
  if (arg(opts, 'max-scenarios') !== undefined) budget.maxScenarios = integer(opts, 'max-scenarios');
  if (arg(opts, 'max-steps') !== undefined) budget.maxSteps = integer(opts, 'max-steps');
  const whatIfPath = arg(opts, 'what-if');
  const whatIf = whatIfPath ? JSON.parse(readFile(whatIfPath, 'utf8')) : null;

  const dbUrl = arg(opts, 'db-url') ?? process.env.KEEL_DB_URL;
  if (!dbUrl) throw new Error('KEEL_DB_URL not set (source /etc/keel/db.env or pass --db-url)');
  const tenantRef = resolveTenantRef(opts, readFile);
  const client = await connectFn(dbUrl);
  try {
    let evaluation = await evaluateProposalForTenant(client, { tenantRef, proposal, budget, now: now() });
    if (whatIf) {
      evaluation = attachLiveReads(evaluation, [readLiveWhatIf(whatIf.response, {
        principalId: whatIf.principalId, scenario: whatIf.scenario ?? null, readAt: whatIf.readAt, source: whatIf.source ?? 'fixture',
      })]);
    }
    const gate = proposedPolicyGate(evaluation);
    logger.log(JSON.stringify({ gate, evaluation }, null, 2));
    return gate.outcome === 'sampled-pass' ? 0 : 1;
  } finally {
    await client.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
