// engine/authz/principals.mjs
//
// Resolving an authenticated email to a principal and its capabilities (§2.4, §3.2).
// Authentication is not authorisation: an email with no principal row resolves to no
// capabilities, and a disabled principal resolves to no capabilities even with live
// grants. A grant counts only while `at` is inside its [active_from, active_until)
// window; a null active_until is open-ended. Nothing sets a bounded window yet;
// everything honours one.
import { capabilitiesForRole } from './permissions.mjs';

export async function findPrincipalByEmail(client, email) {
  const { rows } = await client.query(
    `SELECT * FROM principal WHERE lower(email) = lower($1)`,
    [email],
  );
  return rows[0] ?? null;
}

export async function capabilitiesForPrincipal(client, principal, at = new Date()) {
  if (!principal?.id || principal.disabled_at) return [];
  const { rows } = await client.query(
    `SELECT rg.role
       FROM role_grant rg
       JOIN principal p ON p.id = rg.principal_id
      WHERE rg.principal_id = $1
        AND p.disabled_at IS NULL
        AND rg.active_from <= $2
        AND (rg.active_until IS NULL OR rg.active_until > $2)`,
    [principal.id, at],
  );
  return [...new Set(rows.flatMap((row) => capabilitiesForRole(row.role)))];
}

export async function resolvePrincipal(client, email, at = new Date()) {
  const principal = await findPrincipalByEmail(client, email);
  return {
    principal,
    capabilities: await capabilitiesForPrincipal(client, principal, at),
  };
}
