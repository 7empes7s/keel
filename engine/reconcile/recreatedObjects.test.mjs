// Issue #485: after a restore creates an object, a second dry run from the
// SAME snapshot must plan nothing (or an update), never a second create.
// Microsoft gives a recreated object a new id, so a backup keyed by the old id
// matches nothing live; the journal's create (backup key -> new id) and, for a
// create that recorded no id, a unique name match find it again.
// Fixtures only: a fake Graph reader and an isolated Postgres schema.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { buildReconciliationPlan } from './reconciliationPlan.mjs';
import { recordPriorState, recordWriteOutcome, loadCreatedTargetIds } from '../restore/rollbackJournal.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';

const BRANDING_PATH = '/deviceManagement/intuneBrandingProfiles';
const REUSABLE_PATH = '/deviceManagement/reusablePolicySettings';

/** Answers every catalog read by the collection it names; unknown paths fail. */
function reader(collections) {
  return {
    async collect(_version, path) {
      const match = Object.entries(collections).find(([prefix]) => path.startsWith(prefix));
      if (!match) throw new Error(`unexpected collection: ${path}`);
      return { items: match[1], error: null };
    },
  };
}

const branding = {
  naturalKey: 'intuneBrandingProfile:old-branding-id',
  resourceType: 'intuneBrandingProfile',
  sourceId: 'old-branding-id',
  payload: { id: 'old-branding-id', profileName: 'KEEL-RT-branding', displayName: 'KEEL-RT-branding', contactITName: 'Help desk' },
  references: [],
  blastRadius: 'low',
};
const reusable = {
  naturalKey: 'deviceManagementReusablePolicySetting:old-reusable-id',
  resourceType: 'deviceManagementReusablePolicySetting',
  sourceId: 'old-reusable-id',
  payload: { id: 'old-reusable-id', displayName: 'KEEL-RT-reusable', description: 'test fixture' },
  references: [],
  blastRadius: 'low',
};

const recreatedBranding = { ...branding.payload, id: 'new-branding-id' };
const recreatedReusable = { ...reusable.payload, id: 'new-reusable-id' };

const created = (entries) => new Map(Object.entries(entries).map(([key, value]) => [key, {
  resourceType: key.split(':')[0], targetIds: [], unknownIdCreates: 0, ...value,
}]));

test('without the journal a recreated object is planned as a second create (the bug)', async () => {
  const plan = await buildReconciliationPlan(reader({ [BRANDING_PATH]: [recreatedBranding] }), [branding], { sameTenant: true });
  assert.equal(plan.resources[0].verb, 'create');
});

test('a re-run maps the backup key to the id the earlier create recorded, for every recreated kind', async () => {
  const plan = await buildReconciliationPlan(reader({
    [BRANDING_PATH]: [recreatedBranding],
    [REUSABLE_PATH]: [recreatedReusable],
  }), [branding, reusable], {
    sameTenant: true,
    createdTargetIds: created({
      [branding.naturalKey]: { targetIds: ['new-branding-id'] },
      [reusable.naturalKey]: { targetIds: ['NEW-REUSABLE-ID'] },
    }),
  });
  const byKey = new Map(plan.resources.map((resource) => [resource.naturalKey, resource]));
  for (const [key, id] of [[branding.naturalKey, 'new-branding-id'], [reusable.naturalKey, 'new-reusable-id']]) {
    assert.equal(byKey.get(key).verb, 'noop', `${key}: nothing to write`);
    assert.equal(byKey.get(key).targetId, id);
  }
});

test('a recreated object changed since is planned as an update of that object, not a create', async () => {
  const plan = await buildReconciliationPlan(reader({ [BRANDING_PATH]: [{ ...recreatedBranding, contactITName: 'Changed' }] }), [branding], {
    sameTenant: false,
    createdTargetIds: created({ [branding.naturalKey]: { targetIds: ['new-branding-id'] } }),
  });
  assert.equal(plan.resources[0].verb, 'update');
  assert.equal(plan.resources[0].targetId, 'new-branding-id');
});

test('an object the earlier create made, deleted since, is created again', async () => {
  const plan = await buildReconciliationPlan(reader({ [BRANDING_PATH]: [] }), [branding], {
    sameTenant: true,
    createdTargetIds: created({ [branding.naturalKey]: { targetIds: ['new-branding-id'] } }),
  });
  assert.equal(plan.resources[0].verb, 'create');
});

test('the snapshot\'s own ids win over a journal id', async () => {
  // A later snapshot holds the recreated object under its new key; the journal
  // row for the old key must not take it away from that key.
  const later = { ...branding, naturalKey: 'intuneBrandingProfile:new-branding-id', sourceId: 'new-branding-id', payload: recreatedBranding };
  const plan = await buildReconciliationPlan(reader({ [BRANDING_PATH]: [recreatedBranding] }), [later], {
    sameTenant: true,
    createdTargetIds: created({ [branding.naturalKey]: { targetIds: ['new-branding-id'] } }),
  });
  assert.equal(plan.resources[0].verb, 'noop');
  assert.equal(plan.resources[0].targetId, 'new-branding-id');
});

test('a create that recorded no id adopts the one live object with the backup\'s name', async () => {
  const plan = await buildReconciliationPlan(reader({ [REUSABLE_PATH]: [recreatedReusable, { id: 'other', displayName: 'Something else' }] }), [reusable], {
    sameTenant: true,
    createdTargetIds: created({ [reusable.naturalKey]: { unknownIdCreates: 1 } }),
  });
  assert.equal(plan.resources[0].verb, 'noop');
  assert.equal(plan.resources[0].targetId, 'new-reusable-id');
  assert.match(plan.resources[0].verbReason, /created by an earlier restore/);
});

test('two live objects with the backup\'s name are never guessed between', async () => {
  const plan = await buildReconciliationPlan(reader({
    [REUSABLE_PATH]: [recreatedReusable, { ...recreatedReusable, id: 'twin-id' }],
  }), [reusable], {
    sameTenant: true,
    createdTargetIds: created({ [reusable.naturalKey]: { unknownIdCreates: 1 } }),
  });
  assert.equal(plan.resources[0].verb, 'create');
});

test('a name match is not used when the journal shows no create for the key', async () => {
  const plan = await buildReconciliationPlan(reader({ [REUSABLE_PATH]: [recreatedReusable] }), [reusable], {
    sameTenant: true, createdTargetIds: new Map(),
  });
  assert.equal(plan.resources[0].verb, 'create');
});

test('loadCreatedTargetIds reads succeeded and uncertain creates for the target tenant only', async () => {
  const database = await createIsolatedTestDatabase(import.meta.url);
  const admin = await database.connect();
  let client;
  try {
    await admin.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    await admin.query(`
      CREATE TABLE rollback_entry (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        run_id text NOT NULL, natural_key text NOT NULL, prior_state jsonb,
        recorded_at timestamptz NOT NULL DEFAULT now(),
        restore_ref text, resource_type text, operation text, target_id text, blast_radius text,
        intended_state jsonb, post_state jsonb, outcome text, outcome_detail text, outcome_at timestamptz
      );
      CREATE TABLE restore_dry_run (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), target_tenant_id text NOT NULL);
    `);
    client = await database.connect();
    const artifact = async (tenant) => (await client.query('INSERT INTO restore_dry_run (target_tenant_id) VALUES ($1) RETURNING id::text AS id', [tenant])).rows[0].id;
    const here = await artifact('tenant-a');
    const elsewhere = await artifact('tenant-b');
    const write = async ({ restoreRef, naturalKey, operation = 'create', outcome, targetId }) => {
      const entryId = await recordPriorState(client, {
        runId: 'run', naturalKey, priorState: null, restoreRef, resourceType: naturalKey.split(':')[0], operation, intendedState: {},
      });
      if (outcome) await recordWriteOutcome(client, { entryId, outcome, targetId });
    };
    await write({ restoreRef: here, naturalKey: branding.naturalKey, outcome: 'succeeded', targetId: 'new-branding-id' });
    await write({ restoreRef: here, naturalKey: reusable.naturalKey, outcome: 'uncertain' });
    await write({ restoreRef: here, naturalKey: 'intuneBrandingProfile:rejected', outcome: 'failed' });
    await write({ restoreRef: here, naturalKey: 'intuneBrandingProfile:updated', operation: 'update', outcome: 'succeeded', targetId: 'x' });
    await write({ restoreRef: elsewhere, naturalKey: branding.naturalKey, outcome: 'succeeded', targetId: 'other-tenant-id' });

    const map = await loadCreatedTargetIds(client, { targetTenantId: 'tenant-a' });
    assert.deepEqual([...map.keys()].sort(), [branding.naturalKey, reusable.naturalKey].sort());
    assert.deepEqual(map.get(branding.naturalKey).targetIds, ['new-branding-id']);
    assert.equal(map.get(branding.naturalKey).unknownIdCreates, 0);
    assert.deepEqual(map.get(reusable.naturalKey).targetIds, []);
    assert.equal(map.get(reusable.naturalKey).unknownIdCreates, 1);
    assert.deepEqual(await loadCreatedTargetIds(client, { targetTenantId: undefined }), new Map());
  } finally {
    await client?.end();
    await admin.end();
    await database.cleanup();
  }
});
