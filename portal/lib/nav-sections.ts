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
