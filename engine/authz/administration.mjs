import { ROLE_CAPABILITIES } from './permissions.mjs';

export class SelfLockoutError extends Error {}
export class PrincipalNotFoundError extends Error {}
export class InvalidRoleGrantError extends Error {}

/** @param {any} client
 * @param {{ principalId: string, role: string, grantedBy: string, activeFrom?: string | null, activeUntil?: string | null }} options
 */
export async function grantRole(client, { principalId, role, grantedBy, activeFrom = null, activeUntil = null }) {
  if (!Object.hasOwn(ROLE_CAPABILITIES, role)) throw new InvalidRoleGrantError('unknown role');
  const from = activeFrom === null ? new Date() : new Date(activeFrom);
  const until = activeUntil === null ? null : new Date(activeUntil);
  if (!Number.isFinite(+from) || (until && (!Number.isFinite(+until) || until <= from))) {
    throw new InvalidRoleGrantError('invalid grant window');
  }
  const { rows } = await client.query(
    `INSERT INTO role_grant (principal_id, role, granted_by, active_from, active_until)
     SELECT id, $2, $3, COALESCE($4::timestamptz, now()), $5 FROM principal WHERE id = $1 RETURNING *`,
    [principalId, role, grantedBy, activeFrom, activeUntil],
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
  const { rows } = await client.query('UPDATE principal SET disabled_at = now() WHERE id = $1 RETURNING *', [principalId]);
  if (!rows[0]) throw new PrincipalNotFoundError('principal not found');
  return rows[0];
}
