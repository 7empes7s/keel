// engine/insights/people.mjs
//
// Redesign Track A3 (IN-ANON): the one place a person's label is decided. With the
// "Hide people's names" setting on, a person is shown by a stable code name and their
// email is dropped; Keel's own accounts and apps keep their names, since they are not
// people. Pure and free of Node built-ins, so the portal's client code can use it too.
// The code name itself comes from `namer` (engine/insights/anonymity.mjs makes one).

export const PSEUDONYM_PREFIX = 'Person';

const EMAIL = /@/;

/** What identifies a person across pages: their email when known, else their id. */
export function personKey(ref) {
  const email = typeof ref?.email === 'string' ? ref.email.trim().toLowerCase() : '';
  if (email) return email;
  const id = typeof ref?.id === 'string' ? ref.id.trim().toLowerCase() : '';
  return id || null;
}

/**
 * A person reference as it may be shown. `namer` is null when names are shown, else a
 * function from personKey() to a code name. A code-named person keeps an account id
 * (for links and Technical details) and loses their email; an id that is itself an
 * email address is replaced by the code name.
 */
export function displayPerson(ref, namer) {
  // Already code-named (resolvePrincipals does it): naming again would key on the id,
  // since the email is gone, and give the same person a second code name.
  if (!ref || typeof namer !== 'function' || ref.system || ref.readable === false || ref.pseudonym) return ref;
  const key = personKey(ref);
  if (!key) return ref;
  const name = namer(key);
  return { ...ref, id: EMAIL.test(ref.id ?? '') ? name : ref.id, name, email: null, pseudonym: true };
}

/**
 * A stored account value (a job's requester, an audit entry's actor) for Technical
 * details: an email address is replaced by the person's code name when names are hidden.
 */
export function displayAccount(value, ref) {
  return ref?.pseudonym && typeof value === 'string' && EMAIL.test(value) ? ref.name : value;
}

/**
 * An account the Microsoft audit log names as having made a change. Users are people
 * and get a code name; apps (service principals) keep their names.
 */
export function displayActor(actor, namer) {
  if (!actor || typeof namer !== 'function' || actor.kind !== 'user') return actor;
  const key = (actor.id ?? '').toLowerCase() || (actor.name ?? '').trim().toLowerCase();
  if (!key) return actor;
  return { ...actor, name: namer(key), pseudonym: true };
}
