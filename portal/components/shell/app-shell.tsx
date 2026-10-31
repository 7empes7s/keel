"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { ApprovalModeProvider } from "@/components/approval-mode-context";
import { CommandPalette, SearchTrigger } from "@/components/command-palette";
import { KeelMark } from "@/components/keel-mark";
import { SectionTabs, type NavCapabilities } from "@/components/nav-links";
import { Icon } from "@/components/shell/icons";
import { Bell, Menu, TabBar, type Person } from "@/components/shell/menu";
import { ShellStateProvider, useShellState } from "@/components/shell/shell-state";
import type { ApprovalModeName } from "@/lib/approval-words";
import type { MenuPrefs } from "@/lib/menu-prefs";
import { loadMenuData, menuDataOf, menuRetryDelay, saveMenuData, type MenuData } from "@/lib/menu-data";
import { menuStatuses, settingsStatus, type MenuStatuses } from "@/lib/menu-status";
import type { ThemePreference } from "@/lib/theme";
import type { DashboardData } from "@/lib/types";
import { usePoll } from "@/lib/use-poll";

interface ShellProps {
  // The tenant's approval mode; null when it could not be read (two people).
  approvalMode?: ApprovalModeName | null;
  capabilities: NavCapabilities;
  pendingApprovals: number | null;
  person: Person;
  theme: ThemePreference;
  initialPrefs: MenuPrefs;
  children: ReactNode;
}

// The page frame, direction A ("Chart room"): a navy menu on the left on a desktop
// (hideable), a top bar and a bottom tab bar on a phone, where All opens the same menu
// as a sheet. Section statuses come from the Overview's data, so a closed section or a
// phone tab still says when something needs someone.
export function AppShell(props: ShellProps) {
  return (
    <ApprovalModeProvider mode={props.approvalMode ?? null}>
      <ShellStateProvider initial={props.initialPrefs}>
        <Frame {...props} />
      </ShellStateProvider>
    </ApprovalModeProvider>
  );
}

type SettingsInputs = Parameters<typeof settingsStatus>[0];

// Settings' badge reads the same lists as the People and Notifications pages, each only
// for someone who may read it. A failed read keeps the last answer.
async function readJson<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(url, { cache: "no-store" });
    return response.ok ? await response.json() as T : null;
  } catch {
    return null;
  }
}

function sessionStorageOrUndefined(): Storage | undefined {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

function useStatuses(canRead: boolean, canUsers: boolean, pendingApprovals: number | null) {
  const [dashboard, setDashboard] = useState<MenuData | null>(null);
  const [settings, setSettings] = useState<SettingsInputs>({ principals: null, deliveries: null });
  const [ready, setReady] = useState(!canRead);
  const [approvals, setApprovals] = useState<{ from: number | null; count: number | null }>({ from: pendingApprovals, count: pendingApprovals });
  // A server render (navigation or refresh) brings a fresh count; it replaces the polled one.
  if (approvals.from !== pendingApprovals) setApprovals({ from: pendingApprovals, count: pendingApprovals });
  const retry = useRef<{ attempt: number; timer: ReturnType<typeof setTimeout> | null }>({ attempt: 0, timer: null });

  // A failed read (a busy server answers 503) keeps the last badges and tries again in
  // a few seconds, rather than waiting for the next minute's poll.
  async function readDashboard() {
    let retryAfter: string | null = null;
    try {
      const response = await fetch("/api/dashboard", { cache: "no-store" });
      if (response.ok) {
        const data = menuDataOf(await response.json() as DashboardData);
        setDashboard(data);
        saveMenuData(sessionStorageOrUndefined(), data);
        setReady(true);
        if (retry.current.timer) clearTimeout(retry.current.timer);
        retry.current.attempt = 0;
        retry.current.timer = null;
        return;
      }
      retryAfter = response.headers.get("retry-after");
    } catch {
      // Keep the last statuses.
    }
    setReady(true);
    if (retry.current.timer) return;
    const delay = menuRetryDelay(retry.current.attempt + 1, retryAfter);
    if (delay === null) {
      retry.current.attempt = 0;
      return;
    }
    retry.current.attempt += 1;
    retry.current.timer = setTimeout(() => {
      retry.current.timer = null;
      if (document.visibilityState === "visible") void readDashboard();
    }, delay);
  }

  async function readApprovals() {
    try {
      const response = await fetch("/api/approvals", { cache: "no-store" });
      if (!response.ok) return;
      const data = await response.json() as { pending?: unknown[]; awaitingContentEffects?: unknown[] };
      if (!Array.isArray(data.pending)) return;
      const count = data.pending.length + (Array.isArray(data.awaitingContentEffects) ? data.awaitingContentEffects.length : 0);
      setApprovals((current) => ({ ...current, count }));
    } catch {
      // Keep the last count.
    }
  }

  async function readSettings() {
    const [people, sent] = await Promise.all([
      canUsers ? readJson<{ principals: SettingsInputs["principals"] }>("/api/principals") : null,
      canRead ? readJson<{ deliveries: SettingsInputs["deliveries"] }>("/api/deliveries?limit=100") : null,
    ]);
    setSettings((current) => ({
      principals: Array.isArray(people?.principals) ? people.principals : current.principals,
      deliveries: Array.isArray(sent?.deliveries) ? sent.deliveries : current.deliveries,
    }));
  }

  useEffect(() => {
    if (!canRead) return;
    // A full page load starts from the badges this tab last showed, then reads fresh ones.
    const kept = loadMenuData(sessionStorageOrUndefined());
    if (kept) setDashboard((current) => current ?? kept);
    void readDashboard();
    const pending = retry.current;
    return () => { if (pending.timer) clearTimeout(pending.timer); pending.timer = null; };
  }, [canRead]);
  useEffect(() => { if (canRead || canUsers) void readSettings(); }, [canRead, canUsers]);
  usePoll(readDashboard, 60_000, canRead);
  usePoll(readSettings, 60_000, canRead || canUsers);
  usePoll(readApprovals, 10_000, pendingApprovals !== null);

  let statuses: MenuStatuses = {};
  if (dashboard?.coverage) {
    try {
      statuses = menuStatuses(dashboard, approvals.count);
    } catch {
      statuses = {};
    }
  }
  const settingsBadge = settingsStatus(settings);
  if (settingsBadge) statuses = { ...statuses, Settings: settingsBadge };
  return { statuses, ready, approvals: approvals.count, alerts: dashboard?.waiting?.openAlerts ?? null };
}

function Frame({ capabilities, pendingApprovals, person, theme, children }: ShellProps) {
  const { prefs, update } = useShellState();
  const pathname = usePathname();
  const { statuses, ready, approvals, alerts } = useStatuses(capabilities.canRead === true, capabilities.canUsers === true, pendingApprovals);
  const [sheet, setSheet] = useState(false);
  const railRef = useRef<HTMLElement>(null);
  const revealRef = useRef<HTMLButtonElement>(null);
  const hidden = prefs.hidden;

  // Leaving the page closes the phone sheet.
  useEffect(() => { setSheet(false); }, [pathname]);

  useEffect(() => {
    if (!sheet) return;
    const opener = document.activeElement as HTMLElement | null;
    railRef.current?.querySelector<HTMLElement>("a[href], button")?.focus();
    // A popover inside the sheet takes Esc first; the next Esc closes the sheet.
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !document.querySelector(".popover-panel")) setSheet(false); };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      // Back to the tab that opened it, unless a link has moved focus elsewhere.
      if (opener?.isConnected && (!document.activeElement || document.activeElement === document.body || railRef.current?.contains(document.activeElement))) opener.focus();
    };
  }, [sheet]);

  function setHidden(value: boolean) {
    update({ ...prefs, hidden: value });
    // Keep focus on the control that brings the menu back, or on the menu itself.
    requestAnimationFrame(() => (value ? revealRef.current : railRef.current?.querySelector<HTMLElement>(".menu-hide"))?.focus());
  }

  return (
    <>
      <a className="skip-link" href="#main-content">Skip to content</a>
      <div className="shell" data-menu={hidden ? "hidden" : "shown"} data-sheet={sheet ? "open" : undefined} data-statuses={ready ? "ready" : "loading"}>
        <header className="topbar" inert={sheet || undefined}>
          <Link aria-label="Keel dashboards" className="brand" href="/" prefetch={false}>
            <span aria-hidden="true" className="brand-mark"><KeelMark /></span>
            <span className="topbar-name"><strong>KEEL</strong><small>Microsoft 365</small></span>
          </Link>
          <span className="topbar-actions">
            <SearchTrigger compact />
            <Bell alerts={alerts} approvals={approvals} canApprove={capabilities.canApprove === true} canRead={capabilities.canRead === true} placement="top" />
          </span>
        </header>
        <aside aria-label="Menu" aria-modal={sheet || undefined} className="rail" ref={railRef} role={sheet ? "dialog" : undefined}>
          <Menu
            alerts={alerts}
            approvals={approvals}
            capabilities={capabilities}
            onHide={sheet ? () => setSheet(false) : () => setHidden(true)}
            onNavigate={sheet ? () => setSheet(false) : undefined}
            person={person}
            statuses={statuses}
            theme={theme}
            variant={sheet ? "sheet" : "rail"}
          />
        </aside>
        {hidden ? (
          <button aria-label="Show the menu" className="menu-reveal" onClick={() => setHidden(false)} ref={revealRef} title="Show the menu" type="button">
            <Icon name="show" />
          </button>
        ) : null}
        <div aria-hidden="true" className="sheet-scrim" onClick={() => setSheet(false)} />
        <main className="workspace" id="main-content" inert={sheet || undefined}>
          <SectionTabs {...capabilities} />
          {children}
        </main>
        <div className="tabbar-slot" inert={sheet || undefined}>
          <TabBar allOpen={sheet} capabilities={capabilities} onAll={() => setSheet((value) => !value)} statuses={statuses} />
        </div>
      </div>
      <CommandPalette {...capabilities} />
    </>
  );
}
