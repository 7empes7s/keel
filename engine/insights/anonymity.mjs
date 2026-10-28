// engine/insights/anonymity.mjs
//
// Redesign Track A3 (IN-ANON): the "Hide people's names" setting. Read it with
// readAnonymity, turn it into a namer with anonymityNamer, and pass that namer to
// displayPerson / displayActor (./people.mjs). Only an admin changes it (the portal
// route checks the `users` capability), and each change is written to the audit record.
import { createHmac, randomBytes } from 'node:crypto';

import { appendEvidence } from '../govern/evidence.mjs';
import { PSEUDONYM_PREFIX } from './people.mjs';

export const ANONYMITY_EVIDENCE_KIND = 'people-anonymity';

// No 0/O or 1/I, so a code name reads back without mistakes.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 4;

/** A stable code name for one person: the same salt and key always give the same name. */
export function pseudonym(salt, key) {
  const digest = createHmac('sha256', String(salt)).update(String(key).trim().toLowerCase()).digest();
  let code = '';
  for (let index = 0; index < CODE_LENGTH; index += 1) code += ALPHABET[digest[index] % ALPHABET.length];
  return `${PSEUDONYM_PREFIX} ${code}`;
}

/** The setting as stored; off when it was never set. The salt never leaves the engine. */
export async function readAnonymity(client) {
  const result = await client.query('SELECT enabled, salt, changed_at, changed_by FROM people_anonymity WHERE id');
  const row = result?.rows?.[0];
  if (!row) return { enabled: false, salt: null, changedAt: null, changedBy: null };
  return { enabled: row.enabled === true, salt: row.salt, changedAt: row.changed_at, changedBy: row.changed_by };
}

/** A namer for displayPerson / displayActor, or null when names are shown. */
export function anonymityNamer(state) {
  if (!state?.enabled || !state.salt) return null;
  const cache = new Map();
  return (key) => {
    if (!cache.has(key)) cache.set(key, pseudonym(state.salt, key));
    return cache.get(key);
  };
}

/** The current namer straight from the database (null when names are shown). */
export async function readNamer(client) {
  return anonymityNamer(await readAnonymity(client));
}

/**
 * Turn the setting on or off. Writes the audit record first, so a change is never made
 * without one. Returns the new state and whether anything changed.
 */
export async function setAnonymity(client, { tenantRef, enabled, actor }) {
  if (typeof enabled !== 'boolean') throw new TypeError('enabled must be true or false');
  if (typeof actor !== 'string' || !actor) throw new TypeError('actor is required');
  const before = await readAnonymity(client);
  if (before.enabled === enabled) return { changed: false, state: before };
  await appendEvidence(client, {
    tenantRef,
    kind: ANONYMITY_EVIDENCE_KIND,
    subject: { setting: 'hide-people-names', enabled, previous: before.enabled },
    actor,
  });
  // The salt is made once and kept, so code names stay the same across on and off.
  await client.query(
    `INSERT INTO people_anonymity (id, enabled, salt, changed_at, changed_by)
     VALUES (true, $1, $2, now(), $3)
     ON CONFLICT (id) DO UPDATE SET enabled = EXCLUDED.enabled, changed_at = EXCLUDED.changed_at, changed_by = EXCLUDED.changed_by`,
    [enabled, randomBytes(24).toString('hex'), actor],
  );
  return { changed: true, state: await readAnonymity(client) };
}
