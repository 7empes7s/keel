// Client-safe: the people a form lets you choose from, one entry per person.

export interface PersonChoice { id: string; name: string; email?: string | null }

/** One entry per person: two people with the same name keep their sign-in address as a
 *  hint (shown only when it is given, never while names are hidden), and a person listed
 *  twice under the same id is listed once. */
export function distinctPeople<T extends PersonChoice>(people: T[]): T[] {
  const seen = new Set<string>();
  const unique = people.filter((person) => (seen.has(person.id) ? false : (seen.add(person.id), true)));
  const counts = new Map<string, number>();
  for (const person of unique) counts.set(person.name.toLowerCase(), (counts.get(person.name.toLowerCase()) ?? 0) + 1);
  return unique.map((person) => ({ ...person, email: (counts.get(person.name.toLowerCase()) ?? 0) > 1 ? person.email ?? null : null }));
}
