// Roadmap task-111: deferred hybrid topology contract and cloud refusal rules.
//
// Acceptance:
//  - cross-tenant or unsupported topology intent rejects;
//  - replayed command identity cannot qualify a new action;
//  - synced-object cloud refusal remains (restore selection, applyWave, delete guard);
//  - the artifact inventory contains no on-prem runtime entrypoint.
// Mutation checks:
//  - accept a foreign tenant in a topology message;
//  - allow a cloud write to a synced object;
//  - declare the unimplemented hybrid runtime available.
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  HYBRID_RUNTIME, HYBRID_TOPOLOGY_CONTRACT_VERSION, HybridRuntimeDeferredError, createCommandLedger,
  dispatchHybridCommand, hybridRuntimeInventory, intentDigest, runtimeDeclarationProblems, validateTopologyMessage,
} from '../contracts/topology.mjs';
import { refuseIfSynced, sourceAuthorityOf } from '../safety/syncedObjectGuard.mjs';
import { refuseUnsafeDeletion } from '../safety/deletionGuard.mjs';
import { selectionGuardRefusals } from '../restore/selection.mjs';
import { applyWave } from '../restore/applyEngine.mjs';
import { ThrottleGovernor } from '../restore/throttleGovernor.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TENANT = 'sha256:task-111-tenant';
const FOREIGN = 'sha256:task-111-foreign';
const NOW = new Date('2026-10-03T22:00:00.000Z');
const ADAPTER = Object.freeze({ adapterId: 'ad-agent-01', adapterKind: 'active-directory', credentialRef: 'keyvault:ad-agent-01' });

let counter = 0;
const nextId = (prefix) => `${prefix}-${(counter += 1)}`;

function poll(overrides = {}) {
  return {
    schemaVersion: HYBRID_TOPOLOGY_CONTRACT_VERSION, kind: 'poll', messageId: nextId('msg'), tenantRef: TENANT,
    adapter: { ...ADAPTER }, sentAt: '2026-10-03T21:59:00.000Z',
    capabilityEvidence: [{ tenantRef: TENANT, resourceType: 'user', operation: 'update', claim: 'declared', proofRef: 'adapter-self-report' }],
    ...overrides,
  };
}

const userIntent = (overrides = {}) => ({
  intentId: 'intent-1', resourceType: 'user', naturalKey: 'user:alice@contoso.example', operation: 'update',
  sourceAuthority: 'on-premises', executionSite: 'on-premises', observed: { onPremisesSyncEnabled: true }, ...overrides,
});

function command(overrides = {}) {
  return {
    schemaVersion: HYBRID_TOPOLOGY_CONTRACT_VERSION, kind: 'command', messageId: nextId('msg'), tenantRef: TENANT,
    adapter: { ...ADAPTER }, sentAt: '2026-10-03T21:59:30.000Z', commandId: nextId('cmd'),
    issuedAt: '2026-10-03T21:59:30.000Z', expiresAt: '2026-10-03T22:09:30.000Z', intents: [userIntent()],
    ...overrides,
  };
}

function resultFor(cmd, intent = cmd.intents[0], overrides = {}) {
  return {
    schemaVersion: HYBRID_TOPOLOGY_CONTRACT_VERSION, kind: 'result', messageId: nextId('msg'), tenantRef: TENANT,
    adapter: { ...ADAPTER }, sentAt: '2026-10-03T21:59:50.000Z', commandId: cmd.commandId, intentId: intent.intentId,
    outcome: 'succeeded',
    provenance: {
      intentDigest: intentDigest({ tenantRef: TENANT, adapterId: ADAPTER.adapterId, commandId: cmd.commandId, intent }),
      observedAt: '2026-10-03T21:59:45.000Z', adapterBuild: 'agent-0.0.0-contract-fixture', synthetic: false,
    },
    ...overrides,
  };
}

const check = (message, ledger = createCommandLedger()) => validateTopologyMessage(message, { tenantRef: TENANT, ledger, now: NOW });

test('a well-formed poll, command and result validate, and the command is never dispatchable', () => {
  const ledger = createCommandLedger();
  assert.deepEqual(check(poll(), ledger).failures, []);
  const cmd = command();
  const issued = check(cmd, ledger);
  assert.equal(issued.ok, true, issued.failures.join('; '));
  assert.equal(issued.dispatchable, false, 'the hybrid runtime is deferred, so nothing is dispatchable');
  assert.equal(issued.refusal, 'hybrid-runtime-deferred');
  assert.equal(issued.runtime, 'deferred');
  const result = check(resultFor(cmd), ledger);
  assert.equal(result.ok, true, result.failures.join('; '));
  assert.deepEqual({ ...result.qualifies }, { commandId: cmd.commandId, intentId: 'intent-1', outcome: 'succeeded' });
  assert.throws(() => dispatchHybridCommand(cmd), HybridRuntimeDeferredError);
});

test('the runtime is declared deferred and no entrypoint ships', () => {
  assert.equal(HYBRID_RUNTIME.status, 'deferred');
  assert.equal(HYBRID_RUNTIME.available, false);
  const inventory = hybridRuntimeInventory({ root: REPO, fs, path });
  assert.deepEqual(inventory, [], 'the artifact inventory must contain no on-premises runtime entrypoint');
  assert.deepEqual(runtimeDeclarationProblems(inventory), []);
  // The declaration is consistent only while it says deferred: claiming the
  // runtime is available with no entrypoint is itself a declaration problem.
  assert.match(runtimeDeclarationProblems(inventory, { ...HYBRID_RUNTIME, available: true }).join(), /names no entrypoint/);
  assert.match(
    runtimeDeclarationProblems(inventory, { ...HYBRID_RUNTIME, available: true, entrypoints: ['cli/keel-hybrid-agent.mjs'] }).join(),
    /does not exist in the artifact inventory/,
  );
});

test('the inventory finds a runtime entrypoint by name, by contract import, by systemd unit and by package bin', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'keel-task-111-'));
  try {
    mkdirSync(path.join(root, 'cli'));
    mkdirSync(path.join(root, 'ops'));
    mkdirSync(path.join(root, 'tools'));
    writeFileSync(path.join(root, 'cli/keel-collect.mjs'), "import '../engine/collect/collector.mjs';\n");
    writeFileSync(path.join(root, 'cli/keel-collect.test.mjs'), "import '../engine/contracts/topology.mjs';\n");
    assert.deepEqual(hybridRuntimeInventory({ root, fs, path }), [], 'ordinary CLIs and test files are not runtime entrypoints');

    writeFileSync(path.join(root, 'cli/keel-sync.mjs'), "import { validateTopologyMessage } from '../engine/contracts/topology.mjs';\n");
    writeFileSync(path.join(root, 'cli/keel-ad-agent.mjs'), 'console.log(1);\n');
    writeFileSync(path.join(root, 'tools/relay.mjs'), "import '../engine/contracts/topology.mjs';\n");
    writeFileSync(path.join(root, 'ops/keel-relay.service'), '[Service]\nExecStart=/usr/bin/node /opt/keel/tools/relay.mjs --loop\n');
    writeFileSync(path.join(root, 'ops/keel-onprem.timer'), '[Timer]\nOnCalendar=*:0/5\n');
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ bin: { poller: 'tools/poller.mjs' } }));
    writeFileSync(path.join(root, 'tools/poller.mjs'), 'console.log(1);\n');
    const found = hybridRuntimeInventory({ root, fs, path });
    assert.deepEqual(found.map((entry) => entry.entrypoint), [
      'cli/keel-ad-agent.mjs', 'cli/keel-sync.mjs', 'ops/keel-onprem.timer', 'tools/poller.mjs', 'tools/relay.mjs',
    ]);
    assert.equal(runtimeDeclarationProblems(found).length, 5, 'every found entrypoint contradicts the deferred declaration');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a foreign tenant is refused on the envelope, in capability evidence and on results', () => {
  const foreignPoll = check(poll({ tenantRef: FOREIGN }));
  assert.equal(foreignPoll.ok, false);
  assert.match(foreignPoll.failures.join(), /cross-tenant message refused/);

  const foreignEvidence = check(poll({ capabilityEvidence: [{ tenantRef: FOREIGN, resourceType: 'user', operation: 'update', claim: 'declared' }] }));
  assert.equal(foreignEvidence.ok, false);
  assert.match(foreignEvidence.failures.join(), /cross-tenant evidence refused/);

  const ledger = createCommandLedger();
  const foreignCommand = check(command({ tenantRef: FOREIGN }), ledger);
  assert.equal(foreignCommand.ok, false);
  assert.equal(ledger.commands.size, 0, 'a refused command is never recorded');

  const cmd = command();
  assert.equal(check(cmd, ledger).ok, true);
  const foreignResult = check(resultFor(cmd, cmd.intents[0], { tenantRef: FOREIGN }), ledger);
  assert.equal(foreignResult.ok, false);
  assert.equal(foreignResult.qualifies, undefined);

  // No pinned tenant means nothing validates, not "any tenant".
  const unpinned = validateTopologyMessage(poll(), { now: NOW });
  assert.equal(unpinned.ok, false);
});

test('unsupported topology intents are refused', () => {
  const cases = [
    ['cloud write to an on-premises object', { executionSite: 'cloud' }, /cloud-side|unsupported topology/],
    ['cloud write to a hybrid object', { sourceAuthority: 'hybrid', executionSite: 'cloud', observed: {} }, /source of authority is hybrid/],
    ['an observed synced object declared cloud', { sourceAuthority: 'cloud' }, /synced from on-premises/],
    ['a cloud object sent to the agent', { sourceAuthority: 'cloud', observed: {} }, /unsupported topology intent/],
    ['a delete', { operation: 'delete' }, /unsupported topology intent user\/delete/],
    ['an uncatalogued type', { resourceType: 'conditionalAccessPolicy' }, /unsupported topology intent/],
    ['an unknown authority', { sourceAuthority: 'directory' }, /unknown source authority/],
    ['an unknown execution site', { executionSite: 'edge' }, /unknown execution site/],
  ];
  for (const [name, overrides, pattern] of cases) {
    const verdict = check(command({ intents: [userIntent(overrides)] }));
    assert.equal(verdict.ok, false, name);
    assert.match(verdict.failures.join(' | '), pattern, name);
  }
  const unknownAdapter = check(command({ adapter: { ...ADAPTER, adapterKind: 'exchange-hybrid' } }));
  assert.equal(unknownAdapter.ok, false);
  assert.match(unknownAdapter.failures.join(), /unsupported adapter kind/);
  // One bad intent refuses the whole command; it is never partially recorded.
  const ledger = createCommandLedger();
  const mixed = check(command({ intents: [userIntent(), userIntent({ intentId: 'intent-2', operation: 'delete' })] }), ledger);
  assert.equal(mixed.ok, false);
  assert.equal(ledger.commands.size, 0);
});

test('legacy, malformed and credential-bearing messages are refused', () => {
  assert.match(check(poll({ schemaVersion: undefined })).failures.join(), /unknown schemaVersion/);
  assert.match(check(poll({ schemaVersion: 2 })).failures.join(), /unknown schemaVersion/);
  assert.match(check(poll({ kind: 'execute' })).failures.join(), /unknown message kind/);
  assert.equal(check(null).ok, false);
  assert.match(check(poll({ adapter: { ...ADAPTER, clientSecret: 'x' } })).failures.join(), /never carries credentials/);
  assert.match(check(poll({ adapter: { ...ADAPTER, credentialRef: 'password=hunter2' } })).failures.join(), /credential-shaped/);
  assert.match(check(poll({ adapter: { adapterId: 'a', adapterKind: 'active-directory' } })).failures.join(), /credentialRef is required/);
  const tooLong = check(command({ expiresAt: '2026-10-03T23:59:30.000Z' }));
  assert.match(tooLong.failures.join(), /at most 15 minutes/);
});

test('adapter capability evidence cannot read above declared while the runtime is deferred', () => {
  for (const claim of ['fixture-tested', 'live-qualified']) {
    const verdict = check(poll({ capabilityEvidence: [{ tenantRef: TENANT, resourceType: 'user', operation: 'update', claim, synthetic: false }] }));
    assert.equal(verdict.ok, false, claim);
    assert.match(verdict.failures.join(), /runtime is deferred/);
  }
  assert.match(check(poll({ capabilityEvidence: [{ tenantRef: TENANT, resourceType: 'user', operation: 'update', claim: 'proven' }] })).failures.join(), /unknown claim/);
});

test('a replayed command identity cannot qualify a new action', () => {
  const ledger = createCommandLedger();
  const cmd = command();
  assert.equal(check(cmd, ledger).ok, true);

  // Same message again, and the same commandId under a fresh messageId.
  assert.match(check(cmd, ledger).failures.join(), /replayed messageId/);
  const reissued = check({ ...cmd, messageId: nextId('msg'), intents: [userIntent({ naturalKey: 'user:bob@contoso.example' })] }, ledger);
  assert.equal(reissued.ok, false);
  assert.match(reissued.failures.join(), /replayed command identity/);
  assert.equal(ledger.commands.get(cmd.commandId).intents[0].naturalKey, 'user:alice@contoso.example', 'the first command is not overwritten');

  // The genuine result qualifies its intent once.
  const genuine = resultFor(cmd);
  assert.equal(check(genuine, ledger).ok, true);
  const again = check({ ...genuine, messageId: nextId('msg') }, ledger);
  assert.equal(again.ok, false);
  assert.match(again.failures.join(), /already has a result/);

  // A new action for another object: the old result, re-pointed at it, does not bind.
  const next = command({ intents: [userIntent({ naturalKey: 'user:bob@contoso.example' })] });
  assert.equal(check(next, ledger).ok, true);
  const repointed = check({ ...genuine, messageId: nextId('msg'), commandId: next.commandId }, ledger);
  assert.equal(repointed.ok, false);
  assert.match(repointed.failures.join(), /digest does not bind/);
  assert.equal(repointed.qualifies, undefined);

  // A result for a command this ledger never issued, or an intent the command does not carry.
  assert.match(check(resultFor(command()), ledger).failures.join(), /never issued/);
  assert.match(check(resultFor(next, userIntent({ intentId: 'intent-9' })), ledger).failures.join(), /does not carry/);
});

test('result provenance must be non-synthetic, inside the command window and from the same adapter', () => {
  const ledger = createCommandLedger();
  const cmd = command();
  check(cmd, ledger);
  const base = resultFor(cmd);
  const cases = [
    [{ provenance: { ...base.provenance, synthetic: true } }, /synthetic result/],
    [{ provenance: { ...base.provenance, observedAt: '2026-10-03T21:00:00.000Z' } }, /before its command was issued/],
    [{ provenance: { ...base.provenance, observedAt: '2026-10-03T22:30:00.000Z' } }, /after its command expired/],
    [{ provenance: { ...base.provenance, adapterBuild: '' } }, /adapterBuild/],
    [{ adapter: { ...ADAPTER, adapterId: 'ad-agent-02' } }, /adapter differs/],
    [{ outcome: 'verified' }, /unknown outcome/],
  ];
  for (const [overrides, pattern] of cases) {
    const verdict = check({ ...base, messageId: nextId('msg'), ...overrides }, ledger);
    assert.equal(verdict.ok, false, String(pattern));
    assert.match(verdict.failures.join(), pattern);
  }
  assert.equal(check(base, ledger).ok, true, 'refused attempts do not consume the intent');
});

test('synced and hybrid objects stay refused on every cloud write path', async () => {
  const synced = { naturalKey: 'group:Synced', resourceType: 'group', payload: { displayName: 'Synced', onPremisesSyncEnabled: true } };
  const hybrid = { naturalKey: 'group:Hybrid', resourceType: 'group', sourceAuthority: 'hybrid', payload: { displayName: 'Hybrid' } };
  const downgrade = { ...synced, naturalKey: 'group:Downgrade', sourceAuthority: 'cloud' };
  const garbled = { naturalKey: 'group:Garbled', resourceType: 'group', sourceAuthority: 'AD', payload: { displayName: 'Garbled' } };
  const cloud = { naturalKey: 'group:Cloud', resourceType: 'group', payload: { displayName: 'Cloud', mailNickname: 'Cloud' } };

  assert.equal(sourceAuthorityOf(downgrade), 'on-premises', 'a hint never downgrades a synced object');
  assert.equal(sourceAuthorityOf(garbled), 'unknown');
  assert.equal(sourceAuthorityOf({ payload: { sourceAuthority: 'on-premises' } }), 'cloud', 'Graph payload fields are not authority claims');
  for (const resource of [synced, hybrid, downgrade, garbled]) assert.equal(refuseIfSynced(resource).refused, true, resource.naturalKey);
  assert.equal(refuseIfSynced(cloud).refused, false);
  assert.equal(refuseIfSynced({ payload: {} }).refused, false, 'types without the field keep their behavior');

  assert.deepEqual(
    selectionGuardRefusals([cloud, synced, hybrid, downgrade, garbled]).map((entry) => entry.naturalKey),
    ['group:Downgrade', 'group:Garbled', 'group:Hybrid', 'group:Synced'],
  );
  const deletion = refuseUnsafeDeletion({ ...hybrid, verb: 'delete' }, { breakGlassUserIds: ['break-glass-id'], breakGlassGroupIds: [], keelAppIds: [], caPolicies: [] });
  assert.equal(deletion.refused, true);
  assert.match(deletion.reason, /hybrid/);

  // The production applyWave never calls the writer for them.
  const calls = [];
  const writer = {
    write: async (version, graphPath, options) => { calls.push({ graphPath, body: options.body }); return { ok: true, status: 201, body: { id: 'new-id' } }; },
    read: async () => ({ ok: true, status: 200, body: calls.at(-1)?.body ?? {} }),
  };
  const governor = new ThrottleGovernor({ 'target/entra/write': { capacity: 100, refillPerSecond: 100 } });
  const result = await applyWave(writer, governor, [synced, hybrid, downgrade, garbled, cloud], { targetTenant: 'target', mode: 'enforce' });
  assert.deepEqual(result.skipped.map((entry) => entry.naturalKey).sort(), ['group:Downgrade', 'group:Garbled', 'group:Hybrid', 'group:Synced']);
  assert.deepEqual(result.applied.map((entry) => entry.naturalKey), ['group:Cloud']);
  assert.equal(calls.filter((call) => call.body?.displayName !== 'Cloud').length, 0, 'no write reached Graph for a refused object');
});
