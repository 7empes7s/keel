"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";

// Portal experience contract, "Information architecture": seven entries, one map.
// Each entry absorbs existing pages, which stay reachable at their own routes and show
// as tabs inside the entry (SectionTabs). A page's eyebrow is the entry it sits in and
// nothing else (PageHeader's `section`), so no page can carry a second taxonomy.
// Absorbed pages become merged views in task-130/131; routes keep working throughout.
export const NAV_SECTIONS = ["Overview", "Protect", "Changes", "Restore", "Approvals", "Activity", "Settings"] as const;
export type NavSection = (typeof NAV_SECTIONS)[number];

export interface NavCapabilities {
  canRead?: boolean;
  canPolicies?: boolean;
  canUsers?: boolean;
  canApprove?: boolean;
}

type Gate = keyof NavCapabilities | null;

interface SectionRoute {
  href: string;
  label: string;
  gate: Gate;
  // Former page names, still searchable in the command palette.
  aliases?: string;
  // A route that belongs to the section but is not a tab of its own (a redirect or a
  // detail page reached from the section's main page).
  hidden?: boolean;
}

export const NAV_MAP: Record<NavSection, SectionRoute[]> = {
  Overview: [{ href: "/", label: "Overview", gate: null, aliases: "dashboard home" }],
  Protect: [
    { href: "/protect", label: "Protect", gate: null, aliases: "backups coverage configuration types" },
    { href: "/schedules", label: "Schedules", gate: "canRead" },
    { href: "/backups", label: "Backups", gate: null, hidden: true },
    { href: "/coverage", label: "Configuration types", gate: null, hidden: true },
  ],
  Changes: [
    { href: "/drift", label: "Changes", gate: null, aliases: "drift" },
    { href: "/baselines", label: "Baselines", gate: null },
  ],
  Restore: [
    { href: "/restore", label: "Restore", gate: null },
    { href: "/incidents", label: "Incidents", gate: null },
  ],
  Approvals: [{ href: "/approvals", label: "Approvals", gate: "canApprove" }],
  Activity: [
    { href: "/activity", label: "Activity", gate: "canRead", aliases: "jobs evidence audit record history" },
    { href: "/jobs", label: "Jobs", gate: "canRead", hidden: true },
    { href: "/evidence", label: "Audit record", gate: "canRead", hidden: true },
  ],
  Settings: [
    { href: "/policies", label: "Policies", gate: "canPolicies" },
    { href: "/principals", label: "People", gate: "canUsers", aliases: "principals users roles" },
    { href: "/notifications", label: "Notifications", gate: "canRead" },
    { href: "/integrations", label: "Integrations", gate: "canRead" },
  ],
};

export interface NavLink {
  href: string;
  label: string;
  group: NavSection;
  aliases?: string;
}

function allowed(gate: Gate, capabilities: NavCapabilities): boolean {
  return gate === null || capabilities[gate] === true;
}

/** Every page the viewer may open, each tagged with its section (palette, tests). */
export function visibleNavLinks(capabilities: NavCapabilities): NavLink[] {
  return NAV_SECTIONS.flatMap((group) => NAV_MAP[group]
    .filter((route) => !route.hidden && allowed(route.gate, capabilities))
    .map((route) => ({ href: route.href, label: route.label, group, aliases: route.aliases })));
}

/** The seven entries the viewer can see; each links to its first page the viewer may open. */
export function visibleNavEntries(capabilities: NavCapabilities): NavLink[] {
  return NAV_SECTIONS.flatMap((group) => {
    const first = NAV_MAP[group].find((route) => !route.hidden && allowed(route.gate, capabilities));
    return first ? [{ href: first.href, label: group, group }] : [];
  });
}

export function groupNavLinks(visible: NavLink[]) {
  return NAV_SECTIONS.map((group) => ({ group, links: visible.filter((link) => link.group === group) }))
    .filter((section) => section.links.length > 0);
}

function routeMatches(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

/** The section a path belongs to; every portal route has exactly one. */
export function sectionForPath(pathname: string | null): NavSection | null {
  if (!pathname) return null;
  return NAV_SECTIONS.find((section) => NAV_MAP[section].some((route) => routeMatches(pathname, route.href))) ?? null;
}

export function isCurrentPath(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  return routeMatches(pathname, href);
}

export function NavLinks({
  canRead = false,
  canPolicies = false,
  canUsers = false,
  canApprove = false,
  pendingApprovals = null,
}: NavCapabilities & { pendingApprovals?: number | null }) {
  const pathname = usePathname();
  const entries = visibleNavEntries({ canRead, canPolicies, canUsers, canApprove });
  const currentSection = sectionForPath(pathname);
  const navRef = useRef<HTMLElement>(null);
  const [indicator, setIndicator] = useState<{ top: number; height: number } | null>(null);
  const [open, setOpen] = useState(false);

  // The active marker is one element that glides between links rather than each link
  // drawing its own, so a route change reads as movement from where you were.
  useLayoutEffect(() => {
    const active = navRef.current?.querySelector<HTMLElement>('[aria-current="page"], [aria-current="true"]');
    setIndicator(active ? { top: active.offsetTop, height: active.offsetHeight } : null);
    setOpen(false);
  }, [pathname, entries.length]);

  const indicatorStyle = indicator
    ? ({ "--indicator-y": `${indicator.top}px`, "--indicator-h": `${indicator.height}px` } as CSSProperties)
    : undefined;

  return (
    <>
      <button
        aria-controls="primary-nav"
        aria-expanded={open}
        className="nav-toggle"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <span aria-hidden="true" className="nav-toggle-icon" />
        <span>{currentSection ?? "Menu"}</span>
      </button>
      <nav
        aria-label="Primary navigation"
        className="primary-nav"
        data-open={open || undefined}
        id="primary-nav"
        ref={navRef}
        style={indicatorStyle}
      >
        {indicator ? <span aria-hidden="true" className="nav-indicator" /> : null}
        <div className="nav-group">
          {entries.map((entry) => (
            <Link
              aria-current={currentSection === entry.group ? (isCurrentPath(pathname, entry.href) ? "page" : "true") : undefined}
              className="nav-link"
              href={entry.href}
              key={entry.group}
            >
              <span>{entry.label}</span>
              {entry.group === "Approvals" && pendingApprovals ? (
                <span className="nav-badge" title={`${pendingApprovals} requests waiting for a decision`}>
                  {pendingApprovals > 99 ? "99+" : pendingApprovals}
                  <span className="visually-hidden"> waiting</span>
                </span>
              ) : null}
            </Link>
          ))}
        </div>
      </nav>
    </>
  );
}

/** Tabs for the pages an entry absorbs, shown at the top of the workspace when the
 * current section has more than one page the viewer may open. */
export function SectionTabs(capabilities: NavCapabilities) {
  const pathname = usePathname();
  const section = sectionForPath(pathname);
  if (!section) return null;
  const routes = NAV_MAP[section].filter((route) => !route.hidden && allowed(route.gate, capabilities));
  if (routes.length < 2) return null;
  return (
    <nav aria-label={`${section} pages`} className="section-tabs">
      {routes.map((route) => (
        <Link
          aria-current={isCurrentPath(pathname, route.href) ? "page" : undefined}
          className="section-tab"
          href={route.href}
          key={route.href}
        >
          {route.label}
        </Link>
      ))}
    </nav>
  );
}
