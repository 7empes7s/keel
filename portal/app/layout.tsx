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
import { getApprovalModeView } from "@/lib/approval-mode";
import { AUTHENTICATED_EMAIL_HEADER } from "@/lib/cloudflare-access";
import { CAPABILITIES_HEADER, PRINCIPAL_ID_HEADER, principalDisplayName } from "@/lib/principal";
import { accessInFull, accessSummary } from "@/lib/presentation";
import { MENU_COOKIE, parseMenuPrefs } from "@/lib/menu-prefs";
import { loadShellLookups } from "@/lib/shell-lookups";
import { parseThemePreference, THEME_COOKIE } from "@/lib/theme";

// No title here: each page's header sets the tab title ("Changes · Keel"), so the tab,
// the heading and the menu always say the same name.
export const metadata: Metadata = {
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
  const canBackup = capabilities.includes("backup");
  const cookieStore = await cookies();
  const theme = parseThemePreference(cookieStore.get(THEME_COOKIE)?.value);
  const menuPrefs = parseMenuPrefs(cookieStore.get(MENU_COOKIE)?.value);

  // Only approvers see the count, and the menu shows the person's name, never their
  // email as a name. Both reads run at once; a failed read hides only its own piece.
  const principalId = requestHeaders.get(PRINCIPAL_ID_HEADER);
  // The approval mode runs alongside: every page that says who approves follows it.
  // An unread mode reads as two people, Keel's default.
  const [{ pendingApprovals, displayName }, approvalMode] = await Promise.all([
    loadShellLookups(
      { approverScope: approvalInboxScope(requestHeaders), principalId },
      { pendingApprovalCount: getPendingApprovalCount, displayName: principalDisplayName },
    ),
    getApprovalModeView(),
  ]);

  return (
    <html data-theme={theme === "system" ? undefined : theme} lang="en">
      <body>
        <AppShell
          approvalMode={approvalMode?.mode ?? null}
          capabilities={{ canApprove, canBackup, canConfigure, canPolicies, canRead, canUsers }}
          initialPrefs={menuPrefs}
          pendingApprovals={pendingApprovals}
          person={{
            email,
            name: displayName,
            access: accessSummary(capabilities),
            accessTitle: accessInFull(capabilities),
            href: canUsers && principalId ? `/people#person-${encodeURIComponent(principalId)}` : undefined,
          }}
          theme={theme}
        >
          {children}
        </AppShell>
        <Toaster />
      </body>
    </html>
  );
}
