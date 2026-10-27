import { resolvePrincipals } from "../../engine/govern/references.mjs";
import { readNamer } from "../../engine/insights/anonymity.mjs";
import { displayPerson } from "../../engine/insights/people.mjs";
import { connect } from "@/lib/db";

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

export async function getActivityNames(actors: string[], keys: (string | null)[]): Promise<ActivityNames> {
  const result: ActivityNames = { people: {}, names: {} };
  const client = (await connect(databaseUrl())) as KeelClient;
  try {
    try {
      const people = (await resolvePrincipals(client, actors)) as Map<string, EngineRef>;
      // An actor recorded by email only becomes a person here, so it is code-named here
      // too when "Hide people's names" is on.
      const namer = await readNamer(client);
      result.people = Object.fromEntries([...people].map(([id, ref]) => [id, displayPerson(asPerson(ref), namer) as EngineRef]));
    } catch (error) {
      console.error("[keel-portal] activity people unavailable", error);
    }
    try {
      result.names = await savedNames(client, tenantRef(), keys);
    } catch (error) {
      console.error("[keel-portal] activity names unavailable", error);
    }
  } finally {
    await client.end();
  }
  return result;
}
