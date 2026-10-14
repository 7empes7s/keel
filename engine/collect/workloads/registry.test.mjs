import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { WORKLOADS } from '../workloadContract.mjs';
import { WORKLOAD_COLLECTORS } from './registry.mjs';
import { workloadSteps } from '../../../cli/keel-workload-collect.mjs';

test('the registry holds each contract workload once, with a collector and a recorder', () => {
  assert.deepEqual(WORKLOAD_COLLECTORS.map((entry) => entry.workload).sort(), [...WORKLOADS].sort());
  for (const entry of WORKLOAD_COLLECTORS) {
    assert.equal(typeof entry.collect, 'function', entry.workload);
    assert.equal(typeof entry.record, 'function', entry.workload);
    assert.ok(entry.powershellFamily === null || typeof entry.powershellFamily === 'string', entry.workload);
  }
});

test('a registered collector runs with its family PowerShell config and the run context', async () => {
  const seen = [];
  const collectors = [
    { workload: 'fixture-graph', powershellFamily: null, record: () => {}, collect: (_client, context) => seen.push(context) },
    { workload: 'fixture-shell', powershellFamily: 'exchange', record: () => {}, collect: (_client, context) => seen.push(context) },
  ];
  const scope = { powershellConfigs: { exchange: '/etc/keel/exchange-collector.json' } };
  const steps = workloadSteps({ config: { tenantId: 't' }, scope, transport: 'transport', powershell: { image: 'keel-ps' }, collectors });
  assert.deepEqual(steps.map((step) => step.workload), ['fixture-graph', 'fixture-shell']);
  for (const step of steps) await step.collect(null, { tenantRef: 'ref' });
  assert.deepEqual(seen[0].base, { tenantRef: 'ref' });
  assert.equal(seen[0].transport, 'transport');
  assert.equal(seen[0].powershell.tenantConfigPath, undefined);
  assert.equal(typeof seen[0].sleep, 'function');
  assert.deepEqual(seen[1].powershell, { image: 'keel-ps', tenantConfigPath: '/etc/keel/exchange-collector.json' });
});
