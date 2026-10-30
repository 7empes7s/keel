// Security audit finding 6, part 3: the Sentinel destination only saves and resolves
// env:KEEL_INTEGRATION_* sender credential references, so a destination can never read
// the database URL or another secret the worker holds. Destinations saved before that
// are carried over by store/schema.d/80-sentinel-credential-reference.sql.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';

import {
  SENTINEL_DESTINATION_KIND, createSentinelAdapter, sentinelDestinationProblems, sentinelSetupPrerequisites,
} from '../telemetry/adapters/sentinel.mjs';
import { registerDestination } from '../telemetry/outbox.mjs';
import { defineEvent } from '../telemetry/events.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { schemaSql } from '../store/loadSchema.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
const client = await database.connect();
after(async () => {
  await client.end();
  await database.cleanup();
});
await client.query(schemaSql());
const { rows: [admin] } = await client.query(
  "INSERT INTO principal (email) VALUES ('sentinel-ref-admin@example.invalid') RETURNING *",
);
await client.query("INSERT INTO role_grant (principal_id, role) VALUES ($1, 'admin')", [admin.id]);

const BASE = {
  endpoint: 'https://fixture-dce.eastus-1.ingest.monitor.azure.com',
  dcrImmutableId: 'dcr-f1xture00000000000000000000000000aa',
};
const OUTSIDE = ['env:KEEL_DB_URL', 'env:PATH', 'env:keel_integration_lower', 'env:KEEL_INTEGRATION_', 'file:/etc/keel/db.env'];

test('the Sentinel credential reference must be in the integration namespace', () => {
  assert.deepEqual(sentinelDestinationProblems({ ...BASE, credentialRef: 'env:KEEL_INTEGRATION_SENTINEL_CREDENTIAL' }), []);
  assert.deepEqual(sentinelDestinationProblems(BASE), [], 'an unset reference is a setup step, not a save error');
  assert.deepEqual(
    sentinelSetupPrerequisites({ ...BASE, credentialRef: 'env:KEEL_INTEGRATION_SENTINEL_CREDENTIAL' }), [],
  );
  for (const credentialRef of OUTSIDE) {
    assert.equal(sentinelDestinationProblems({ ...BASE, credentialRef }).length, 1, credentialRef);
    const pending = sentinelSetupPrerequisites({ ...BASE, credentialRef });
    assert.deepEqual(pending.map((item) => item.name), ['entra-app-credential-reference'], credentialRef);
    assert.match(pending[0].detail, /env:KEEL_INTEGRATION_/);
  }
});

test('registering a Sentinel destination refuses a reference outside KEEL_INTEGRATION_', async () => {
  for (const [index, credentialRef] of OUTSIDE.entries()) {
    await assert.rejects(
      registerDestination(client, {
        tenantRef: 'fixture', name: `sentinel-bad-${index}`, kind: SENTINEL_DESTINATION_KIND,
        config: { ...BASE, credentialRef }, requestedBy: admin.id,
      }),
      /sentinel destination config: config\.credentialRef must be a reference such as env:KEEL_INTEGRATION_/,
      credentialRef,
    );
  }
  const saved = await registerDestination(client, {
    tenantRef: 'fixture', name: 'sentinel-good', kind: SENTINEL_DESTINATION_KIND,
    config: { ...BASE, credentialRef: 'env:KEEL_INTEGRATION_SENTINEL_CREDENTIAL' }, requestedBy: admin.id,
  });
  assert.equal(saved.config.credentialRef, 'env:KEEL_INTEGRATION_SENTINEL_CREDENTIAL');
});

test('the default credential flow never reads a variable outside KEEL_INTEGRATION_', async () => {
  // KEEL_DB_URL points at a file that would parse; the adapter must not even look it up.
  const previous = process.env.KEEL_DB_URL;
  process.env.KEEL_DB_URL = '/nonexistent/keel-sentinel-should-not-read.json';
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return { status: 204, ok: true, headers: new Headers(), json: async () => ({}) };
  };
  try {
    const adapter = createSentinelAdapter({ fetchImpl });
    const envelope = defineEvent({
      tenantRef: 'fixture', eventType: 'fixture.observed', source: { component: 'fixture' },
      correlationId: 'fixture:1', sourceSequence: 1, observedAt: new Date().toISOString(),
    });
    const result = await adapter.deliver({
      destination: {
        id: 'dest-outside', tenant_ref: 'fixture', kind: SENTINEL_DESTINATION_KIND,
        config: { ...BASE, credentialRef: 'env:KEEL_DB_URL' },
      },
      envelope,
      eventId: envelope.eventId,
    });
    assert.notEqual(result.outcome, 'accepted');
    assert.deepEqual(calls, [], 'no token or ingestion request is made');
    assert.doesNotMatch(JSON.stringify(result), /nonexistent|keel-sentinel-should-not-read/);
  } finally {
    if (previous === undefined) delete process.env.KEEL_DB_URL;
    else process.env.KEEL_DB_URL = previous;
  }
});

test('the carry-over moves saved Sentinel references into the namespace and is safe to re-apply', async () => {
  const fragment = readFileSync(
    new URL('../store/schema.d/80-sentinel-credential-reference.sql', import.meta.url), 'utf8',
  );
  const rows = [
    ['old-upper', SENTINEL_DESTINATION_KIND, { ...BASE, credentialRef: 'env:KEEL_SENTINEL_CRED' }],
    ['old-lower', SENTINEL_DESTINATION_KIND, { ...BASE, credentialRef: 'env:sentinel_cred' }],
    ['old-lower-prefix', SENTINEL_DESTINATION_KIND, { ...BASE, credentialRef: 'env:keel_integration_x' }],
    ['already', SENTINEL_DESTINATION_KIND, { ...BASE, credentialRef: 'env:KEEL_INTEGRATION_Y' }],
    ['not-env', SENTINEL_DESTINATION_KIND, { ...BASE, credentialRef: 'app:sender' }],
    ['unset', SENTINEL_DESTINATION_KIND, { ...BASE }],
    ['webhook', 'webhook', { url: 'https://siem.example.com', credentialRef: 'env:OTHER' }],
  ];
  // Raw inserts: these stand for rows saved before the rule existed.
  for (const [name, kind, config] of rows) {
    await client.query(
      `INSERT INTO siem_destination (tenant_ref, name, kind, config, created_by) VALUES ('carry', $1, $2, $3, 'test')`,
      [name, kind, config],
    );
  }
  const read = async () => Object.fromEntries((await client.query(
    "SELECT name, config FROM siem_destination WHERE tenant_ref = 'carry'",
  )).rows.map((row) => [row.name, row.config.credentialRef ?? null]));
  const expected = {
    'old-upper': 'env:KEEL_INTEGRATION_KEEL_SENTINEL_CRED',
    'old-lower': 'env:KEEL_INTEGRATION_SENTINEL_CRED',
    'old-lower-prefix': 'env:KEEL_INTEGRATION_X',
    already: 'env:KEEL_INTEGRATION_Y',
    'not-env': 'app:sender',
    unset: null,
    webhook: 'env:OTHER',
  };
  await client.query(fragment);
  assert.deepEqual(await read(), expected);
  await client.query(fragment);
  assert.deepEqual(await read(), expected, 'applying it twice changes nothing more');
  // The other config keys are untouched, and a carried-over config saves again.
  const { rows: [moved] } = await client.query(
    "SELECT config FROM siem_destination WHERE tenant_ref = 'carry' AND name = 'old-upper'",
  );
  assert.equal(moved.config.endpoint, BASE.endpoint);
  assert.deepEqual(sentinelDestinationProblems(moved.config), []);
});
