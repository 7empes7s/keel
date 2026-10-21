import { CENTRAL_SCOPE, ROLE_CAPABILITIES, entityGrantScope } from './permissions.mjs';

export class SelfLockoutError extends Error {}
export class PrincipalNotFoundError extends Error {}
export class InvalidRoleGrantError extends Error {}
export class PrincipalExistsError extends Error {}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** @param {any} client
 * @param {{ principalId: string, role: string, grantedBy: string, activeFrom?: string | null, activeUntil?: string | null, entityCode?: string | null, reason?: string | null }} options
 */
export async function grantRole(client, { principalId, role, grantedBy, activeFrom = null, activeUntil = null, entityCode = null, reason = null }) {
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
  // An immediate grant starts at `from`, the same millisecond-precision instant validated
  // above. Postgres now() carries microseconds, so a grant checked by resolvePrincipal
  // (which passes a JS Date) in the same millisecond could read as not yet active.
  const { rows } = await client.query(
    `INSERT INTO role_grant (principal_id, role, granted_by, active_from, active_until, scope, reason)
     SELECT id, $2, $3, $4::timestamptz, $5, $6, $7 FROM principal WHERE id = $1 RETURNING *`,
    [principalId, role, grantedBy, from.toISOString(), activeUntil, scope, typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 500) : null],
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

// Add a person with a first role in one step (People page). The email is the sign-in
// identity, unique whatever its case; adding one that exists is refused, never merged.
/** @param {any} client
 * @param {{ email: string, displayName?: string | null, role: string, grantedBy: string, activeUntil?: string | null, reason?: string | null }} options
 */
export async function createPrincipal(client, { email, displayName = null, role, grantedBy, activeUntil = null, reason = null }) {
  const address = typeof email === 'string' ? email.trim() : '';
  if (!EMAIL.test(address) || address.length > 320) throw new InvalidRoleGrantError('invalid email');
  if (!Object.hasOwn(ROLE_CAPABILITIES, role)) throw new InvalidRoleGrantError('unknown role');
  const name = typeof displayName === 'string' && displayName.trim() ? displayName.trim().slice(0, 200) : null;
  await client.query('BEGIN');
  try {
    const existing = await client.query('SELECT id FROM principal WHERE lower(email) = lower($1)', [address]);
    if (existing.rows.length) throw new PrincipalExistsError('a person with this email already exists');
    const { rows: [principal] } = await client.query(
      'INSERT INTO principal (email, display_name) VALUES ($1, $2) RETURNING *', [address, name],
    );
    const grant = await grantRole(client, { principalId: principal.id, role, grantedBy, activeUntil, reason });
    await client.query('COMMIT');
    return { principal, grant };
  } catch (error) {
    await client.query('ROLLBACK');
    // Two adds of the same email at once: the unique index refuses the second.
    if (error?.code === '23505') throw new PrincipalExistsError('a person with this email already exists');
    throw error;
  }
}

// Let a disabled person use Keel again. Their grants were kept, so the roles still in
// their window apply again at once.
export async function enablePrincipal(client, principalId) {
  const { rows } = await client.query('UPDATE principal SET disabled_at = NULL WHERE id = $1 RETURNING *', [principalId]);
  if (!rows[0]) throw new PrincipalNotFoundError('principal not found');
  return rows[0];
}
