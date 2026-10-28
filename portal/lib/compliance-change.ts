import { exceptionRefusal, fixRefusal } from "@/lib/compliance-view";
import { plainRefusal } from "@/lib/action-refusal";

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

/* ------------------------------------------------------------ make it pass -- */

export type FixStart = { ok: true; artifactId: string; jobId: string } | { ok: false; reason: string };

/** Asks Keel to plan the fix for one object of a failing control (a dry run only). */
export async function planFix(evaluationId: string, naturalKey: string): Promise<FixStart> {
  try {
    const response = await fetch("/api/actions/compliance/fix", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ evaluationId, naturalKey }),
    });
    const answer = (await response.json().catch(() => ({}))) as { error?: string; message?: string; artifactId?: string; job?: { id?: string } };
    if (response.ok && answer.artifactId && answer.job?.id) return { ok: true, artifactId: answer.artifactId, jobId: answer.job.id };
    return { ok: false, reason: plainRefusal(answer) ?? fixRefusal(response.status, answer.error) };
  } catch {
    return { ok: false, reason: fixRefusal(0, undefined) };
  }
}

export interface FixPlan {
  id: string;
  status: "completed" | "refused" | "failed";
  complianceFix: { field: string; from: unknown; to: unknown; naturalKey: string } | null;
  guardRefusals?: { naturalKey: string; reason: string }[];
}

export type FixProgress =
  | { state: "planning" }
  | { state: "planned"; plan: FixPlan }
  | { state: "failed"; message: string | null };

/** One look at a planned fix: its dry run once saved, or the job's failure. */
export async function readFixProgress(artifactId: string, jobId: string): Promise<FixProgress> {
  const planned = await fetch(`/api/actions/restore/dry-run/${encodeURIComponent(artifactId)}`, { cache: "no-store" });
  if (planned.ok) return { state: "planned", plan: ((await planned.json()) as { artifact: FixPlan }).artifact };
  if (planned.status !== 404) throw new Error(String(planned.status));
  const job = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`, { cache: "no-store" });
  if (!job.ok) throw new Error(String(job.status));
  const { job: row } = (await job.json()) as { job: { status: string; error: unknown } };
  if (row.status === "failed" || row.status === "dead" || row.status === "cancelled") {
    const error = row.error as { message?: string } | string | null;
    return { state: "failed", message: typeof error === "string" ? error : error?.message ?? null };
  }
  return { state: "planning" };
}

/** Sends the planned fix to the approvers (the normal restore confirmation). */
export async function askFixApproval(artifactId: string, justification: string): Promise<ExceptionResult> {
  try {
    const response = await fetch("/api/actions/restore", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": `restore:${artifactId}` },
      body: JSON.stringify({ artifactId, justification }),
    });
    if (response.ok) return { ok: true };
    return { ok: false, reason: response.status === 403 ? "You need the restore permission to ask for this." : "Keel could not send it to the approvers. Try again." };
  } catch {
    return { ok: false, reason: fixRefusal(0, undefined) };
  }
}
