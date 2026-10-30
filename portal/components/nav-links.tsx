"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

import { MENU_SECTIONS, NAV_SECTIONS, SECTION_ICONS, type MenuSection, type NavSection } from "@/lib/nav-sections";

export { MENU_SECTIONS, NAV_SECTIONS, SECTION_ICONS, type MenuSection, type NavSection };

export interface NavCapabilities {
  canRead?: boolean;
  canPolicies?: boolean;
  canUsers?: boolean;
  canApprove?: boolean;
  canConfigure?: boolean;
  // Not a page gate: lets the search offer "Back up now" only to people who can.
  canBackup?: boolean;
}

type Gate = keyof NavCapabilities | null;

interface SectionRoute {
  href: string;
  label: string;
  gate: Gate;
  // Former page and section names, still searchable in the command palette.
  aliases?: string;
  // A route that belongs to the section but is not a sub-item of its own (a redirect
  // or a detail page reached from the section's main page).
  hidden?: boolean;
  // Current only on this exact path, for a page whose sub-pages sit beside it in the
  // menu (/restore and /restore/services).
  exact?: boolean;
}

// What each section is for, in one line: the menu's tooltip and the palette's hint.
export const SECTION_PURPOSE: Record<NavSection, string> = {
  Dashboards: "How your Microsoft 365 setup is doing, at a glance",
  Backup: "What Keel saves, when, and what failed",
  Restore: "Put settings back from a backup",
  Baselines: "Your approved setup and every change since",
  Reports: "Answers about your setup, ready to share",
  "Automation center": "What Keel does on its own when something changes",
  "Audit log": "Everything Keel did and who decided what",
  Settings: "People, notifications, connections and setup",
  Inbox: "Approvals and alerts waiting on someone",
};

export const NAV_MAP: Record<NavSection, SectionRoute[]> = {
  Dashboards: [{ href: "/", label: "Overview", gate: null, aliases: "overview dashboard home" }],
  Backup: [
    { href: "/protect", label: "What's protected", gate: null, aliases: "protect backups coverage configuration types" },
    { href: "/schedules", label: "Schedules", gate: "canRead" },
    { href: "/sites", label: "Sites", gate: "canRead", aliases: "sharepoint site permissions app access grants groups roles" },
    { href: "/backups", label: "Backups", gate: null, hidden: true },
    { href: "/coverage", label: "Configuration types", gate: null, hidden: true },
  ],
  Restore: [
    // The restore areas in the order people use them: start a restore, finish its
    // follow-up steps, look back at past ones.
    { href: "/restore", label: "Configurations", gate: null, exact: true, aliases: "restore settings configurations put back undo entra intune" },
    { href: "/restore/services", label: "Exchange, Teams and more", gate: null, aliases: "other services exchange mail flow mailboxes sharepoint onedrive teams purview power platform" },
    { href: "/restore/follow-ups", label: "Follow-up steps", gate: null, aliases: "follow-ups manual steps by hand new secrets finish restore" },
    { href: "/restore/history", label: "Past restores", gate: null, aliases: "restore jobs history checks dry runs" },
    { href: "/incidents", label: "Incidents", gate: null },
    { href: "/resilience", label: "Resilience", gate: "canRead", aliases: "recovery point recovery time drills off-site copy" },
    { href: "/readiness", label: "Emergency access", gate: "canRead", aliases: "break glass emergency accounts readiness sign-in test" },
  ],
  Baselines: [
    { href: "/drift", label: "Changes", gate: null, aliases: "drift changes" },
    { href: "/baselines", label: "Approved setups", gate: null, aliases: "baselines approved setup" },
    { href: "/compare", label: "Compare", gate: "canRead", aliases: "compare snapshots tenants differences side by side" },
    { href: "/benchmarks", label: "Compliance", gate: null, aliases: "benchmarks controls findings exceptions storage residency" },
  ],
  Reports: [
    { href: "/reports", label: "Value report", gate: "canRead", aliases: "reports outcomes verified value hours saved export" },
    { href: "/ask", label: "Ask", gate: "canRead", aliases: "question query search what changed failed jobs coverage" },
  ],
  "Automation center": [
    { href: "/policies", label: "Policies", gate: "canPolicies", aliases: "automation rules automatic responses" },
    { href: "/emergency-changes", label: "Emergency changes", gate: "canApprove", aliases: "emergency deviation change intent approved change window" },
  ],
  "Audit log": [
    { href: "/activity", label: "Activity", gate: "canRead", aliases: "jobs evidence audit record history" },
    { href: "/jobs", label: "Jobs", gate: "canRead", hidden: true },
    { href: "/evidence", label: "Audit record", gate: "canRead", hidden: true },
  ],
  Settings: [
    { href: "/principals", label: "People", gate: "canUsers", aliases: "principals users roles" },
    { href: "/notifications", label: "Notifications", gate: "canRead" },
    { href: "/integrations", label: "Integrations", gate: "canRead" },
    { href: "/setup", label: "Setup", gate: "canConfigure", aliases: "onboarding prerequisites consent connect tenant" },
  ],
  Inbox: [
    { href: "/approvals", label: "Approvals", gate: "canApprove", aliases: "approve reject requests waiting" },
    { href: "/alerts", label: "Alerts", gate: "canRead", aliases: "alerts inbox acknowledge escalation" },
  ],
};

export interface NavLink {
  href: string;
  label: string;
  group: NavSection;
  aliases?: string;
  exact?: boolean;
}

function allowed(gate: Gate, capabilities: NavCapabilities): boolean {
  return gate === null || capabilities[gate] === true;
}

/** The sub-pages of one section the viewer may open, in menu order. */
export function sectionLinks(section: NavSection, capabilities: NavCapabilities): NavLink[] {
  return NAV_MAP[section]
    .filter((route) => !route.hidden && allowed(route.gate, capabilities))
    .map((route) => ({ href: route.href, label: route.label, group: section, aliases: route.aliases, exact: route.exact }));
}

/** Every page the viewer may open, each tagged with its section (palette, tests). */
export function visibleNavLinks(capabilities: NavCapabilities): NavLink[] {
  return NAV_SECTIONS.flatMap((section) => sectionLinks(section, capabilities));
}

/** The menu sections the viewer can see; each links to its first page the viewer may open. */
export function visibleNavEntries(capabilities: NavCapabilities): NavLink[] {
  return MENU_SECTIONS.flatMap((group) => {
    const first = sectionLinks(group, capabilities)[0];
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

/** Whether a menu entry is the page you are on. An `exact` entry matches its own path
 * only, so /restore is not also current on /restore/services. */
export function isCurrentPath(pathname: string | null, href: string, exact = false): boolean {
  if (!pathname) return false;
  return exact ? pathname === href : routeMatches(pathname, href);
}

/** The pages a section absorbs, as one scrolling row of tabs. On a desktop the menu
 * lists them under the section instead, so the row shows on narrow screens and for the
 * bell's inbox only. */
export function SectionTabs(capabilities: NavCapabilities) {
  const pathname = usePathname();
  const rowRef = useRef<HTMLElement>(null);
  // A long row (Restore has seven pages) keeps the open page's tab in sight on a phone.
  useEffect(() => {
    const row = rowRef.current;
    const current = row?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!row || !current) return;
    const box = row.getBoundingClientRect();
    const tab = current.getBoundingClientRect();
    if (tab.left < box.left || tab.right > box.right) row.scrollLeft += tab.left - box.left - 16;
  }, [pathname]);
  const section = sectionForPath(pathname);
  if (!section) return null;
  const routes = sectionLinks(section, capabilities);
  if (routes.length < 2) return null;
  return (
    <nav aria-label={`${section} pages`} className="section-tabs" ref={rowRef} data-section={section === "Inbox" ? "inbox" : undefined}>
      {routes.map((route) => (
        <Link
          aria-current={isCurrentPath(pathname, route.href, route.exact) ? "page" : undefined}
          className="section-tab"
          href={route.href}
          key={route.href}
          prefetch={false}
        >
          {route.label}
        </Link>
      ))}
    </nav>
  );
}
