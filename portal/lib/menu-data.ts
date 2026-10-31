import type { DashboardData } from "@/lib/types";

// The menu's badges come from the Overview's data, read in the background. One failed
// read (a busy database answers 503) used to leave the menu with no badges until the
// next minute's poll, and every full page load started with none. Now the last good
// answer is kept for the browser tab, and a failed read is tried again within seconds.

/** The parts of the Overview's data the menu's badges and bell read. */
export type MenuData = Pick<DashboardData, "headline" | "coverage" | "openDriftByBlastRadius" | "openDriftTotal" | "evidence" | "waiting"> & Partial<Pick<DashboardData, "alerts">>;

export const MENU_DATA_KEY = "keel-menu-data";

/** Waits before each retry of a failed read; after the last, the regular poll takes over. */
export const MENU_RETRY_MS = [2_000, 5_000, 15_000, 30_000] as const;

export function menuDataOf(data: DashboardData): MenuData {
  const { headline, coverage, openDriftByBlastRadius, openDriftTotal, evidence, waiting, alerts } = data;
  return { headline, coverage, openDriftByBlastRadius, openDriftTotal, evidence, waiting, alerts };
}

/**
 * How long to wait before retry number `attempt` (from 1), or null when the retries are
 * used up. A server's Retry-After (seconds) is honoured when it asks for longer.
 */
export function menuRetryDelay(attempt: number, retryAfter: string | null = null): number | null {
  const planned = MENU_RETRY_MS[attempt - 1];
  if (planned === undefined) return null;
  const asked = retryAfter === null ? NaN : Number(retryAfter) * 1000;
  return Number.isFinite(asked) && asked > planned ? Math.min(asked, MENU_RETRY_MS[MENU_RETRY_MS.length - 1]) : planned;
}

type Store = Pick<Storage, "getItem" | "setItem">;

/** The last good menu data kept for this tab, or null. Storage that throws counts as empty. */
export function loadMenuData(store: Store | undefined): MenuData | null {
  try {
    const raw = store?.getItem(MENU_DATA_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as MenuData | null;
    return data && typeof data === "object" && data.coverage && typeof data.coverage === "object" ? data : null;
  } catch {
    return null;
  }
}

export function saveMenuData(store: Store | undefined, data: MenuData): void {
  try {
    store?.setItem(MENU_DATA_KEY, JSON.stringify(data));
  } catch {
    // Full or blocked storage: the badges still show for this page.
  }
}
