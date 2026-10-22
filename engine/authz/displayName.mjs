// engine/authz/displayName.mjs
//
// A signed-in person with no display name is shown by a name guessed from their email
// ("marouanedefili@…" reads "Marouanedefili"). On sign-in the portal fills the missing
// name once, from the first source that has one:
//   1. the verified sign-in token (name, or given + family name, top level or `custom`),
//   2. the person's Entra user in the latest complete snapshot (mail, sign-in name or
//      other emails match the sign-in email),
//   3. the identity the sign-in service reports for the same token.
// It only ever fills an empty name; a name an admin set is never overwritten.

const EMAIL = /^[^\s@]+@[^\s@]+$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const MAX_LENGTH = 100;

/** A usable display name, or null: trimmed, short, printable and not an email. */
export function cleanDisplayName(value) {
  if (typeof value !== 'string') return null;
  const name = value.replace(/\s+/g, ' ').trim();
  if (!name || name.length > MAX_LENGTH || CONTROL.test(name) || EMAIL.test(name)) return null;
  return name;
}

function fromObject(source) {
  if (!source || typeof source !== 'object') return null;
  const direct = cleanDisplayName(source.name) ?? cleanDisplayName(source.displayName) ?? cleanDisplayName(source.display_name);
  if (direct) return direct;
  const given = cleanDisplayName(source.given_name ?? source.givenName);
  const family = cleanDisplayName(source.family_name ?? source.familyName ?? source.surname);
  return given || family ? cleanDisplayName([given, family].filter(Boolean).join(' ')) : null;
}

/** The person's name from sign-in claims or an identity document, or null. */
export function nameFromClaims(claims) {
  if (!claims || typeof claims !== 'object') return null;
  return fromObject(claims) ?? fromObject(claims.custom);
}

/**
 * The display name of the Entra user whose mail, sign-in name or other emails match
 * `email`, read from the tenant's latest complete snapshot that holds users.
 */
export async function entraDisplayName(client, { tenantRef, email }) {
  if (!tenantRef || typeof email !== 'string' || !email.trim()) return null;
  const { rows } = await client.query(
    `WITH latest AS (
       SELECT s.id
         FROM snapshot s
        WHERE s.tenant_ref = $1 AND s.status = 'complete' AND s.completed_at IS NOT NULL
          AND EXISTS (SELECT 1 FROM resource_version u WHERE u.snapshot_id = s.id AND u.resource_type = 'user')
        ORDER BY s.completed_at DESC
        LIMIT 1
     )
     SELECT rv.payload->>'displayName' AS name
       FROM resource_version rv
      WHERE rv.snapshot_id = (SELECT id FROM latest)
        AND rv.resource_type = 'user'
        AND (lower(rv.payload->>'mail') = $2
          OR lower(rv.payload->>'userPrincipalName') = $2
          OR EXISTS (
            SELECT 1
              FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(rv.payload->'otherMails') = 'array' THEN rv.payload->'otherMails' ELSE '[]'::jsonb END) AS other(address)
             WHERE lower(other.address) = $2))
      ORDER BY rv.natural_key
      LIMIT 1`,
    [tenantRef, email.trim().toLowerCase()],
  );
  return cleanDisplayName(rows[0]?.name);
}

/** Sets the principal's display name only while it has none. True when it was set. */
export async function fillMissingDisplayName(client, principalId, value) {
  const name = cleanDisplayName(value);
  if (!name || typeof principalId !== 'string' || !principalId) return false;
  const { rowCount } = await client.query(
    `UPDATE principal SET display_name = $2
      WHERE id::text = $1 AND (display_name IS NULL OR btrim(display_name) = '')`,
    [principalId, name],
  );
  return rowCount > 0;
}

/**
 * Fills a nameless principal's display name from the first source that has one.
 * `lookupIdentity` is the last, slowest source (a network call) and is only asked when
 * the token and the directory have no name. Answers the name it set, or null.
 * @param {any} client
 * @param {{ principalId: string, email: string, tenantRef?: string | null, claims?: Record<string, unknown> | null, lookupIdentity?: (() => Promise<Record<string, unknown> | null>) | null }} options
 * @returns {Promise<string | null>}
 */
export async function learnDisplayName(client, { principalId, email, tenantRef = null, claims = null, lookupIdentity = null }) {
  let name = nameFromClaims(claims);
  if (!name && tenantRef) name = await entraDisplayName(client, { tenantRef, email });
  if (!name && lookupIdentity) name = nameFromClaims(await lookupIdentity());
  if (!name) return null;
  return (await fillMissingDisplayName(client, principalId, name)) ? name : null;
}
