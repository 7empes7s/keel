import type { IconName } from "@/components/shell/icons";

// The menu's sections and their icons, in a plain module so server components (the
// page header) can read them. A constant imported from a "use client" module is
// undefined on the server (portal/test/client-boundary.test.ts).

// Portal structure (handoff/redesign/PLAN.md section 7): under the cloud, eight
// sections, top to bottom, then the bell's inbox. Each section absorbs existing pages,
// which keep their routes and show as sub-items under the section in the menu (and as
// one scrolling row of tabs on a phone). A page's PageHeader names the section it sits
// in (`section`), typed, so no page can carry a second taxonomy.
export const MENU_SECTIONS = ["Dashboards", "Backup", "Restore", "Baselines", "Reports", "Automation center", "Audit log", "Settings"] as const;
// Approvals and alerts are not one of the eight: they head the menu as its own Inbox
// group (and stay behind the bell), so they are not listed again under Everything.
export const NAV_SECTIONS = [...MENU_SECTIONS, "Inbox"] as const;
export type MenuSection = (typeof MENU_SECTIONS)[number];
export type NavSection = (typeof NAV_SECTIONS)[number];

export const SECTION_ICONS: Record<NavSection, IconName> = {
  Dashboards: "dashboards",
  Backup: "backup",
  Restore: "restore",
  Baselines: "baselines",
  Reports: "reports",
  "Automation center": "automation",
  "Audit log": "audit",
  Settings: "settings",
  Inbox: "bell",
};

export interface NavCapabilities {
  canRead?: boolean;
  canPolicies?: boolean;
  canUsers?: boolean;
  canApprove?: boolean;
  canConfigure?: boolean;
  // Not a page gate: lets the search offer "Back up now" only to people who can.
  canBackup?: boolean;
}

export type Gate = keyof NavCapabilities | null;

interface SectionRoute {
  href: string;
  label: string;
  gate: Gate;
  // Former page and section names, still searchable in the command palette.
  aliases?: string;
  // A route that belongs to the section but is not a sub-item of its own (a redirect
  // or a detail page reached from the section's main page).
  hidden?: boolean;
}

export const NAV_MAP: Record<NavSection, SectionRoute[]> = {
  Dashboards: [{ href: "/", label: "Overview", gate: null, aliases: "overview dashboard home" }],
  Backup: [
    { href: "/protect", label: "What's protected", gate: null, aliases: "protect backups coverage setting types" },
    { href: "/schedules", label: "Schedules", gate: "canRead" },
    { href: "/sites", label: "Sites", gate: "canRead", aliases: "sharepoint site permissions app access grants groups roles" },
    { href: "/backups", label: "Backups", gate: null, hidden: true },
    { href: "/coverage", label: "Setting types", gate: null, hidden: true },
  ],
  Restore: [
    { href: "/restore", label: "Restore settings", gate: null, aliases: "restore put back undo" },
    { href: "/incidents", label: "Incidents", gate: null },
    { href: "/resilience", label: "Resilience", gate: "canRead", aliases: "recovery point recovery time drills off-site copy" },
    { href: "/emergency-access", label: "Emergency access", gate: "canRead", aliases: "readiness break glass emergency accounts sign-in test" },
  ],
  Baselines: [
    { href: "/changes", label: "Changes", gate: null, aliases: "drift changes" },
    { href: "/approved-setups", label: "Approved setups", gate: null, aliases: "baselines approved setup" },
    { href: "/compare", label: "Compare", gate: "canRead", aliases: "compare backups tenants differences side by side" },
    { href: "/compliance", label: "Compliance", gate: null, aliases: "benchmarks controls findings exceptions storage residency" },
  ],
  Reports: [
    { href: "/reports", label: "Value report", gate: "canRead", aliases: "reports outcomes verified value hours saved export" },
    { href: "/ask", label: "Ask", gate: "canRead", aliases: "question query search what changed failed jobs coverage" },
  ],
  "Automation center": [
    { href: "/rules", label: "Automatic rules", gate: "canPolicies", aliases: "policies automation rules automatic responses" },
    { href: "/emergency-changes", label: "Emergency changes", gate: "canApprove", aliases: "emergency deviation change intent approved change window" },
  ],
  "Audit log": [
    { href: "/activity", label: "Activity", gate: "canRead", aliases: "jobs evidence audit record history" },
    { href: "/jobs", label: "Jobs", gate: "canRead", hidden: true },
    { href: "/evidence", label: "Audit record", gate: "canRead", hidden: true },
  ],
  Settings: [
    { href: "/people", label: "People", gate: "canUsers", aliases: "principals users roles" },
    { href: "/notifications", label: "Notifications", gate: "canRead" },
    { href: "/integrations", label: "Integrations", gate: "canRead" },
    { href: "/setup", label: "Setup", gate: "canConfigure", aliases: "onboarding prerequisites consent connect tenant" },
  ],
  Inbox: [
    { href: "/approvals", label: "Approvals", gate: "canApprove", aliases: "approve reject requests waiting" },
    { href: "/alerts", label: "Alerts", gate: "canRead", aliases: "alerts inbox acknowledge escalation" },
  ],
};

export interface Crumb {
  label: string;
  // A page above this one; none on the section (a label) and on the current page.
  href?: string;
}

/** The page header's "you are here" line: section, the pages above this one, then this
 * page. A crumb that repeats the one before it (Restore › Restore) is dropped, and a
 * line with only one crumb left is not shown. */
export function breadcrumbTrail(section: NavSection, title: string, parents: readonly Crumb[] = []): Crumb[] {
  const all: Crumb[] = [{ label: section }, ...parents, { label: title }];
  const trail = all.filter((crumb, index) => index === 0 || crumb.label.trim().toLowerCase() !== all[index - 1].label.trim().toLowerCase());
  return trail.length > 1 ? trail : [];
}

/** The browser tab's title: the page's own title, then Keel ("Changes · Keel"). */
export function tabTitle(title: string): string {
  const page = title.trim();
  return page ? `${page} · Keel` : "Keel";
}

export interface Trail {
  section: NavSection;
  parents: readonly Crumb[];
}

/** A page reached from several places (a job opened from Restore, Schedules or a rule)
 * says where the person came from: when the request's Referer is a menu page on this
 * site, the breadcrumb is that page's section and that page, with its filters kept.
 * Anything else (a shared link, another site, a page not in the menu) keeps the page's
 * usual trail. Only menu labels and same-site paths come out, so a forged Referer can
 * do no more than pick another menu page. */
export function cameFrom(referer: string | null, hosts: readonly (string | null)[], usual: Trail): Trail {
  if (!referer) return usual;
  let from: URL;
  try {
    from = new URL(referer);
  } catch {
    return usual;
  }
  if (!hosts.some((host) => host && host.split(",")[0].trim().toLowerCase() === from.host.toLowerCase())) return usual;
  for (const section of NAV_SECTIONS) {
    const route = NAV_MAP[section].find((candidate) => !candidate.hidden && candidate.href === from.pathname);
    if (!route) continue;
    if (usual.parents.length && usual.parents[usual.parents.length - 1].href === route.href) return usual;
    return { section, parents: [{ href: `${route.href}${from.search}`, label: route.label }] };
  }
  return usual;
}
