// The audit record's check, in one place for the Overview, the menu, Activity and
// Integrations (Codex review P0-02, backlog C6). Two problems must never share words:
// "Failed the check" (the record's own chain or its off-site checkpoint does not match:
// red, Urgent) and "Not checked: no off-site copy" (nothing to compare it with: amber,
// Check soon). A missing off-site copy must never hide a broken chain. Pure, so client
// components can use it; the server-side check is checkAuditRecord in lib/evidence.ts.
//
// A third state, "Known break, explained" (amber, Check soon): the own chain is intact
// except a stretch a Keel bug broke, which an explanation record names (engine
// CHAIN_BREAK_EXPLAINED; the 31 Oct 2026 accept bug, PR #876). Any break the explanation
// does not cover is still "Failed the check".
import type { ChainIntegrity, KnownBreak } from "@/lib/evidence";

export type AuditCheck = "intact" | "known" | "unchecked" | "failed" | "unknown";

export const AUDIT_CHECK_WORDS = {
  failed: {
    label: "Failed the check",
    title: "The audit record failed the check",
    detail: "Who-did-what entries cannot be trusted until this is investigated.",
  },
  known: {
    label: "Known break, explained",
    title: "The audit record has a known break, explained",
    detail: "A Keel bug, since fixed, linked some entries to the wrong earlier entry. The break is recorded and explained, and every other entry checks out.",
  },
  unchecked: {
    label: "Not checked: no off-site copy",
    title: "The audit record is not checked: no off-site copy",
    detail: "Its own chain of entries is intact, but Keel cannot compare it with an off-site copy until one is set up.",
  },
} as const;

/** Where both problems are explained and the entries listed. */
export const AUDIT_RECORD_HREF = "/activity?show=records";

/**
 * The check as one of five states. A broken own chain outranks a known break, and a
 * known break outranks a missing off-site copy (both amber; the known break says more).
 */
export function auditCheckOf(integrity: ChainIntegrity | null): AuditCheck {
  if (integrity === null) return "unknown";
  if (integrity.ownChain === "broken") return "failed";
  if (!integrity.ok && integrity.status !== "unanchored") return "failed";
  if (integrity.knownBreaks?.length) return "known";
  if (integrity.ok) return "intact";
  return "unchecked";
}

/** "31 Oct 2026", the day a known break happened, or null when the record has no time. */
export function knownBreakDay(known: KnownBreak): string | null {
  const at = known.firstBreakAt ?? known.explainedAt;
  const time = at ? Date.parse(at) : Number.NaN;
  return Number.isFinite(time)
    ? new Date(time).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })
    : null;
}

/** The plain lines behind "Show details" for each known break. */
export function knownBreakLines(known: KnownBreak[]): string[] {
  return known.flatMap((item) => {
    const day = knownBreakDay(item);
    const count = item.breakCount.toLocaleString("en-GB");
    return [
      `${day ? `On ${day}, ` : ""}${count} ${item.breakCount === 1 ? "entry was" : "entries were"} linked to the wrong earlier entry.`,
      `Cause: ${(item.cause ?? "a Keel bug").replace(/\.$/, "")}.${item.fixRef ? ` Fixed by ${item.fixRef}.` : ""}`,
      "No entry was changed or removed. Any break outside this stretch still fails the check.",
    ];
  });
}

/** The Overview's and the menu's state: its own chain, then the off-site check when known. */
export function dashboardAuditCheck(evidence: { ok: boolean; check?: AuditCheck } | null | undefined): AuditCheck {
  if (!evidence) return "unknown";
  if (!evidence.ok) return "failed";
  return evidence.check ?? "unknown";
}
