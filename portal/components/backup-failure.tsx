import Link from "next/link";

import { Icon } from "@/components/shell/icons";
import type { FailureReason } from "@/lib/backup-failure";

// Why a kind's last backup failed, and, when Microsoft wants a permission or admin role
// Keel's backup app lacks, a link to each one on Setup (portal audit, issue 10).

export function FailureNeeds({ reason }: { reason: FailureReason }) {
  if (!reason.needs.length) return null;
  return (
    <span className="bf-needs">
      {reason.needs.map((need) => (
        <Link className="bf-need" href={need.href} key={`${need.type}:${need.name}`} title={need.words ? `${need.words}: open it on Setup` : "Open it on Setup"}>
          <Icon name={need.type === "role" ? "person" : "settings"} />
          <code>{need.name}</code>
          <span className="visually-hidden"> on Setup</span>
        </Link>
      ))}
    </span>
  );
}

/** The reason in one line, with its fix links. `compact` drops the icon, for list rows. */
export function FailureLine({ reason, compact = false }: { reason: FailureReason; compact?: boolean }) {
  return (
    <span className="bf-line" data-tone={reason.tone}>
      {compact ? null : <Icon name={reason.needs.length ? "x-circle" : "alert"} />}
      <span className="bf-text">{reason.text}</span>
      <FailureNeeds reason={reason} />
    </span>
  );
}
