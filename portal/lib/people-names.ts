import { readNamer } from "../../engine/insights/anonymity.mjs";
import { displayPerson } from "../../engine/insights/people.mjs";
import type { EngineRef } from "@/lib/sentences";

// "Hide people's names" (Track A3) for code that reads people straight from the
// principal table instead of through resolvePrincipals / principalRefs. Read the namer
// once per request, then pass each row or stored account value through it. The namer
// is null while names are shown, and then everything comes back unchanged.

export type Namer = ((key: string) => string) | null;

interface QueryClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

const EMAIL = /@/;

/** The current namer (null while names are shown). */
export async function peopleNamer(client: QueryClient): Promise<Namer> {
  return (await readNamer(client)) as Namer;
}

/** A principal row ({ id, email, display_name, system_kind? }) as a person reference, code-named when names are hidden. */
export function principalPerson(row: Record<string, unknown>, namer: Namer): EngineRef {
  const ref: EngineRef = {
    kind: "person",
    id: String(row.id),
    name: (row.display_name as string | null | undefined) || null,
    email: (row.email as string | null | undefined) ?? null,
    readable: true,
    system: row.system_kind != null,
  };
  return displayPerson(ref, namer) as EngineRef;
}

/** A person reference ({ id, email, name, readable }) as shown: code-named when names are hidden. */
export function shownPerson<T extends { id: string; email?: string | null; name: string | null; readable: boolean }>(ref: T, namer: Namer): T {
  return (namer ? displayPerson({ kind: "person", system: false, ...ref }, namer) : ref) as T;
}

/**
 * A stored account value typed or recorded as an email address (an exception owner, an
 * estimate owner, a requester): its code name when names are hidden. The key is the
 * same as a Keel user's (the lowercased email), so one person keeps one code name.
 */
export function shownAccount<T extends string | null | undefined>(value: T, namer: Namer): T | string {
  if (!namer || typeof value !== "string" || !value.trim()) return value;
  return EMAIL.test(value) ? namer(value.trim().toLowerCase()) : value;
}

/** A person typed by name or address (not a Keel account): always a code name when names are hidden. */
export function shownTypedPerson<T extends string | null | undefined>(value: T, namer: Namer): T | string {
  if (!namer || typeof value !== "string" || !value.trim()) return value;
  return namer(value.trim().toLowerCase());
}
