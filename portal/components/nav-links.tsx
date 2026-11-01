"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { MENU_SECTIONS, NAV_MAP, NAV_SECTIONS, SECTION_ICONS, type Gate, type MenuSection, type NavCapabilities, type NavSection } from "@/lib/nav-sections";

export { MENU_SECTIONS, NAV_MAP, NAV_SECTIONS, SECTION_ICONS, type MenuSection, type NavCapabilities, type NavSection };

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

export interface NavLink {
  href: string;
  label: string;
  group: NavSection;
  aliases?: string;
}

function allowed(gate: Gate, capabilities: NavCapabilities): boolean {
  return gate === null || capabilities[gate] === true;
}

/** The sub-pages of one section the viewer may open, in menu order. */
export function sectionLinks(section: NavSection, capabilities: NavCapabilities): NavLink[] {
  return NAV_MAP[section]
    .filter((route) => !route.hidden && allowed(route.gate, capabilities))
    .map((route) => ({ href: route.href, label: route.label, group: section, aliases: route.aliases }));
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

export function isCurrentPath(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  return routeMatches(pathname, href);
}

/** The pages a section absorbs, as one scrolling row of tabs. On a desktop the menu
 * lists them under the section instead, so the row shows on narrow screens and for the
 * bell's inbox only. */
export function SectionTabs(capabilities: NavCapabilities) {
  const pathname = usePathname();
  const section = sectionForPath(pathname);
  if (!section) return null;
  const routes = sectionLinks(section, capabilities);
  if (routes.length < 2) return null;
  return (
    <nav aria-label={`${section} pages`} className="section-tabs" data-section={section === "Inbox" ? "inbox" : undefined}>
      {routes.map((route) => (
        <Link
          aria-current={isCurrentPath(pathname, route.href) ? "page" : undefined}
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
