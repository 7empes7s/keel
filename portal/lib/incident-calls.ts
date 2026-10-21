import { failureWords } from "@/lib/incidents-view";

// The calls the Incidents page makes, in their own module so a test can check each
// control reaches its route without a React harness. Every write sends its own
// idempotency key; keeping several backups sends one call (and one key) per backup.

export type IncidentOp = "open" | "close" | "interval" | "assess" | "override" | "revoke-override" | "pin" | "release";

export type IncidentResult = { ok: true; body: Record<string, unknown> } | { ok: false; reason: string };

export async function incidentAction(op: IncidentOp, body: Record<string, unknown>): Promise<IncidentResult> {
  try {
    const response = await fetch("/api/actions/incidents", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ op, ...body }),
    });
    const answer = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (response.ok) return { ok: true, body: answer };
    return { ok: false, reason: failureWords(response.status, typeof answer.message === "string" ? answer.message : null) };
  } catch {
    return { ok: false, reason: "Keel could not be reached. Try again in a moment." };
  }
}

export interface BackupItem { naturalKey: string; resourceType: string; name?: string | null }

/** The items one backup holds, for the "leave out" picker; null when they cannot be read. */
export async function loadBackupItems(snapshotId: string): Promise<BackupItem[] | null> {
  try {
    const response = await fetch(`/api/snapshots/${encodeURIComponent(snapshotId)}/items`);
    if (!response.ok) return null;
    const body = (await response.json()) as { resources?: BackupItem[] };
    return Array.isArray(body.resources) ? body.resources : null;
  } catch {
    return null;
  }
}

/** A date ("2026-09-30") and a 24-hour time ("22:40") read as UTC, or null. */
export function utcInstant(day: string | null | undefined, time: string | null | undefined): string | null {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const clock = (time ?? "").trim() || "00:00";
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(clock);
  if (!match) return null;
  const value = new Date(`${day}T${match[1].padStart(2, "0")}:${match[2]}:00Z`);
  return Number.isNaN(value.getTime()) ? null : value.toISOString();
}
