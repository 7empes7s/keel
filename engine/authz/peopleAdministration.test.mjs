import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { createPrincipal, enablePrincipal, disablePrincipal, grantRole, InvalidRoleGrantError, PrincipalExistsError, PrincipalNotFoundError } from './administration.mjs';
import { listPrincipals, resolvePrincipal } from './principals.mjs';
import { schemaSql } from '../store/loadSchema.mjs';

// People page: add a person with a first role, and let a disabled person back in.
test('createPrincipal adds a person with a first role; enablePrincipal restores their kept roles', async () => {
  const db = await createIsolatedTestDatabase(import.meta.url);
  const client = await db.connect();
  try {
    await client.query(schemaSql());
    const { rows: [admin] } = await client.query("INSERT INTO principal(email) VALUES ('admin@test.example') RETURNING *");
    await grantRole(client, { principalId: admin.id, role: 'admin', grantedBy: admin.id });

    const { principal, grant } = await createPrincipal(client, { email: ' Lee.Chen@Test.example ', displayName: ' Lee Chen ', role: 'approver', grantedBy: admin.id, reason: 'Covers approvals in October' });
    assert.equal(principal.email, 'Lee.Chen@Test.example');
    assert.equal(principal.display_name, 'Lee Chen');
    assert.equal(grant.role, 'approver');
    assert.equal(grant.granted_by, admin.id);
    assert.equal(grant.reason, 'Covers approvals in October');
    assert.deepEqual((await resolvePrincipal(client, 'lee.chen@test.example')).capabilities, ['approve']);

    // The email is unique whatever its case, and nothing is left behind by a refusal.
    await assert.rejects(createPrincipal(client, { email: 'LEE.CHEN@test.example', role: 'viewer', grantedBy: admin.id }), PrincipalExistsError);
    await assert.rejects(createPrincipal(client, { email: 'not-an-email', role: 'viewer', grantedBy: admin.id }), InvalidRoleGrantError);
    await assert.rejects(createPrincipal(client, { email: 'new@test.example', role: 'owner', grantedBy: admin.id }), InvalidRoleGrantError);
    await assert.rejects(createPrincipal(client, { email: 'window@test.example', role: 'viewer', grantedBy: admin.id, activeUntil: '2000-01-01' }), InvalidRoleGrantError);
    assert.equal((await client.query("SELECT count(*)::int AS n FROM principal WHERE lower(email) IN ('new@test.example', 'window@test.example')")).rows[0].n, 0);

    // A time-limited first role.
    const temp = await createPrincipal(client, { email: 'temp@test.example', role: 'viewer', grantedBy: admin.id, activeUntil: '2099-01-01T00:00:00Z' });
    assert.equal(new Date(temp.grant.active_until).toISOString(), '2099-01-01T00:00:00.000Z');

    // Disable, then enable again: the kept grant applies at once.
    await disablePrincipal(client, principal.id);
    assert.deepEqual((await resolvePrincipal(client, principal.email)).capabilities, []);
    const enabled = await enablePrincipal(client, principal.id);
    assert.equal(enabled.disabled_at, null);
    assert.deepEqual((await resolvePrincipal(client, principal.email)).capabilities, ['approve']);
    await assert.rejects(enablePrincipal(client, '00000000-0000-0000-0000-000000000000'), PrincipalNotFoundError);
    assert.equal((await listPrincipals(client)).length, 3);
  } finally { await client.end(); await db.cleanup(); }
});
