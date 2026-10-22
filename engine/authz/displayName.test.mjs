import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { cleanDisplayName, entraDisplayName, fillMissingDisplayName, learnDisplayName, nameFromClaims } from './displayName.mjs';
import { resolvePrincipals } from '../govern/references.mjs';
import { schemaSql } from '../store/loadSchema.mjs';

test('a sign-in name is read from the token, given and family names, or custom claims', () => {
  assert.equal(nameFromClaims({ email: 'lee@test.example', name: '  Lee   Chen ' }), 'Lee Chen');
  assert.equal(nameFromClaims({ given_name: 'Lee', family_name: 'Chen' }), 'Lee Chen');
  assert.equal(nameFromClaims({ custom: { name: 'Lee Chen' } }), 'Lee Chen');
  assert.equal(nameFromClaims({ custom: { givenName: 'Lee', surname: 'Chen' } }), 'Lee Chen');
  // An email, a blank, an over-long or a control-character value is no name.
  assert.equal(nameFromClaims({ name: 'lee@test.example' }), null);
  assert.equal(nameFromClaims({ name: '   ' }), null);
  assert.equal(nameFromClaims({ name: 'x'.repeat(101) }), null);
  assert.equal(cleanDisplayName('Lee\u0000Chen'), null);
  assert.equal(nameFromClaims(null), null);
});

async function withDb(run) {
  const db = await createIsolatedTestDatabase(import.meta.url);
  const client = await db.connect();
  try {
    await client.query(schemaSql());
    await run(client);
  } finally {
    await client.end();
    await db.cleanup();
  }
}

async function snapshotWithUsers(client, tenantRef, users, completedAt) {
  const { rows: [snapshot] } = await client.query(
    "INSERT INTO snapshot(tenant_ref, status, completed_at) VALUES ($1, 'complete', $2) RETURNING id", [tenantRef, completedAt],
  );
  for (const [index, payload] of users.entries()) {
    await client.query(
      `INSERT INTO resource_version(snapshot_id, natural_key, resource_type, payload, payload_hash, criticality, blast_radius, fidelity, provenance)
       VALUES ($1, $2, 'user', $3, 'h', 'low', 'low', 'full', '{}')`,
      [snapshot.id, `user:${index}`, payload],
    );
  }
}

test('an Entra user matching the sign-in email by mail, sign-in name or other emails gives the name', async () => {
  await withDb(async (client) => {
    await snapshotWithUsers(client, 'tenant-a', [{ displayName: 'Old Name', mail: 'lee@test.example' }], '2026-10-01T00:00:00Z');
    await snapshotWithUsers(client, 'tenant-a', [
      { displayName: 'Lee Chen', mail: 'Lee@Test.example', userPrincipalName: 'lee.chen@tenant.example' },
      { displayName: 'Sam Ortiz', userPrincipalName: 'sam@tenant.example', otherMails: ['sam.home@mail.example'] },
    ], '2026-10-02T00:00:00Z');
    await snapshotWithUsers(client, 'tenant-b', [{ displayName: 'Other Tenant', mail: 'lee@test.example' }], '2026-10-03T00:00:00Z');

    assert.equal(await entraDisplayName(client, { tenantRef: 'tenant-a', email: 'lee@test.example' }), 'Lee Chen');
    assert.equal(await entraDisplayName(client, { tenantRef: 'tenant-a', email: 'LEE.CHEN@tenant.example' }), 'Lee Chen');
    assert.equal(await entraDisplayName(client, { tenantRef: 'tenant-a', email: 'sam.home@mail.example' }), 'Sam Ortiz');
    assert.equal(await entraDisplayName(client, { tenantRef: 'tenant-a', email: 'nobody@test.example' }), null);
    assert.equal(await entraDisplayName(client, { tenantRef: 'tenant-c', email: 'lee@test.example' }), null);
  });
});

test('a missing display name is filled once, from the first source that has one, and never overwrites a set name', async () => {
  await withDb(async (client) => {
    const { rows: [lee] } = await client.query("INSERT INTO principal(email) VALUES ('leechen@test.example') RETURNING id::text AS id");
    const { rows: [named] } = await client.query("INSERT INTO principal(email, display_name) VALUES ('named@test.example', 'Set By Admin') RETURNING id::text AS id");
    await snapshotWithUsers(client, 'tenant-a', [{ displayName: 'Lee From Entra', mail: 'leechen@test.example' }], '2026-10-02T00:00:00Z');

    let lookups = 0;
    const lookupIdentity = async () => { lookups += 1; return { name: 'Lee From Access' }; };

    // The token's name wins and the slower lookup is never asked.
    assert.equal(await learnDisplayName(client, { principalId: lee.id, email: 'leechen@test.example', tenantRef: 'tenant-a', claims: { name: 'Lee Chen' }, lookupIdentity }), 'Lee Chen');
    assert.equal(lookups, 0);
    const people = await resolvePrincipals(client, [lee.id]);
    assert.equal(people.get(lee.id).name, 'Lee Chen');

    // Once named, nothing replaces the name; an admin-set name is never touched.
    assert.equal(await learnDisplayName(client, { principalId: lee.id, email: 'leechen@test.example', tenantRef: 'tenant-a', claims: { name: 'Someone Else' } }), null);
    assert.equal(await fillMissingDisplayName(client, named.id, 'Replaced'), false);
    assert.equal((await client.query('SELECT display_name FROM principal WHERE id = $1', [named.id])).rows[0].display_name, 'Set By Admin');

    // No token name: the directory answers before the network lookup.
    await client.query("UPDATE principal SET display_name = '  ' WHERE id = $1", [lee.id]);
    assert.equal(await learnDisplayName(client, { principalId: lee.id, email: 'leechen@test.example', tenantRef: 'tenant-a', claims: { email: 'leechen@test.example' }, lookupIdentity }), 'Lee From Entra');
    assert.equal(lookups, 0);

    // Neither has one: the sign-in service's identity does.
    await client.query('UPDATE principal SET display_name = NULL WHERE id = $1', [lee.id]);
    assert.equal(await learnDisplayName(client, { principalId: lee.id, email: 'leechen@test.example', tenantRef: 'tenant-b', lookupIdentity }), 'Lee From Access');
    assert.equal(lookups, 1);

    // Nothing anywhere: the name stays empty.
    await client.query('UPDATE principal SET display_name = NULL WHERE id = $1', [lee.id]);
    assert.equal(await learnDisplayName(client, { principalId: lee.id, email: 'leechen@test.example', lookupIdentity: async () => null }), null);
    assert.equal((await client.query('SELECT display_name FROM principal WHERE id = $1', [lee.id])).rows[0].display_name, null);
  });
});
