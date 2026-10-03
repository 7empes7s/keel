import Link from "next/link";

import type { DashboardAlert, ProtectionHeadline } from "@/lib/types";

// Portal experience contract, Overview verdict: one headline word, one sentence (the
// memorable number from the engine), one tone and at most one primary action. Alerts
// can only make the tone worse; they never replace the number, and the hedge of what
// was and was not checked lives in the record layer.
export type VerdictTone = "good" | "attention" | "critical";

const TONE_RANK: Record<VerdictTone, number> = { good: 0, attention: 1, critical: 2 };

export function overviewVerdict(headline: ProtectionHeadline, alerts: DashboardAlert[]): {
  tone: VerdictTone; headline: string; sentence: string; action: ProtectionHeadline["action"];
} {
  const critical = alerts.some((alert) => alert.severity === "critical");
  const warning = alerts.some((alert) => alert.severity === "warning");
  const alertTone: VerdictTone = critical ? "critical" : warning ? "attention" : "good";
  const tone = TONE_RANK[alertTone] > TONE_RANK[headline.tone] ? alertTone : headline.tone;
  return {
    tone,
    headline: critical && headline.state !== "collection" ? "Action needed" : headline.headline,
    sentence: headline.sentence,
    action: headline.action,
  };
}

export function OverviewVerdict({ headline, alerts }: { headline: ProtectionHeadline; alerts: DashboardAlert[] }) {
  const verdict = overviewVerdict(headline, alerts);
  return (
    <section aria-labelledby="verdict-heading" className={`verdict verdict-${verdict.tone}`} data-layer="verdict">
      <div>
        <h2 className="verdict-headline" id="verdict-heading">{verdict.headline}</h2>
        <p className="verdict-sentence">{verdict.sentence}</p>
      </div>
      {verdict.action ? <Link className="btn btn-primary primary" href={verdict.action.href}>{verdict.action.label}</Link> : null}
    </section>
  );
}
