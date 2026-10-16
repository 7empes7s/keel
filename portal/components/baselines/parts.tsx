import type { ReactNode } from "react";

import { Icon, type IconName } from "@/components/shell/icons";
import type { RiskTone } from "@/lib/menu-status";

const TONE_ICONS: Record<RiskTone, IconName> = { urgent: "alert", soon: "clock", low: "info", fine: "check" };

/** The one chip style: a risk colour, its icon and a plain word. */
export function RiskChip({ tone, children }: { tone: RiskTone | null; children: string }) {
  return (
    <span className="bl-chip" data-tone={tone ?? undefined}>
      {tone ? <Icon name={TONE_ICONS[tone]} /> : null}
      {children}
    </span>
  );
}

/** A heading with one plain line under it that says what the section is for. */
export function SectionHead({ id, title, about, extra }: { id: string; title: string; about: string; extra?: ReactNode }) {
  return (
    <div className="bl-section-head">
      <div>
        <h2 id={id}>{title}</h2>
        <p>{about}</p>
      </div>
      {extra}
    </div>
  );
}
