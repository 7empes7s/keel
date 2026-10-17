import Link from "next/link";

import { Icon, type IconName } from "@/components/shell/icons";

// Portal experience contract, the verdict layer: one plain sentence of at most 25
// words, one tone and at most one primary action. Exactly one per page. Shared frame
// pick A: the whole band takes a soft tint of its tone, with an icon, so the colour
// is never the only signal. The older tone names map onto the risk words.
export type VerdictTone = "urgent" | "soon" | "low" | "fine" | "neutral" | "good" | "attention" | "critical";
type RiskWord = "urgent" | "soon" | "low" | "fine" | "neutral";

const RISK: Record<VerdictTone, RiskWord> = {
  urgent: "urgent", soon: "soon", low: "low", fine: "fine", neutral: "neutral",
  critical: "urgent", attention: "soon", good: "fine",
};

const ICONS: Record<RiskWord, IconName> = { urgent: "alert", soon: "clock", low: "info", fine: "check-circle", neutral: "info" };

export function Verdict({ text, tone = "good", headline, detail, icon, action }: {
  text: string;
  tone?: VerdictTone;
  headline?: string;
  detail?: string;
  icon?: IconName;
  action?: { label: string; href: string } | null;
}) {
  const risk = RISK[tone];
  return (
    <section className={`verdict verdict-${risk}`} data-layer="verdict" data-tone={risk}>
      <span aria-hidden="true" className="verdict-icon"><Icon name={icon ?? ICONS[risk]} /></span>
      <div className="verdict-body">
        {headline ? <h2 className="verdict-headline">{headline}</h2> : null}
        <p className="verdict-sentence">{text}</p>
        {detail ? <p className="verdict-detail">{detail}</p> : null}
      </div>
      {action ? <Link className="btn btn-primary primary" href={action.href}>{action.label}</Link> : null}
    </section>
  );
}
