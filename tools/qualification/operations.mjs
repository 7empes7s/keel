#!/usr/bin/env node
/**
 * Roadmap task-63: the operation qualification ledger, on the command line,
 * plus a fixture harness for the operations that are registered today.
 *
 *   node tools/qualification/operations.mjs            # table: every catalogue type and its decision
 *   node tools/qualification/operations.mjs --json     # the full per-operation ledger
 *   node tools/qualification/operations.mjs --harness  # also run the fixture harness
 *   node tools/qualification/operations.mjs --check    # exit 1 if any catalogue type lacks a decision
 *
 * The harness drives the PRODUCTION applyWave() path, once for each registered
 * group, named location, role assignment and conditional access operation,
 * against an in-memory fake Graph. Its results are reported beside the ledger
 * and never change it: a passing fake cannot register, promote or qualify
 * anything (capabilities.mjs owns claims). No network, no tenant.
 */
import { pathToFileURL } from 'node:url';

import { CATALOG } from '../tenant-probe/catalog.mjs';
import { OPERATIONS, capabilityFor, graphPathFor, isSupportedClaim } from '../../engine/coverage/capabilities.mjs';
import { buildOperationLedger } from '../../engine/coverage/qualification.mjs';
import { applyWave } from '../../engine/restore/applyEngine.mjs';

const FIXTURE_PAYLOADS = Object.freeze({
  group: { displayName: 'Fixture group', mailNickname: 'fixture-group', mailEnabled: false, securityEnabled: true, groupTypes: [] },
  roleAssignment: { principalId: 'fixture-principal', roleDefinitionId: 'fixture-role', directoryScopeId: '/' },
  namedLocation: {
    '@odata.type': '#microsoft.graph.ipNamedLocation', displayName: 'Fixture location', isTrusted: false,
    ipRanges: [{ '@odata.type': '#microsoft.graph.iPv4CidrRange', cidrAddress: '203.0.113.0/24' }],
  },
  conditionalAccessPolicy: {
    displayName: 'Fixture policy', state: 'enabledForReportingButNotEnforced',
    conditions: { users: { includeUsers: ['None'] }, applications: { includeApplications: ['None'] } },
    grantControls: { operator: 'OR', builtInControls: ['block'] },
  },
});

/** An in-memory Graph that honours create/PATCH/DELETE/soft-restore and read-back. */
export function fakeGraph() {
  const objects = new Map();
  const deleted = new Map();
  const writes = [];
  let next = 0;
  return {
    objects,
    deleted,
    writes,
    async write(version, path, { method, body }) {
      writes.push({ method, path });
      const restore = /^\/directory\/deletedItems\/([^/]+)\/restore$/.exec(path);
      if (restore && method === 'POST') {
        const entry = deleted.get(restore[1]);
        if (!entry) return { ok: false, status: 404, body: { error: { code: 'Request_ResourceNotFound' } } };
        deleted.delete(restore[1]);
        objects.set(entry.path, entry.body);
        return { ok: true, status: 200, body: entry.body };
      }
      if (method === 'POST') {
        next += 1;
        const id = `fixture-${next}`;
        const created = { ...body, id };
        objects.set(`${path}/${id}`, created);
        return { ok: true, status: 201, body: created };
      }
      if (!objects.has(path)) return { ok: false, status: 404, body: { error: { code: 'Request_ResourceNotFound' } } };
      if (method === 'PATCH') {
        objects.set(path, { ...objects.get(path), ...body });
        return { ok: true, status: 204, body: null };
      }
      if (method === 'DELETE') {
        objects.delete(path);
        return { ok: true, status: 204, body: null };
      }
      return { ok: false, status: 405, body: null };
    },
    async read(version, path) {
      return objects.has(path) ? { ok: true, status: 200, body: objects.get(path) } : { ok: false, status: 404, body: null };
    },
  };
}

const governor = { async acquire() {}, observeRetryAfter() {} };

function fixtureFor(resourceType, operation, graph) {
  const collection = graphPathFor(resourceType);
  const payload = FIXTURE_PAYLOADS[resourceType];
  const blastRadius = CATALOG.find((entry) => entry.type === resourceType)?.blastRadius ?? null;
  const base = { naturalKey: `${resourceType}:fixture`, resourceType, references: [], blastRadius };
  const existingId = 'fixture-existing';
  if (operation === 'create') return { ...base, verb: 'create', payload };
  if (operation === 'update') {
    // Drift a field the type actually has; a role assignment has no mutable name.
    const drifted = 'displayName' in payload ? { displayName: 'Drifted' } : {};
    graph.objects.set(`${collection}/${existingId}`, { ...payload, id: existingId, ...drifted });
    return { ...base, verb: 'update', payload, targetId: existingId };
  }
  if (operation === 'delete') {
    graph.objects.set(`${collection}/${existingId}`, { ...payload, id: existingId });
    return { ...base, verb: 'delete', payload: null, targetId: existingId, live: { targetId: existingId, payload: { ...payload, id: existingId } } };
  }
  if (operation === 'restore-soft-deleted') {
    graph.deleted.set(existingId, { path: `${collection}/${existingId}`, body: { ...payload, id: existingId } });
    return { ...base, verb: 'restore-soft-deleted', payload, targetId: existingId, deletedItemId: existingId };
  }
  return null;
}

/**
 * Runs every registered object operation through applyWave against fakeGraph.
 * Returns one result per (resourceType, operation). It never touches the
 * registry: the claims read before and after a run are identical.
 */
export async function runFixtureHarness({ types = Object.keys(FIXTURE_PAYLOADS) } = {}) {
  const results = [];
  for (const resourceType of types) {
    for (const operation of OPERATIONS) {
      if (!isSupportedClaim(capabilityFor(resourceType, operation).claim)) continue;
      const graph = fakeGraph();
      const resource = fixtureFor(resourceType, operation, graph);
      try {
        const outcome = await applyWave(graph, governor, [resource], {
          targetTenant: 'fixture-tenant', mode: 'enforce', simulationPassed: true,
          // The deletion guard verifies a policy against the CURRENT target state;
          // the fixture's live object is that state (it excludes no break-glass id).
          deletionGuardOptions: {
            breakGlassUserIds: ['fixture-break-glass'], breakGlassGroupIds: [], keelAppIds: [],
            caPolicies: resource.live ? [{ naturalKey: resource.naturalKey, payload: resource.live.payload }] : [],
          },
        });
        const passed = outcome.applied.length === 1 && outcome.failed.length === 0 && outcome.skipped.length === 0;
        results.push({
          resourceType, operation, result: passed ? 'passed' : 'failed', synthetic: true,
          detail: passed ? null : JSON.stringify({ failed: outcome.failed, skipped: outcome.skipped }),
        });
      } catch (error) {
        results.push({ resourceType, operation, result: 'failed', synthetic: true, detail: error.message });
      }
    }
  }
  return results;
}

function table(ledger) {
  const lines = ['type                                   decision   operations'];
  for (const row of ledger.types) {
    const ops = row.operations.map((op) => `${op.operation}=${op.decision}`).join(' ');
    lines.push(`${row.resourceType.padEnd(38)} ${row.decision.padEnd(10)} ${ops}`);
  }
  for (const edge of ledger.edges) lines.push(`${edge.resourceType.padEnd(38)} ${'automated'.padEnd(10)} ${edge.operation}=${edge.decision}`);
  return lines.join('\n');
}

export async function main({ argv = process.argv.slice(2), out = console } = {}) {
  let ledger;
  try {
    ledger = buildOperationLedger();
  } catch (error) {
    out.error(error.message);
    return 1;
  }
  if (argv.includes('--check')) {
    out.log(`${ledger.types.length} catalogue types, each with an explicit decision`);
    return 0;
  }
  const harness = argv.includes('--harness') ? await runFixtureHarness() : null;
  if (argv.includes('--json')) {
    out.log(JSON.stringify({ ...ledger, ...(harness ? { fixtureHarness: harness } : {}) }, null, 2));
  } else {
    out.log(table(ledger));
    if (harness) {
      out.log('\nfixture harness (synthetic; never changes a claim):');
      for (const result of harness) out.log(`  ${result.resourceType} ${result.operation}: ${result.result}${result.detail ? ` — ${result.detail}` : ''}`);
    }
  }
  return harness?.some((result) => result.result !== 'passed') ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; });
}
