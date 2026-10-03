import { CENTRAL_SCOPE, ROLE_CAPABILITIES, entityGrantScope } from './permissions.mjs';

export class SelfLockoutError extends Error {}
export class PrincipalNotFoundError extends Error {}
export class InvalidRoleGrantError extends Error {}

/** @param {any} client
 * @param {{ principalId: string, role: string, grantedBy: string, activeFrom?: string | null, activeUntil?: string | null, entityCode?: string | null }} options
 */
export async function grantRole(client, { principalId, role, grantedBy, activeFrom = null, activeUntil = null, entityCode = null }) {
  if (!Object.hasOwn(ROLE_CAPABILITIES, role)) throw new InvalidRoleGrantError('unknown role');
  // Task 90: an entity-scoped grant confines the role to that entity's resources.
  // Administration is tenant-wide by nature, so it is never entity-scoped.
  let scope = CENTRAL_SCOPE;
  if (entityCode !== null && entityCode !== undefined) {
    if (role === 'admin') throw new InvalidRoleGrantError('admin cannot be entity-scoped');
    try { scope = entityGrantScope(entityCode); } catch { throw new InvalidRoleGrantError('invalid entity code'); }
  }
  const from = activeFrom === null ? new Date() : new Date(activeFrom);
  const until = activeUntil === null ? null : new Date(activeUntil);
  if (!Number.isFinite(+from) || (until && (!Number.isFinite(+until) || until <= from))) {
    throw new InvalidRoleGrantError('invalid grant window');
  }
  const { rows } = await client.query(
    `INSERT INTO role_grant (principal_id, role, granted_by, active_from, active_until, scope)
     SELECT id, $2, $3, COALESCE($4::timestamptz, now()), $5, $6 FROM principal WHERE id = $1 RETURNING *`,
    [principalId, role, grantedBy, activeFrom, activeUntil, scope],
  );
  if (!rows[0]) throw new PrincipalNotFoundError('principal not found');
  return rows[0];
}

export async function revokeRole(client, { principalId, grantId, revokedBy }) {
  await client.query('BEGIN');
  try {
    // Serialize grant changes and disables while checking the remaining live admins.
    await client.query('LOCK TABLE principal, role_grant IN SHARE ROW EXCLUSIVE MODE');
    const { rows } = await client.query('SELECT * FROM role_grant WHERE id = $1 AND principal_id = $2', [grantId, principalId]);
    const grant = rows[0];
    if (!grant) throw new PrincipalNotFoundError('grant not found');
    if (principalId === revokedBy && grant.role === 'admin') {
      const remaining = await client.query(
        `SELECT rg.id FROM role_grant rg JOIN principal p ON p.id = rg.principal_id
         WHERE rg.id <> $1 AND rg.role = 'admin' AND p.disabled_at IS NULL
           AND rg.active_from <= now() AND (rg.active_until IS NULL OR rg.active_until > now())`, [grantId],
      );
      if (!remaining.rows.length) throw new SelfLockoutError('an admin cannot revoke their own last admin grant');
    }
    const result = await client.query('UPDATE role_grant SET active_until = now() WHERE id = $1 RETURNING *', [grantId]);
    await client.query('COMMIT');
    return result.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

export async function disablePrincipal(client, principalId) {
  await client.query('BEGIN');
  try {
    // Serialize disables and grant changes while checking the remaining live admins.
    await client.query('LOCK TABLE principal, role_grant IN SHARE ROW EXCLUSIVE MODE');
    const { rows } = await client.query('SELECT * FROM principal WHERE id = $1', [principalId]);
    const principal = rows[0];
    if (!principal) throw new PrincipalNotFoundError('principal not found');
    // Disabling the last live admin zeroes out administration with no recovery
    // path; the same self-lockout rule as revokeRole applies regardless of actor.
    if (!principal.disabled_at) {
      const ownLiveAdmin = await client.query(
        `SELECT rg.id FROM role_grant rg
         WHERE rg.principal_id = $1 AND rg.role = 'admin'
           AND rg.active_from <= now() AND (rg.active_until IS NULL OR rg.active_until > now())`, [principalId],
      );
      if (ownLiveAdmin.rows.length) {
        const remaining = await client.query(
          `SELECT rg.id FROM role_grant rg JOIN principal p ON p.id = rg.principal_id
           WHERE p.id <> $1 AND rg.role = 'admin' AND p.disabled_at IS NULL
             AND rg.active_from <= now() AND (rg.active_until IS NULL OR rg.active_until > now())`, [principalId],
        );
        if (!remaining.rows.length) throw new SelfLockoutError('disabling this principal would leave no live admin');
      }
    }
    const result = await client.query('UPDATE principal SET disabled_at = now() WHERE id = $1 RETURNING *', [principalId]);
    await client.query('COMMIT');
    return result.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
