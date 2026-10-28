// Security audit finding 6, part 2: ServiceNow and the Teams, Slack, PagerDuty and SMS
// channels only save and resolve env:KEEL_INTEGRATION_* credential references, so a
// setting can never read the database URL or another secret the worker holds. Settings
// saved before that are carried over by store/schema.d/79-integration-references.sql.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';

import { ChannelConfigError, defaultResolveSecret as notifyResolveSecret, validateChannelConfig } from '../notify/adapters.mjs';
import {
  defaultResolveSecret as serviceNowResolveSecret, saveServiceNowConfig, serviceNowConfigProblems,
} from '../itsm/adapters/servicenow.mjs';
import { qualificationResolveSecret } from '../../tools/qualification/servicenowLive.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { schemaSql } from '../store/loadSchema.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
const client = await database.connect();
after(async () => {
  await client.end();
  await database.cleanup();
});
await client.query(schemaSql());

const ADMIN = '11111111-1111-4111-8111-111111111111';
await client.query(`INSERT INTO principal (id, email, display_name) VALUES ($1, 'admin@example.com', 'Admin')`, [ADMIN]);
await client.query(
  `INSERT INTO role_grant (principal_id, role, granted_by, reason, active_until) VALUES ($1, 'admin', 'test', 'configures ServiceNow', NULL)`,
  [ADMIN],
);

const SERVICENOW = {
  instanceUrl: 'https://keel-fixture.service-now.com',
  table: 'u_keel_change',
  credential: { tokenRef: 'env:KEEL_INTEGRATION_SN_TOKEN' },
  fields: {
    state: 'u_state', approver: 'u_approver', planVersion: 'u_plan_rev', planDigest: 'u_plan_hash',
    keelRequest: 'u_keel_request', keelDecision: 'u_keel_decision',
  },
  states: { approved: ['gate_passed'], rejected: ['gate_blocked'] },
  callback: { secretRef: 'env:KEEL_INTEGRATION_SN_CALLBACK_SECRET', maxSkewSeconds: 120 },
};

const FAKE_DB_URL = 'postgres://keel:fixture-password@localhost/keel';

/** Runs `body` with these environment variables set, then puts the old values back. */
async function withEnv(values, body) {
  const before = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try {
    return await body();
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('notify channels refuse and never resolve a reference outside KEEL_INTEGRATION_', async () => {
  for (const [kind, config] of [
    ['teams', { endpointRef: 'env:KEEL_DB_URL' }],
    ['slack', { endpointRef: 'env:SLACK_WEBHOOK' }],
    ['pagerduty', { routingKeyRef: 'env:keel_integration_lower' }],
    ['sms', { provider: 'twilio', accountSid: `AC${'0'.repeat(32)}`, authTokenRef: 'env:KEEL_TWILIO_TOKEN', from: '+15551230000', to: '+15551239999' }],
  ]) {
    assert.throws(() => validateChannelConfig(kind, config), (error) => error instanceof ChannelConfigError
      && /must be a credential reference such as env:KEEL_INTEGRATION_NAME/.test(error.message), kind);
  }
  assert.doesNotThrow(() => validateChannelConfig('pagerduty', { routingKeyRef: 'env:KEEL_INTEGRATION_PAGERDUTY_KEY' }));

  await withEnv({ KEEL_DB_URL: FAKE_DB_URL, KEEL_INTEGRATION_PAGERDUTY_KEY: 'routing-key' }, () => {
    assert.throws(() => notifyResolveSecret('env:KEEL_DB_URL'), /not a credential reference/);
    assert.equal(notifyResolveSecret('env:KEEL_INTEGRATION_PAGERDUTY_KEY'), 'routing-key');
  });
});

test('ServiceNow saves and resolves only KEEL_INTEGRATION_ references', async () => {
  const tenantRef = 'sha256:integration-references';
  for (const config of [
    { ...SERVICENOW, credential: { tokenRef: 'env:KEEL_DB_URL' } },
    { ...SERVICENOW, callback: { ...SERVICENOW.callback, secretRef: 'env:KEEL_SN_CALLBACK_SECRET' } },
  ]) {
    await assert.rejects(saveServiceNowConfig(client, { tenantRef, config, requestedBy: ADMIN }),
      (error) => error.code === 'invalid' && /env:KEEL_INTEGRATION_SERVICENOW_TOKEN/.test(error.message));
  }
  const { rows: [{ count }] } = await client.query('SELECT count(*)::int AS count FROM itsm_adapter_config WHERE tenant_ref = $1', [tenantRef]);
  assert.equal(count, 0, 'nothing is stored');
  await saveServiceNowConfig(client, { tenantRef, config: SERVICENOW, requestedBy: ADMIN });

  await withEnv({ KEEL_DB_URL: FAKE_DB_URL, KEEL_INTEGRATION_SN_TOKEN: 'sn-token' }, () => {
    assert.throws(() => serviceNowResolveSecret('env:KEEL_DB_URL'), /unresolved credential reference: env:KEEL_DB_URL/);
    assert.equal(serviceNowResolveSecret('env:KEEL_INTEGRATION_SN_TOKEN'), 'sn-token');
  });
});

test('a mapping recorded under an older name still reads as complete, so signed qualification records keep verifying', () => {
  assert.deepEqual(serviceNowConfigProblems({ ...SERVICENOW, credential: { tokenRef: 'env:KEEL_SN_TOKEN' } }), []);
});

test('the qualification capture reads a test user token by any env name, and KEEL settings through the product resolver', async () => {
  await withEnv({ KEEL_SN_TEST_USER_ONE: 'user-token', KEEL_INTEGRATION_SN_TOKEN: 'keel-token' }, () => {
    assert.equal(qualificationResolveSecret('env:KEEL_SN_TEST_USER_ONE'), 'user-token');
    assert.equal(qualificationResolveSecret('env:KEEL_INTEGRATION_SN_TOKEN'), 'keel-token');
    assert.throws(() => qualificationResolveSecret('env:KEEL_SN_UNSET'), /unresolved credential reference/);
    assert.throws(() => qualificationResolveSecret('KEEL_SN_TEST_USER_ONE'), /unresolved credential reference/);
  });
});

test('the schema carries saved references over to KEEL_INTEGRATION_ names and is safe to re-apply', async () => {
  const fragment = readFileSync(new URL('../store/schema.d/79-integration-references.sql', import.meta.url), 'utf8');
  const tenantRef = 'sha256:integration-carry-over';
  const legacy = { ...SERVICENOW, credential: { tokenRef: 'env:KEEL_SN_TOKEN' }, callback: { secretRef: 'env:keel_integration_sn_callback', maxSkewSeconds: 120 } };
  await client.query(
    `INSERT INTO itsm_adapter_config (tenant_ref, adapter, config, updated_by) VALUES ($1, 'servicenow', $2, 'test')`,
    [tenantRef, JSON.stringify(legacy)],
  );
  const channels = [
    ['teams', { endpointRef: 'env:KEEL_TEAMS_WEBHOOK' }, { endpointRef: 'env:KEEL_INTEGRATION_KEEL_TEAMS_WEBHOOK' }],
    ['slack', { endpointRef: 'env:KEEL_INTEGRATION_SLACK_WEBHOOK' }, { endpointRef: 'env:KEEL_INTEGRATION_SLACK_WEBHOOK' }],
    ['pagerduty', { routingKeyRef: 'env:pd_key', region: 'eu' }, { routingKeyRef: 'env:KEEL_INTEGRATION_PD_KEY', region: 'eu' }],
    ['sms', { provider: 'twilio', authTokenRef: 'env:KEEL_DB_URL' }, { provider: 'twilio', authTokenRef: 'env:KEEL_INTEGRATION_KEEL_DB_URL' }],
    ['webhook', { url: 'https://hooks.example.test/x', tokenRef: 'env:LEFT_ALONE' }, { url: 'https://hooks.example.test/x', tokenRef: 'env:LEFT_ALONE' }],
    ['teams', { endpointRef: 'https://not-a-reference.example.test/' }, { endpointRef: 'https://not-a-reference.example.test/' }],
  ];
  const ids = [];
  for (const [kind, config] of channels) {
    const { rows: [row] } = await client.query('INSERT INTO channel (kind, config) VALUES ($1, $2) RETURNING id', [kind, JSON.stringify(config)]);
    ids.push(row.id);
  }

  for (let run = 0; run < 2; run += 1) {
    await client.query(fragment);
    const { rows: [stored] } = await client.query('SELECT config FROM itsm_adapter_config WHERE tenant_ref = $1', [tenantRef]);
    assert.equal(stored.config.credential.tokenRef, 'env:KEEL_INTEGRATION_KEEL_SN_TOKEN');
    assert.deepEqual(stored.config.callback, { secretRef: 'env:KEEL_INTEGRATION_SN_CALLBACK', maxSkewSeconds: 120 });
    assert.deepEqual(stored.config.fields, SERVICENOW.fields, 'the rest of the mapping is untouched');
    for (const [index, [kind, , expected]] of channels.entries()) {
      const { rows: [row] } = await client.query('SELECT config FROM channel WHERE id = $1', [ids[index]]);
      assert.deepEqual(row.config, expected, `${kind} #${index} after run ${run + 1}`);
    }
  }
  // A carried-over ServiceNow mapping is one the adapter accepts again.
  const { rows: [stored] } = await client.query('SELECT config FROM itsm_adapter_config WHERE tenant_ref = $1', [tenantRef]);
  await saveServiceNowConfig(client, { tenantRef, config: stored.config, requestedBy: ADMIN });
});
