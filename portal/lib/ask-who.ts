import { ATTRIBUTION_BADGES, attributionNextStep, attributionSentence, attributionSummary } from "@/components/change-attribution";
import type { AskWho } from "@/lib/ask-view";
import type { ChangeAttribution } from "@/lib/types";

// Who made a change an Ask answer lists, in the Changes page's words: a confirmed or
// likely person with the audit log that names them, else why Keel cannot tell and what
// to do. Kept out of lib/ask-view.ts so the records table does not load these sentences.
export function askWho(attribution: Omit<ChangeAttribution, "route">): AskWho {
  const full: ChangeAttribution = { ...attribution, route: null };
  const known = attribution.verdict !== "unknown" && attribution.actors.length > 0;
  return {
    verdict: known ? attribution.verdict : "unknown",
    label: ATTRIBUTION_BADGES[known ? attribution.verdict : "unknown"].label,
    text: known ? attributionSummary(full) : attributionSentence(full),
    detail: known ? null : attributionNextStep(full),
  };
}
