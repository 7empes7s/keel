import { resolvePrincipals } from "../../engine/govern/references.mjs";
import { readNamer } from "../../engine/insights/anonymity.mjs";
import { displayPerson } from "../../engine/insights/people.mjs";
import { connect } from "@/lib/db";

import type { EvidenceEntry } from "@/lib/evidence";
import type { NamedKeys } from "@/lib/job-names";
import { databaseUrl, tenantRef } from "@/lib/runtime-config";
import { savedNames } from "@/lib/saved-names";
import type { EngineRef } from "@/lib/sentences";

// Names, not ids, on the Activity page: who did each audit-record entry, and the saved
// name of the object an entry is about. Each part fails on its own, so a failed lookup
// leaves that part unnamed rather than the page down.

interface KeelClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

export interface ActivityNames {
  people: Record<string, EngineRef>;
  names: NamedKeys;
  // The audit entries as the page may show them: with "Hide people's names" on, an
  // actor recorded by email and any address or owner inside a subject are code names.
  entries?: EvidenceEntry[];
}

type Namer = (key: string) => string;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE_NAME = /^Person [A-HJ-NP-Z2-9]{4}$/;
const ADDRESS = /[^\s@]+@[^\s@]+/;
// A real address only: a key prefix such as "user:" or a trailing full stop is not part of it.
const ADDRESSES = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

/** A subject with every email address, and every typed owner, replaced by a code name. */
export function hideSubject(value: unknown, namer: Namer, field = ""): unknown {
  if (typeof value === "string") {
    if (field === "owner" && value.trim() && !UUID.test(value.trim())) return namer(value.trim().toLowerCase());
    return ADDRESS.test(value) ? value.replace(ADDRESSES, (address) => namer(address.toLowerCase())) : value;
  }
  if (Array.isArray(value)) return value.map((item) => hideSubject(item, namer));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, hideSubject(item, namer, key)]));
  return value;
}

/** Entries as shown while names are hidden: actors recorded by email become their code names. */
export function hideEntries(entries: EvidenceEntry[], people: Record<string, EngineRef>, namer: Namer): { entries: EvidenceEntry[]; people: Record<string, EngineRef> } {
  const shownPeople = { ...people };
  const shown = entries.map((entry) => {
    const ref = people[entry.actor];
    const actor = EMAIL.test(entry.actor.trim()) ? (ref?.pseudonym ? ref.name ?? namer(entry.actor.trim().toLowerCase()) : namer(entry.actor.trim().toLowerCase())) : entry.actor;
    if (actor !== entry.actor && ref) shownPeople[actor] = ref;
    return { ...entry, actor, subject: hideSubject(entry.subject, namer) };
  });
  for (const actor of Object.keys(people)) if (EMAIL.test(actor.trim())) delete shownPeople[actor];
  return { entries: shown, people: shownPeople };
}

/**
 * The stored actors a "Who" filter stands for. While names are hidden the filter holds
 * code names, so each one is matched back to the actors recorded by email that carry it.
 */
export async function actorsForFilter(who: string[]): Promise<string[]> {
  if (!who.some((value) => CODE_NAME.test(value))) return who;
  const client = (await connect(databaseUrl())) as KeelClient;
  try {
    const namer = (await readNamer(client)) as Namer | null;
    if (!namer) return who;
    const { rows } = await client.query("SELECT DISTINCT actor FROM evidence WHERE strpos(actor, '@') > 0");
    const actors = who.filter((value) => !CODE_NAME.test(value));
    for (const row of rows) {
      const actor = String(row.actor);
      if (who.includes(namer(actor.trim().toLowerCase()))) actors.push(actor);
    }
    // A code name nobody carries still narrows to nothing rather than to everyone.
    return actors.length ? [...new Set(actors)] : who;
  } finally {
    await client.end();
  }
}

/** The object key an audit-record entry is about, when it names one. */
export function entrySubjectKey(subject: unknown): string | null {
  const key = (subject as { naturalKey?: unknown } | null | undefined)?.naturalKey;
  return typeof key === "string" && key ? key : null;
}

const EMAIL = /^[^\s@]+@[^\s@]+$/;

/** An actor recorded by email address is a person, not one of Keel's own accounts. */
export function asPerson(ref: EngineRef): EngineRef {
  return ref.system && ref.readable && EMAIL.test(ref.id) ? { ...ref, email: ref.id, system: false } : ref;
}

export async function getActivityNames(actors: string[], keys: (string | null)[], entries: EvidenceEntry[] = []): Promise<ActivityNames> {
  const result: ActivityNames = { people: {}, names: {} };
  const client = (await connect(databaseUrl())) as KeelClient;
  try {
    // "Hide people's names": read first, so a failed people lookup still hides addresses.
    const namer = (await readNamer(client)) as Namer | null;
    try {
      const people = (await resolvePrincipals(client, actors)) as Map<string, EngineRef>;
      // An actor recorded by email only becomes a person here, so it is code-named here
      // too when "Hide people's names" is on.
      result.people = Object.fromEntries([...people].map(([id, ref]) => [id, displayPerson(asPerson(ref), namer) as EngineRef]));
      // A "Who" filter by code name is a person, not one of Keel's own accounts.
      if (namer) for (const actor of actors) if (CODE_NAME.test(actor)) result.people[actor] = { kind: "person", id: actor, name: actor, readable: true, system: false, pseudonym: true };
    } catch (error) {
      console.error("[keel-portal] activity people unavailable", error);
    }
    try {
      result.names = await savedNames(client, tenantRef(), keys);
    } catch (error) {
      console.error("[keel-portal] activity names unavailable", error);
    }
    if (namer) {
      Object.assign(result, hideEntries(entries, result.people, namer));
      // An object key that held an address is now written with a code name: keep its saved name.
      for (const key of Object.keys(result.names)) {
        const hidden = hideSubject(key, namer) as string;
        if (hidden !== key) { result.names[hidden] = result.names[key]; delete result.names[key]; }
      }
    }
  } finally {
    await client.end();
  }
  return result;
}

/**
 * When the names lookup failed and names may be hidden (the setting is on, or could not
 * be read), addresses are blanked rather than sent: fail closed, never open.
 */
export function hideAddresses(entries: EvidenceEntry[]): EvidenceEntry[] {
  const blank = () => "a person";
  return entries.map((entry) => ({ ...entry, actor: EMAIL.test(entry.actor.trim()) ? "a person" : entry.actor, subject: hideSubject(entry.subject, blank) }));
}
