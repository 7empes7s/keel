import Link from "next/link";

import { Icon, type IconName } from "@/components/shell/icons";
import type { FeedNextStep, FeedNextStepKind } from "@/lib/change-feed-view";

// One feed row's next step (engine/insights/nextSteps.mjs), as one line: what to do or how it
// was dealt with, and a link when there is a page for it. Shared by Changes › Every change
// and Insights' "Where to start". Deciding happens only under Open changes: this line links
// there and never shows Accept or Undo controls itself.

const ICONS: Record<FeedNextStepKind, IconName> = {
  accepted: "check-circle",
  ignored: "eye-off",
  undone: "restore",
  decide: "baselines",
  restore: "restore",
  site: "service-sharepoint",
  onedrive: "info",
  audit: "audit",
  closed: "check",
};

export function NextStep({ step }: { step: FeedNextStep | null | undefined }) {
  if (!step) return null;
  return (
    <>
      <style href="keel-next-step" precedence="default">{CSS}</style>
      <span className="ns-step" data-dealt={step.dealtWith || undefined} data-kind={step.kind}>
        <Icon name={ICONS[step.kind] ?? "info"} />
        <span className="ns-text">
          <span>{step.text}</span>
          {step.alert ? <span className="ns-alert"> {step.alert.text}</span> : null}
          {step.link ? <> <Link className="ns-link" href={step.link.href}>{step.link.label}</Link></> : null}
        </span>
      </span>
    </>
  );
}

const CSS = `
.ns-step { display: flex; align-items: flex-start; gap: var(--space-2xs); margin-top: var(--space-2xs); color: var(--text-soft); font-size: 0.8125rem; line-height: 1.4; min-width: 0; }
.ns-step > .icon { flex: none; width: 0.875rem; height: 0.875rem; margin-top: 0.15em; }
.ns-step[data-kind="decide"], .ns-step[data-kind="restore"] { color: var(--text); }
.ns-step[data-dealt] > .icon { color: var(--fine, var(--low-risk)); }
.ns-text { min-width: 0; overflow-wrap: anywhere; }
.ns-link { font-weight: 600; }
`;
