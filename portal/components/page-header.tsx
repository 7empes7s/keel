import Link from "next/link";
import { Suspense, type ReactNode } from "react";

import { Icon, type IconName } from "@/components/shell/icons";
import { PageActions } from "@/components/shell/page-actions";
import type { RiskTone } from "@/lib/menu-status";
import { breadcrumbTrail, SECTION_ICONS, type Crumb, type NavSection } from "@/lib/nav-sections";
import { formatTimestamp } from "@/lib/presentation";

const STATUS_ICONS: Record<RiskTone, IconName> = { urgent: "alert", soon: "clock", low: "info", fine: "check" };

// The page frame's header (direction A): the title, a status pill when the page has a
// verdict, and one plain sentence. `section` is the menu section the page sits in,
// typed so no page can carry a second taxonomy (portal/test/experience-contract.test.ts
// checks each page passes the section that owns its route); it gives a starred page
// its icon. Above the title, a breadcrumb says where the page sits (Backup › Sites ›
// Finance), so a phone, where the menu is folded away, still shows it; a detail page
// passes the pages above it as `parents`, which replaces a lone "← All …" link.
export function PageHeader({
  section,
  title,
  description,
  generatedAt,
  marker,
  status,
  actions,
  parents,
}: {
  section: NavSection;
  title: string;
  description: string;
  generatedAt?: string;
  marker?: string;
  status?: { tone: RiskTone; label: string };
  // The page's own control beside the star, such as "Back up now".
  actions?: ReactNode;
  // The pages between the section and this one, nearest last: [{ href: "/sites", label: "Sites" }].
  parents?: readonly Crumb[];
}) {
  const trail = breadcrumbTrail(section, title, parents);
  return (
    <header className="page-header">
      {trail.length ? (
        <nav aria-label="Breadcrumb" className="breadcrumbs">
          <ol>
            {trail.map((crumb, index) => {
              const last = index === trail.length - 1;
              return (
                <li key={`${index}-${crumb.label}`}>
                  {index === 0 ? <Icon name={SECTION_ICONS[section]} /> : null}
                  {last ? (
                    <span aria-current="page" className="breadcrumb-current">{crumb.label}</span>
                  ) : crumb.href ? (
                    <Link className="breadcrumb-link" href={crumb.href} prefetch={false}>{crumb.label}</Link>
                  ) : (
                    <span className="breadcrumb-section">{crumb.label}</span>
                  )}
                </li>
              );
            })}
          </ol>
        </nav>
      ) : null}
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
