import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { grantRole, revokeRole, disablePrincipal, SelfLockoutError } from './administration.mjs';
import { listPrincipals, capabilitiesForPrincipal, resolvePrincipal } from './principals.mjs';

test('principal administration: live grants, self-lockout, windows, and disabled consistency', async () => {
  const db = await createIsolatedTestDatabase(import.meta.url);
  const client = await db.connect();
  try {
    const schema = readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8');
    await client.query(schema.slice(schema.indexOf('CREATE TABLE IF NOT EXISTS principal'), schema.indexOf('-- §3.3 approvals')));
    const { rows: [admin] } = await client.query("INSERT INTO principal(email) VALUES ('admin@test') RETURNING *");
    const grant = await grantRole(client, { principalId: admin.id, role: 'admin', grantedBy: admin.id });
    await assert.rejects(revokeRole(client, { principalId: admin.id, grantId: grant.id, revokedBy: admin.id }), SelfLockoutError);
    assert.equal((await client.query('SELECT active_until FROM role_grant WHERE id = $1', [grant.id])).rows[0].active_until, null);
    const { rows: [other] } = await client.query("INSERT INTO principal(email) VALUES ('other@test') RETURNING *");
    assert.deepEqual((await resolvePrincipal(client, other.email)).capabilities, []);
    const otherGrant = await grantRole(client, { principalId: other.id, role: 'admin', grantedBy: admin.id });
    assert.ok((await resolvePrincipal(client, other.email)).capabilities.includes('users'));
    await revokeRole(client, { principalId: admin.id, grantId: grant.id, revokedBy: admin.id });
    assert.deepEqual((await resolvePrincipal(client, admin.email)).capabilities, []);
    await assert.rejects(revokeRole(client, { principalId: other.id, grantId: otherGrant.id, revokedBy: other.id }), SelfLockoutError);
    const duplicate = await grantRole(client, { principalId: other.id, role: 'admin', grantedBy: other.id });
    await revokeRole(client, { principalId: other.id, grantId: duplicate.id, revokedBy: other.id });
    await grantRole(client, { principalId: admin.id, role: 'admin', grantedBy: other.id, activeFrom: '2099-01-01', activeUntil: '2100-01-01' });
    await assert.rejects(revokeRole(client, { principalId: other.id, grantId: otherGrant.id, revokedBy: other.id }), SelfLockoutError);
    await disablePrincipal(client, other.id);
    const views = await listPrincipals(client);
    for (const view of views) assert.deepEqual(view.capabilities, await capabilitiesForPrincipal(client, view));
    const disabled = views.find(p => p.id === other.id);
    assert.ok(disabled.disabled_at);
    assert.deepEqual(disabled.capabilities, []);
    assert.ok(disabled.role_grants.some(g => g.active_until === null));
    assert.ok(views.find(p => p.id === admin.id).role_grants.every(g => g.active_from));
  } finally { await client.end(); await db.cleanup(); }
});
