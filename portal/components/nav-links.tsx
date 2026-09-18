"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const links = [
  { href: "/", label: "Dashboard", short: "01" },
  { href: "/coverage", label: "Coverage", short: "02" },
  { href: "/drift", label: "Drift", short: "03" },
  { href: "/baselines", label: "Baselines", short: "04" },
  { href: "/backups", label: "Backups", short: "05" },
  { href: "/restore", label: "Restore", short: "06" },
  { href: "/jobs", label: "Jobs", short: "07" },
  { href: "/policies", label: "Policies", short: "08" },
  { href: "/notifications", label: "Notifications", short: "09" },
  { href: "/principals", label: "Principals", short: "10" },
  { href: "/evidence", label: "Evidence", short: "11" },
];

const approvalLink = { href: "/approvals", label: "Approvals", short: "12" };

interface NavCapabilities {
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
    && (link.href !== "/evidence" || canRead)
    && (link.href !== "/notifications" || canRead)
    && (link.href !== "/policies" || canPolicies));
  return canApprove ? [...gated, approvalLink] : gated;
}

export function NavLinks({ canRead = false, canPolicies = false, canUsers = false, canApprove = false }: NavCapabilities) {
  const pathname = usePathname();
  const visibleLinks = visibleNavLinks({ canRead, canPolicies, canUsers, canApprove });

  return (
    <nav aria-label="Primary navigation" className="primary-nav">
      {visibleLinks.map((link) => {
        const current =
          link.href === "/" ? pathname === "/" : pathname.startsWith(link.href);
        return (
          <Link
            aria-current={current ? "page" : undefined}
            className="nav-link"
            href={link.href}
            key={link.href}
          >
            <span aria-hidden="true" className="nav-index">
              {link.short}
            </span>
            <span>{link.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
