import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import Link from "next/link";

import "@fontsource-variable/public-sans";
import "@fontsource/jetbrains-mono/400.css";

import "./globals.css";

import { DATA_SURFACES, readAccess } from "@/lib/read";

import { CommandPalette } from "@/components/command-palette";
import { KeelMark } from "@/components/keel-mark";
import { NavLinks, SectionTabs } from "@/components/nav-links";
import { ThemeToggle } from "@/components/theme-toggle";
import { Toaster } from "@/components/toaster";
import { approvalInboxScope, getPendingApprovalCount } from "@/lib/approval-inbox";
import { AUTHENTICATED_EMAIL_HEADER } from "@/lib/cloudflare-access";
import { CAPABILITIES_HEADER } from "@/lib/principal";
import { accessSummary } from "@/lib/presentation";
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
  const canConfigure = readAccess(requestHeaders, DATA_SURFACES.setupPage) !== null;

  if (!email) {
    throw new Error("Verified Cloudflare Access identity is missing");
  }

  const capabilities = (requestHeaders.get(CAPABILITIES_HEADER) ?? "")
    .split(" ")
    .filter(Boolean);
  const canApprove = capabilities.includes("approve");
  // What this operator can do, in words; the raw capability codes stay in the title.
  const actions = capabilities.filter((capability) => capability !== "read");
  const theme = parseThemePreference((await cookies()).get(THEME_COOKIE)?.value);

  // Only approvers see the count, and a failed read hides the badge rather than
  // breaking every page's chrome.
  let pendingApprovals: number | null = null;
  const approverScope = approvalInboxScope(requestHeaders);
  if (approverScope) {
    try {
      pendingApprovals = await getPendingApprovalCount(approverScope);
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
                <KeelMark />
              </span>
              <span>
                <strong>KEEL</strong>
                <small>Operator portal</small>
              </span>
            </Link>
            <CommandPalette canApprove={canApprove} canConfigure={canConfigure} canPolicies={canPolicies} canRead={canRead} canUsers={canUsers} />
            <NavLinks canConfigure={canConfigure} canRead={canRead} canPolicies={canPolicies} canUsers={canUsers} canApprove={canApprove} pendingApprovals={pendingApprovals} />
            <div className="operator-context">
              <span className="auth-state">
                <span aria-hidden="true" className="auth-dot" /> Authenticated
              </span>
              <span className="operator-email" title={email}>
                {email}
              </span>
              <span className="access-label" title={actions.join(", ") || undefined}>
                {accessSummary(capabilities)}
              </span>
              <ThemeToggle initial={theme} />
            </div>
          </aside>
          <main className="workspace" id="main-content">
            <SectionTabs canApprove={canApprove} canConfigure={canConfigure} canPolicies={canPolicies} canRead={canRead} canUsers={canUsers} />
            {children}
          </main>
        </div>
        <Toaster />
      </body>
    </html>
  );
}
