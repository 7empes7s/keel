import { exceptionRefusal } from "@/lib/compliance-view";

// The one call the Compliance page makes, in its own module so a test can check the
// control reaches its route without a React harness.

export interface NewException { evaluationId: string; owner: string; reason: string; expiresAt: string }

export type ExceptionResult = { ok: true } | { ok: false; reason: string };

export async function grantException(body: NewException): Promise<ExceptionResult> {
  try {
    const response = await fetch("/api/actions/compliance/exception", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify(body),
    });
    if (response.ok) return { ok: true };
    const answer = (await response.json().catch(() => ({}))) as { error?: string };
    return { ok: false, reason: exceptionRefusal(response.status, answer.error) };
  } catch {
    return { ok: false, reason: exceptionRefusal(0, undefined) };
  }
}

/** A day from the date field as the end of that day, UTC. */
export function endOfDay(day: string): string | null {
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? `${day}T23:59:59.000Z` : null;
}

/** "2026-10-21" plus a number of days. */
export function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
