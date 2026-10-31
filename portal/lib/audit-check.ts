// The audit record's check, in one place for the Overview, the menu, Activity and
// Integrations (Codex review P0-02, backlog C6). Two problems must never share words:
// "Failed the check" (the record's own chain or its off-site checkpoint does not match:
// red, Urgent) and "Not checked: no off-site copy" (nothing to compare it with: amber,
// Check soon). A missing off-site copy must never hide a broken chain. Pure, so client
// components can use it; the server-side check is checkAuditRecord in lib/evidence.ts.
import type { ChainIntegrity } from "@/lib/evidence";

export type AuditCheck = "intact" | "unchecked" | "failed" | "unknown";

export const AUDIT_CHECK_WORDS = {
  failed: {
    label: "Failed the check",
    title: "The audit record failed the check",
    detail: "Who-did-what entries cannot be trusted until this is investigated.",
  },
  unchecked: {
    label: "Not checked: no off-site copy",
    title: "The audit record is not checked: no off-site copy",
    detail: "Its own chain of entries is intact, but Keel cannot compare it with an off-site copy until one is set up.",
  },
} as const;

/** Where both problems are explained and the entries listed. */
export const AUDIT_RECORD_HREF = "/activity?show=records";

/** The check as one of four states. A broken own chain outranks a missing off-site copy. */
export function auditCheckOf(integrity: ChainIntegrity | null): AuditCheck {
  if (integrity === null) return "unknown";
  if (integrity.ownChain === "broken") return "failed";
  if (integrity.ok) return "intact";
  if (integrity.status === "unanchored") return "unchecked";
  return "failed";
}

/** The Overview's and the menu's state: its own chain, then the off-site check when known. */
export function dashboardAuditCheck(evidence: { ok: boolean; check?: AuditCheck } | null | undefined): AuditCheck {
  if (!evidence) return "unknown";
  if (!evidence.ok) return "failed";
  return evidence.check ?? "unknown";
}
