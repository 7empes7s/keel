// Issue #980: the insights-summary job's CLI. It needs the tenant and the requester, hands
// both to the engine on one connection, closes it, and logs one line with no ids.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { main } from './keel-insights-summary.mjs';

const argv = (...args) => ['node', 'keel-insights-summary.mjs', ...args];

test('it refuses to run without a tenant and a requester', async () => {
  const logger = { log() {} };
  await assert.rejects(() => main({ argv: argv('--tenant-ref', 't'), dbUrl: 'postgres://x', logger }), /--tenant-ref and --requested-by are required/);
  await assert.rejects(() => main({ argv: argv('--requested-by', 'p'), dbUrl: 'postgres://x', logger }), /--tenant-ref and --requested-by are required/);
  await assert.rejects(() => main({ argv: argv('--tenant-ref', 't', '--requested-by', 'p'), dbUrl: undefined, logger }), /KEEL_DB_URL not set/);
});

test('it sends the week through the engine and closes its connection', async () => {
  const calls = [];
  let ended = 0;
  const lines = [];
  const client = { end: async () => { ended += 1; } };
  await main({
    argv: argv('--tenant-ref', 'sha256:abc', '--requested-by', 'scheduler-principal'),
    dbUrl: 'postgres://keel@localhost/keel',
    logger: { log: (line) => lines.push(line) },
    dependencies: {
      connect: async (url) => { calls.push(['connect', url]); return client; },
      sendWeeklySummary: async (connected, options) => {
        calls.push(['send', connected === client, options]);
        return { event: { week: '2026-W46', verdict: '3 changes in the last 7 days; 1 needs a look.' }, deliveries: [{}, {}] };
      },
    },
  });
  assert.deepEqual(calls, [
    ['connect', 'postgres://keel@localhost/keel'],
    ['send', true, { tenantRef: 'sha256:abc', requestedBy: 'scheduler-principal' }],
  ]);
  assert.equal(ended, 1);
  assert.deepEqual(lines, ['insights-summary: 2026-W46: 3 changes in the last 7 days; 1 needs a look. Queued 2 deliveries.']);
});
