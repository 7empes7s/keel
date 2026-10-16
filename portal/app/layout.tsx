import type { Metadata } from "next";
import { cookies, headers } from "next/headers";

import "@fontsource-variable/ibm-plex-sans/wght.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/600.css";

import "./globals.css";

import { DATA_SURFACES, readAccess } from "@/lib/read";

import { AppShell } from "@/components/shell/app-shell";
import { Toaster } from "@/components/toaster";
import { approvalInboxScope, getPendingApprovalCount } from "@/lib/approval-inbox";
import { AUTHENTICATED_EMAIL_HEADER } from "@/lib/cloudflare-access";
import { CAPABILITIES_HEADER } from "@/lib/principal";
import { accessSummary } from "@/lib/presentation";
import { MENU_COOKIE, parseMenuPrefs } from "@/lib/menu-prefs";
import { parseThemePreference, THEME_COOKIE } from "@/lib/theme";

export const metadata: Metadata = {
  title: "Keel",
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
  const cookieStore = await cookies();
  const theme = parseThemePreference(cookieStore.get(THEME_COOKIE)?.value);
  const menuPrefs = parseMenuPrefs(cookieStore.get(MENU_COOKIE)?.value);

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
        <AppShell
          capabilities={{ canApprove, canConfigure, canPolicies, canRead, canUsers }}
          initialPrefs={menuPrefs}
          pendingApprovals={pendingApprovals}
          person={{ email, access: accessSummary(capabilities), accessTitle: actions.join(", ") || undefined }}
          theme={theme}
        >
          {children}
        </AppShell>
        <Toaster />
      </body>
    </html>
  );
}
