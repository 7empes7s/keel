import type { ReactNode } from "react";

import { Icon, type IconName } from "@/components/shell/icons";

// The portal's one status badge (shared frame, pick A: tinted with an icon). Colour
// means risk only: urgent red, soon amber, low blue, fine green, neutral grey. Words
// are sentence case; the icon means colour is never the only signal.
export type BadgeTone = "urgent" | "soon" | "low" | "fine" | "neutral";

export const BADGE_ICONS: Record<BadgeTone, IconName> = {
  urgent: "x-circle",
  soon: "clock",
  low: "info",
  fine: "check-circle",
  neutral: "info",
};

export function Badge({ tone, icon, children, className, title }: {
  tone: BadgeTone;
  icon?: IconName | null;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  const name = icon === undefined ? BADGE_ICONS[tone] : icon;
  return (
    <span className={className ? `badge ${className}` : "badge"} data-tone={tone} title={title}>
      {name ? <Icon name={name} /> : null}
      {children}
    </span>
  );
}
