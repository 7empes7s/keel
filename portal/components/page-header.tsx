import { Suspense, type ReactNode } from "react";

import { SECTION_ICONS, type NavSection } from "@/components/nav-links";
import { Icon, type IconName } from "@/components/shell/icons";
import { PageActions } from "@/components/shell/page-actions";
import type { RiskTone } from "@/lib/menu-status";
import { formatTimestamp } from "@/lib/presentation";

const STATUS_ICONS: Record<RiskTone, IconName> = { urgent: "alert", soon: "clock", low: "info", fine: "check" };

// The page frame's header (direction A): the title, a status pill when the page has a
// verdict, and one plain sentence. `section` is the menu section the page sits in,
// typed so no page can carry a second taxonomy (portal/test/experience-contract.test.ts
// checks each page passes the section that owns its route); it gives a starred page
// its icon. The section's name is not repeated above the title: the menu shows it.
export function PageHeader({
  section,
  title,
  description,
  generatedAt,
  marker,
  status,
  actions,
}: {
  section: NavSection;
  title: string;
  description: string;
  generatedAt?: string;
  marker?: string;
  status?: { tone: RiskTone; label: string };
  // The page's own control beside the star, such as "Back up now".
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div className="page-title-row">
        <h1>{title}</h1>
        {status ? (
          <span className="status-pill" data-tone={status.tone}>
            <Icon name={STATUS_ICONS[status.tone]} />
            {status.label}
          </span>
        ) : null}
        {marker ? <span className="mode-marker">{marker}</span> : null}
        <Suspense fallback={null}>
          <PageActions icon={SECTION_ICONS[section]} title={title} />
        </Suspense>
        {actions ? <div className="page-header-actions">{actions}</div> : null}
      </div>
      <p className="page-description">{description}</p>
      {generatedAt ? (
        <p className="as-of">
          Data as of <time dateTime={generatedAt}>{formatTimestamp(generatedAt)}</time>
        </p>
      ) : null}
    </header>
  );
}
