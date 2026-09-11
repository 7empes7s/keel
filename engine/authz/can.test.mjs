import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { can } from './can.mjs';
import { findPrincipalByEmail, resolvePrincipal } from './principals.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
let client;

try {
  const admin = await database.connect();
  try {
    await admin.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    const schema = readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8');
    const authzSchema = schema.slice(
      schema.indexOf('CREATE TABLE IF NOT EXISTS principal'),
      schema.indexOf('-- §3.3 approvals'),
    );
    await admin.query(authzSchema);
  } finally {
    await admin.end();
  }

  client = await database.connect();

  async function addPrincipal({ email, disabledAt = null }) {
    const { rows } = await client.query(
      `INSERT INTO principal (email, display_name, disabled_at)
       VALUES ($1, $2, $3) RETURNING *`,
      [email, email, disabledAt],
    );
    return rows[0];
  }

  async function grant({ principalId, role, activeFrom = null, activeUntil = null }) {
    await client.query(
      `INSERT INTO role_grant (principal_id, role, active_from, active_until, granted_by, reason)
       VALUES ($1, $2, COALESCE($3, now()), $4, 'test', 'test grant')`,
      [principalId, role, activeFrom, activeUntil],
    );
  }

  const past = new Date(Date.now() - 3600_000);
  const future = new Date(Date.now() + 3600_000);

  // --- a live grant grants its role's capabilities, and no others ---
  const operator = await addPrincipal({ email: 'operator@example.com' });
  await grant({ principalId: operator.id, role: 'operator', activeFrom: past });
  assert.equal(await can(client, operator, 'collect'), true);
  assert.equal(await can(client, operator, 'backup'), true);
  assert.equal(await can(client, operator, 'baseline-create'), true);
  assert.equal(await can(client, operator, 'dispose-accept'), true);
  assert.equal(await can(client, operator, 'restore'), false);
  assert.equal(await can(client, operator, 'approve'), false);
  assert.equal(await can(client, operator, 'users'), false);
  assert.equal(await can(client, operator, 'read'), false, 'operator is not viewer');

  // --- a grant whose window has not started grants nothing ---
  const pending = await addPrincipal({ email: 'pending@example.com' });
  await grant({ principalId: pending.id, role: 'viewer', activeFrom: future });
  assert.equal(await can(client, pending, 'read'), false);

  // --- a grant whose window has expired grants nothing ---
  const expired = await addPrincipal({ email: 'expired@example.com' });
  await grant({
    principalId: expired.id, role: 'viewer',
    activeFrom: new Date(Date.now() - 7200_000), activeUntil: past,
  });
  assert.equal(await can(client, expired, 'read'), false);

  // --- the window is [active_from, active_until): active_until itself is outside ---
  const boundary = await addPrincipal({ email: 'boundary@example.com' });
  const until = new Date(Date.now() + 60_000);
  await grant({ principalId: boundary.id, role: 'viewer', activeFrom: past, activeUntil: until });
  assert.equal(await can(client, boundary, 'read', until), false);
  assert.equal(await can(client, boundary, 'read', new Date(until.getTime() - 1)), true);

  // --- a null active_until is open-ended ---
  const openEnded = await addPrincipal({ email: 'open@example.com' });
  await grant({ principalId: openEnded.id, role: 'restorer', activeFrom: past, activeUntil: null });
  assert.equal(await can(client, openEnded, 'restore'), true);
  assert.equal(
    await can(client, openEnded, 'restore', new Date(Date.now() + 10 * 365 * 24 * 3600_000)),
    true,
  );

  // --- a disabled principal gets nothing, even with live grants ---
  const disabled = await addPrincipal({ email: 'disabled@example.com', disabledAt: past });
  await grant({ principalId: disabled.id, role: 'admin', activeFrom: past });
  assert.equal(await can(client, disabled, 'users'), false);
  assert.equal(await can(client, disabled, 'configuration'), false);
  const resolvedDisabled = await resolvePrincipal(client, 'disabled@example.com');
  assert.equal(resolvedDisabled.principal.id, disabled.id);
  assert.deepEqual(resolvedDisabled.capabilities, []);

  // --- a verified email with no principal row gets no capabilities ---
  const nobody = await findPrincipalByEmail(client, 'ghost@example.com');
  assert.equal(nobody, null);
  assert.equal(await can(client, nobody, 'read'), false);
  assert.equal(await can(client, nobody, 'collect'), false);
  assert.equal(await can(client, nobody, 'users'), false);
  const resolvedNobody = await resolvePrincipal(client, 'ghost@example.com');
  assert.equal(resolvedNobody.principal, null);
  assert.deepEqual(resolvedNobody.capabilities, []);

  // --- email lookup is case-insensitive; capabilities come only from that principal ---
  const resolved = await resolvePrincipal(client, 'OPERATOR@example.com');
  assert.equal(resolved.principal.id, operator.id);
  assert.ok(resolved.capabilities.includes('collect'));
  assert.ok(!resolved.capabilities.includes('restore'));
  assert.ok(!resolved.capabilities.includes('read'));

} finally {
  await client?.end();
  await database.cleanup();
}
console.log('can.test.mjs — all assertions passed');
