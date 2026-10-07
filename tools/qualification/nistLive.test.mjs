// Task-119 capture refusals that need no pinned catalog (the end-to-end capture test lives in
// engine/roadmap/nist-benchmark-acceptance.test.mjs, which runs on hosts that hold the catalog).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { captureNistAcceptance } from './nistLive.mjs';

const base = { client: { async query() { return { rows: [] }; } }, principal: { id: 'p' }, tenantRef: 'sha256:0000000000000000',
  build: 'fixture-build', runner: { identity: 'keel-release-runner', key: 'test-only' } };

test('nistLive capture refuses an unknown runner, a missing key, build or principal before reading anything', async () => {
  await assert.rejects(captureNistAcceptance({ ...base, runner: { identity: 'someone', key: 'k' } }), /untrusted runner/);
  await assert.rejects(captureNistAcceptance({ ...base, runner: { identity: 'keel-release-runner' } }), /signing key/);
  await assert.rejects(captureNistAcceptance({ ...base, build: null }), /build identity/);
  await assert.rejects(captureNistAcceptance({ ...base, principal: null }), /authorized KEEL principal/);
});
