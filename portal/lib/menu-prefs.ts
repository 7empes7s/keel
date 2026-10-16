import { isIconName, type IconName } from "@/components/shell/icons";

// The menu's personal parts: Pinned (menu shortcuts), Favourites (starred pages and
// items) and Custom (named saved views, including saved list filters), plus which menu
// groups are closed and whether the menu is hidden. One cookie, like the theme, so the
// server renders the menu as the person left it and nothing jumps after hydration.
export const MENU_COOKIE = "keel-menu";
export const MENU_EVENT = "keel-menu-change";

export const PERSONAL_GROUPS = ["pinned", "favourites", "custom"] as const;
export type PersonalGroup = (typeof PERSONAL_GROUPS)[number];
export type MenuGroup = PersonalGroup | "everything";

export interface MenuItem {
  href: string;
  label: string;
  icon: IconName;
}

export interface MenuPrefs {
  pinned: MenuItem[];
  favourites: MenuItem[];
  custom: MenuItem[];
  // Menu groups the person closed. A closed group keeps its name, count and status.
  closed: MenuGroup[];
  hidden: boolean;
}

export const LIMITS: Record<PersonalGroup, number> = { pinned: 8, favourites: 12, custom: 12 };
const MAX_LABEL = 60;
const MAX_HREF = 300;
// Browsers keep cookies up to 4096 bytes; leave room for the name and attributes.
export const COOKIE_BUDGET = 3600;

export const EMPTY_PREFS: MenuPrefs = Object.freeze({ pinned: [], favourites: [], custom: [], closed: [], hidden: false }) as MenuPrefs;

/** A path inside the portal: starts with one slash, no scheme, no backslash, no spaces. */
export function isPortalHref(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_HREF && /^\/(?![/\\])[^\s\\]*$/.test(value);
}

export function cleanLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const label = value.replace(/\s+/g, " ").trim().slice(0, MAX_LABEL);
  return label.length ? label : null;
}

function items(value: unknown, limit: number): MenuItem[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: MenuItem[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const { href, label, icon } = entry as Record<string, unknown>;
    const name = cleanLabel(label);
    if (!isPortalHref(href) || !name || seen.has(href)) continue;
    seen.add(href);
    out.push({ href, label: name, icon: isIconName(icon) ? icon : "page" });
    if (out.length === limit) break;
  }
  return out;
}

function strings(value: unknown, keep: (entry: string) => boolean): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((entry): entry is string => typeof entry === "string" && keep(entry)))] : [];
}

/** Reads the cookie value; anything malformed falls back to the empty menu. */
export function parseMenuPrefs(raw: string | null | undefined): MenuPrefs {
  if (!raw) return EMPTY_PREFS;
  let data: unknown;
  try {
    // The browser's copy is URL-encoded; the server's copy arrives already decoded.
    data = JSON.parse(raw.startsWith("{") ? raw : decodeURIComponent(raw));
  } catch {
    return EMPTY_PREFS;
  }
  if (!data || typeof data !== "object") return EMPTY_PREFS;
  const record = data as Record<string, unknown>;
  return {
    pinned: items(record.pinned, LIMITS.pinned),
    favourites: items(record.favourites, LIMITS.favourites),
    custom: items(record.custom, LIMITS.custom),
    closed: strings(record.closed, (entry) => entry === "everything" || (PERSONAL_GROUPS as readonly string[]).includes(entry)) as MenuGroup[],
    hidden: record.hidden === true,
  };
}

export function serializeMenuPrefs(prefs: MenuPrefs): string {
  return encodeURIComponent(JSON.stringify(prefs));
}

export type AddResult = { ok: true; prefs: MenuPrefs } | { ok: false; reason: "full" | "invalid" };

/** Adds an item to a group (or moves it to the end if already there), within limits. */
export function addItem(prefs: MenuPrefs, group: PersonalGroup, item: MenuItem): AddResult {
  const label = cleanLabel(item.label);
  if (!label || !isPortalHref(item.href)) return { ok: false, reason: "invalid" };
  const kept = prefs[group].filter((entry) => entry.href !== item.href);
  if (kept.length >= LIMITS[group]) return { ok: false, reason: "full" };
  const next = { ...prefs, [group]: [...kept, { href: item.href, label, icon: item.icon }] };
  if (serializeMenuPrefs(next).length > COOKIE_BUDGET) return { ok: false, reason: "full" };
  return { ok: true, prefs: next };
}

export function removeItem(prefs: MenuPrefs, group: PersonalGroup, href: string): MenuPrefs {
  return { ...prefs, [group]: prefs[group].filter((entry) => entry.href !== href) };
}

export function moveItem(prefs: MenuPrefs, group: PersonalGroup, href: string, by: -1 | 1): MenuPrefs {
  const list = [...prefs[group]];
  const from = list.findIndex((entry) => entry.href === href);
  const to = from + by;
  if (from === -1 || to < 0 || to >= list.length) return prefs;
  [list[from], list[to]] = [list[to], list[from]];
  return { ...prefs, [group]: list };
}

export function hasItem(prefs: MenuPrefs, group: PersonalGroup, href: string): boolean {
  return prefs[group].some((entry) => entry.href === href);
}

export function toggleClosed(prefs: MenuPrefs, group: MenuGroup): MenuPrefs {
  return { ...prefs, closed: prefs.closed.includes(group) ? prefs.closed.filter((entry) => entry !== group) : [...prefs.closed, group] };
}

// Client side: one in-memory copy, written through to the cookie, with an event so
// every menu instance (rail and phone sheet) stays in step.
let current: MenuPrefs | null = null;

function readCookie(): string | null {
  try {
    const match = document.cookie.split("; ").find((entry) => entry.startsWith(`${MENU_COOKIE}=`));
    return match ? match.slice(MENU_COOKIE.length + 1) : null;
  } catch {
    return null;
  }
}

export function loadMenuPrefs(initial: MenuPrefs): MenuPrefs {
  if (current) return current;
  if (typeof document === "undefined") return initial;
  const raw = readCookie();
  current = raw ? parseMenuPrefs(raw) : initial;
  return current;
}

export function saveMenuPrefs(prefs: MenuPrefs): void {
  current = prefs;
  try {
    document.cookie = `${MENU_COOKIE}=${serializeMenuPrefs(prefs)}; path=/; max-age=31536000; samesite=lax${location.protocol === "https:" ? "; secure" : ""}`;
  } catch {
    // Cookies blocked: the change holds for this page view only.
  }
  window.dispatchEvent(new CustomEvent<MenuPrefs>(MENU_EVENT, { detail: prefs }));
}
