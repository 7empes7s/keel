import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import Link from "next/link";

import "@fontsource-variable/public-sans";
import "@fontsource/jetbrains-mono/400.css";

import "./globals.css";

import { DATA_SURFACES, readAccess } from "@/lib/read";

import { CommandPalette } from "@/components/command-palette";
import { NavLinks } from "@/components/nav-links";
import { ThemeToggle } from "@/components/theme-toggle";
import { approvalInboxAccess, getPendingApprovalCount } from "@/lib/approval-inbox";
import { AUTHENTICATED_EMAIL_HEADER } from "@/lib/cloudflare-access";
import { CAPABILITIES_HEADER } from "@/lib/principal";
import { parseThemePreference, THEME_COOKIE } from "@/lib/theme";

export const metadata: Metadata = {
  title: "KEEL Operator Portal",
  description: "Microsoft 365 disaster-recovery operator console",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const requestHeaders = await headers();
  const email = requestHeaders.get(AUTHENTICATED_EMAIL_HEADER);
  const canUsers = readAccess(requestHeaders, DATA_SURFACES.principalsPage) !== null;
  const canPolicies = readAccess(requestHeaders, DATA_SURFACES.policiesPage) !== null;
  const canRead = readAccess(requestHeaders, DATA_SURFACES.jobsPage) !== null;

  if (!email) {
    throw new Error("Verified Cloudflare Access identity is missing");
  }

  const capabilities = (requestHeaders.get(CAPABILITIES_HEADER) ?? "")
    .split(" ")
    .filter(Boolean);
  const canApprove = capabilities.includes("approve");
  // Everything beyond read is something this operator can change; say so plainly
  // instead of a fixed label that stopped being true once write surfaces shipped.
  const actions = capabilities.filter((capability) => capability !== "read");
  const theme = parseThemePreference((await cookies()).get(THEME_COOKIE)?.value);

  // Only approvers see the count, and a failed read hides the badge rather than
  // breaking every page's chrome.
  let pendingApprovals: number | null = null;
  if (approvalInboxAccess(requestHeaders)) {
    try {
      pendingApprovals = await getPendingApprovalCount();
    } catch {
      pendingApprovals = null;
    }
  }

  return (
    <html data-theme={theme === "system" ? undefined : theme} lang="en">
      <body>
        <a className="skip-link" href="#main-content">
          Skip to content
        </a>
        <div className="app-shell">
          <aside className="sidebar">
            <Link aria-label="KEEL dashboard" className="brand" href="/">
              <span className="brand-mark" aria-hidden="true">
                K
              </span>
              <span>
                <strong>KEEL</strong>
                <small>Operator portal</small>
              </span>
            </Link>
            <CommandPalette canApprove={canApprove} canPolicies={canPolicies} canRead={canRead} canUsers={canUsers} />
            <NavLinks canRead={canRead} canPolicies={canPolicies} canUsers={canUsers} canApprove={canApprove} pendingApprovals={pendingApprovals} />
            <div className="operator-context">
              <span className="auth-state">
                <span aria-hidden="true" className="auth-dot" /> Authenticated
              </span>
              <span className="operator-email" title={email}>
                {email}
              </span>
              <span className="access-label" title={actions.join(", ") || undefined}>
                {actions.length ? `Read + ${actions.length} action ${actions.length === 1 ? "capability" : "capabilities"}` : "Read-only access"}
              </span>
              <ThemeToggle initial={theme} />
            </div>
          </aside>
          <main className="workspace" id="main-content">
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}
