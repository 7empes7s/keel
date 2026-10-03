"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";

// Grouped by the job an operator is doing, not numbered: during an incident the
// question is "where do I recover" or "who must approve", not "which page is 06".
export const NAV_GROUPS = ["Posture", "Recovery", "Operations", "Governance", "Settings"] as const;
export type NavGroup = (typeof NAV_GROUPS)[number];

export interface NavLink {
  href: string;
  label: string;
  group: NavGroup;
}

const links: NavLink[] = [
  { href: "/", label: "Dashboard", group: "Posture" },
  { href: "/coverage", label: "Coverage", group: "Posture" },
  { href: "/drift", label: "Drift", group: "Posture" },
  { href: "/baselines", label: "Baselines", group: "Recovery" },
  { href: "/backups", label: "Backups", group: "Recovery" },
  { href: "/restore", label: "Restore", group: "Recovery" },
  { href: "/incidents", label: "Incidents", group: "Recovery" },
  { href: "/jobs", label: "Jobs", group: "Operations" },
  { href: "/schedules", label: "Schedules", group: "Operations" },
  { href: "/policies", label: "Policies", group: "Operations" },
  { href: "/evidence", label: "Evidence", group: "Governance" },
  { href: "/principals", label: "Principals", group: "Governance" },
  { href: "/notifications", label: "Notifications", group: "Settings" },
  { href: "/integrations", label: "Integrations", group: "Settings" },
];

const approvalLink: NavLink = { href: "/approvals", label: "Approvals", group: "Governance" };

export interface NavCapabilities {
  canRead?: boolean;
  canPolicies?: boolean;
  canUsers?: boolean;
  canApprove?: boolean;
}

// Exported so a plain unit test can assert each capability gate without rendering
// this client component through a full React/router harness.
export function visibleNavLinks({
  canRead = false,
  canPolicies = false,
  canUsers = false,
  canApprove = false,
}: NavCapabilities) {
  const gated = links.filter((link) =>
    (link.href !== "/principals" || canUsers)
    && (link.href !== "/jobs" || canRead)
    && (link.href !== "/schedules" || canRead)
    && (link.href !== "/evidence" || canRead)
    && (link.href !== "/notifications" || canRead)
    && (link.href !== "/integrations" || canRead)
    && (link.href !== "/policies" || canPolicies));
  return canApprove ? [...gated, approvalLink] : gated;
}

export function groupNavLinks(visible: NavLink[]) {
  return NAV_GROUPS.map((group) => ({
    group,
    // Approvals leads its group: it is the one surface that waits on a person.
    links: visible
      .filter((link) => link.group === group)
      .sort((a, b) => Number(b.href === "/approvals") - Number(a.href === "/approvals")),
  })).filter((section) => section.links.length > 0);
}

export function isCurrentPath(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}

export function NavLinks({
  canRead = false,
  canPolicies = false,
  canUsers = false,
  canApprove = false,
  pendingApprovals = null,
}: NavCapabilities & { pendingApprovals?: number | null }) {
  const pathname = usePathname();
  const visibleLinks = visibleNavLinks({ canRead, canPolicies, canUsers, canApprove });
  const sections = groupNavLinks(visibleLinks);
  const navRef = useRef<HTMLElement>(null);
  const [indicator, setIndicator] = useState<{ top: number; height: number } | null>(null);
  const [open, setOpen] = useState(false);

  // The active marker is one element that glides between links rather than each link
  // drawing its own, so a route change reads as movement from where you were.
  useLayoutEffect(() => {
    const active = navRef.current?.querySelector<HTMLElement>('[aria-current="page"]');
    setIndicator(active ? { top: active.offsetTop, height: active.offsetHeight } : null);
    setOpen(false);
  }, [pathname, visibleLinks.length]);

  const indicatorStyle = indicator
    ? ({ "--indicator-y": `${indicator.top}px`, "--indicator-h": `${indicator.height}px` } as CSSProperties)
    : undefined;
  const current = visibleLinks.find((link) => isCurrentPath(pathname, link.href));

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
        <span>{current?.label ?? "Menu"}</span>
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
        {sections.map((section) => (
          <div className="nav-group" key={section.group}>
            <p className="nav-group-label">{section.group}</p>
            {section.links.map((link) => (
              <Link
                aria-current={isCurrentPath(pathname, link.href) ? "page" : undefined}
                className="nav-link"
                href={link.href}
                key={link.href}
              >
                <span>{link.label}</span>
                {link.href === "/approvals" && pendingApprovals ? (
                  <span className="nav-badge" title={`${pendingApprovals} pending approval requests`}>
                    {pendingApprovals > 99 ? "99+" : pendingApprovals}
                    <span className="visually-hidden"> pending</span>
                  </span>
                ) : null}
              </Link>
            ))}
          </div>
        ))}
      </nav>
    </>
  );
}
