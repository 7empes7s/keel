import { changeRefusal } from "@/lib/people-view";
import type { PrincipalView } from "@/lib/principals";

// The calls the People page makes, in one place, so a test can check each control
// reaches its route without a React harness. Every route is guarded: grant and revoke
// need the roles permission, add, disable and enable need users. The engine keeps at
// least one live admin and refuses with 403 "last_admin"; the words say so.

export type PersonChange =
  | { kind: "grant"; role: string; activeFrom?: string | null; activeUntil?: string | null; reason?: string | null }
  | { kind: "revoke"; grantId: string }
  | { kind: "disable" }
  | { kind: "enable" };

export type ChangeResult = { ok: true } | { ok: false; reason: string };

function post(path: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify(body),
  });
}

async function refusal(response: Response): Promise<string> {
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  return changeRefusal(response.status, body.error);
}

export async function changePerson(principalId: string, change: PersonChange): Promise<ChangeResult> {
  const { kind, ...body } = change;
  try {
    const response = await post(`/api/principals/${encodeURIComponent(principalId)}/${kind}`, body);
    return response.ok ? { ok: true } : { ok: false, reason: await refusal(response) };
  } catch {
    return { ok: false, reason: changeRefusal(0, undefined) };
  }
}

/** The body POST /api/principals takes (lib/principals.ts, guardedPrincipalCreate). */
export interface NewPerson { email: string; displayName?: string | null; role: string; activeUntil?: string | null; reason?: string | null }

export type CreateResult = { ok: true; person: PrincipalView | null } | { ok: false; reason: string };

export async function addPerson(person: NewPerson): Promise<CreateResult> {
  try {
    const response = await post("/api/principals", person as unknown as Record<string, unknown>);
    if (!response.ok) return { ok: false, reason: await refusal(response) };
    const body = (await response.json().catch(() => ({}))) as { principal?: PrincipalView };
    return { ok: true, person: body.principal ?? null };
  } catch {
    return { ok: false, reason: changeRefusal(0, undefined) };
  }
}

/** A date from a date field ("2026-11-03") as the end of that day, UTC. */
export function untilEndOf(day: string): string | null {
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? `${day}T23:59:59.000Z` : null;
}

/** A date from a date field as the start of that day, UTC; null for today or empty. */
export function fromStartOf(day: string, today: string): string | null {
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && day > today ? `${day}T00:00:00.000Z` : null;
}
