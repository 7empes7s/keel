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
];

export function NavLinks() {
  const pathname = usePathname();

  return (
    <nav aria-label="Primary navigation" className="primary-nav">
      {links.map((link) => {
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
