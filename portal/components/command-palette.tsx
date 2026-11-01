"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import { Icon, type IconName } from "@/components/shell/icons";
import { groupNavLinks, isCurrentPath, SECTION_ICONS, visibleNavLinks, type NavCapabilities, type NavSection } from "@/components/nav-links";
import { useShellState } from "@/components/shell/shell-state";
import { postAction } from "@/lib/action-client";
import { typeName } from "@/lib/protect-view";
import { toast } from "@/lib/toast";
import { applyThemePreference, type ThemePreference } from "@/lib/theme";

// What the palette finds. Empty, it lists actions first, as the mockup does; once
// something is typed, the group with the best match leads and ties keep this order.
export const PALETTE_GROUPS = ["Pages", "Your views", "Actions", "People and settings"] as const;
const EMPTY_ORDER: PaletteGroup[] = ["Actions", "Pages", "Your views"];
export type PaletteGroup = (typeof PALETTE_GROUPS)[number];

export interface Command {
  id: string;
  label: string;
  hint: string;
  keywords: string;
  group: PaletteGroup;
  icon: IconName;
  run: () => void;
}

function isSubsequence(text: string, query: string): boolean {
  let position = 0;
  for (const character of query) {
    position = text.indexOf(character, position);
    if (position === -1) return false;
    position += 1;
  }
  return true;
}

// Ranks a command against what was typed: label prefix beats a word inside the label,
// which beats keyword hits, which beat a loose in-order match on the label ("bkp" finds
// Backups). Zero means no match. Loose matching applies only to the label, so short
// queries do not match everything through long keyword strings.
export function scoreCommand(label: string, keywords: string, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  const name = label.toLowerCase();
  if (name.startsWith(q)) return 4;
  if (name.split(/\s+/).some((word) => word.startsWith(q))) return 3;
  if (keywords.toLowerCase().split(/\s+/).some((word) => word.startsWith(q))) return 2;
  return isSubsequence(name, q.replace(/\s+/g, "")) ? 1 : 0;
}

// Any search button opens the one palette through this event, so the menu, the phone's
// top bar and the keyboard shortcut all share it.
export const PALETTE_EVENT = "keel-open-palette";

export function openCommandPalette(): void {
  window.dispatchEvent(new Event(PALETTE_EVENT));
}

/**
 * The matches for what was typed, in groups. People and setting types show
 * only once something is typed, so the empty palette stays short. The group with the
 * best match comes first; inside a group, better matches first, then the given order.
 */
export function paletteResults(commands: Command[], query: string): { group: PaletteGroup; commands: Command[] }[] {
  const typed = query.trim().length > 0;
  const scored = commands
    .filter((command) => typed || command.group !== "People and settings")
    .map((command, order) => ({ command, order, score: scoreCommand(command.label, command.keywords, query) }))
    .filter((entry) => entry.score > 0);
  return PALETTE_GROUPS
    .map((group) => {
      const entries = scored.filter((entry) => entry.command.group === group).sort((a, b) => b.score - a.score || a.order - b.order);
      return { group, best: entries[0]?.score ?? 0, rank: PALETTE_GROUPS.indexOf(group), commands: entries.map((entry) => entry.command) };
    })
    .filter((entry) => entry.commands.length > 0)
    .sort((a, b) => (typed ? b.best - a.best || a.rank - b.rank : EMPTY_ORDER.indexOf(a.group) - EMPTY_ORDER.indexOf(b.group)))
    .map(({ group, commands: found }) => ({ group, commands: found }));
}

const VIEW_HINTS = { pinned: "Pinned", favourites: "Favourite" } as const;

interface Found { id: string; label: string; hint: string; href: string; icon: IconName; keywords: string }

// People and kinds of settings, read once when the palette first opens, from the same
// routes their pages use (each refuses what this person may not read). A failed read
// leaves that group out; the rest of the palette still works.
async function readItems(capabilities: NavCapabilities): Promise<Found[]> {
  const found: Found[] = [];
  const read = async (url: string) => {
    try {
      const response = await fetch(url, { cache: "no-store" });
      return response.ok ? await response.json() as Record<string, unknown> : null;
    } catch {
      return null;
    }
  };
  const [people, coverage] = await Promise.all([
    capabilities.canUsers ? read("/api/principals") : null,
    capabilities.canRead ? read("/api/coverage") : null,
  ]);
  for (const person of (people?.principals as { id: string; email: string; display_name?: string | null; system_kind?: string | null; disabled_at: string | null }[] | undefined) ?? []) {
    if (person.system_kind) continue;
    found.push({
      id: `person:${person.id}`,
      label: person.display_name || person.email,
      hint: person.disabled_at ? "Person · disabled" : "Person",
      href: `/people#person-${encodeURIComponent(person.id)}`,
      icon: "settings",
      keywords: `person people ${person.email}`,
    });
  }
  for (const entry of (coverage?.types as { type: string }[] | undefined) ?? []) {
    found.push({
      id: `type:${entry.type}`,
      label: typeName(entry.type),
      hint: "Setting type",
      href: "/protect",
      icon: "backup",
      keywords: "setting settings backup",
    });
  }
  return found;
}

export function usePaletteShortcut(): string {
  const [shortcut, setShortcut] = useState("Ctrl K");
  useEffect(() => {
    if (/Mac|iPhone|iPad/.test(navigator.platform)) setShortcut("⌘K");
  }, []);
  return shortcut;
}

/** A search box look-alike that opens the palette. */
export function SearchTrigger({ compact = false }: { compact?: boolean }) {
  const shortcut = usePaletteShortcut();
  return (
    <button aria-label={compact ? "Search or jump to a page" : undefined} className={compact ? "icon-button" : "search-trigger"} onClick={openCommandPalette} type="button">
      <Icon name="search" />
      {compact ? null : <><span>Search or jump to…</span><kbd>{shortcut}</kbd></>}
    </button>
  );
}

export function CommandPalette(capabilities: NavCapabilities) {
  const links = visibleNavLinks(capabilities);
  const router = useRouter();
  const pathname = usePathname();
  const { prefs } = useShellState();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [items, setItems] = useState<Found[] | null>(null);
  const backupKey = useRef<string | null>(null);

  async function backUpCritical() {
    backupKey.current ??= crypto.randomUUID();
    try {
      const { payload } = await postAction("/api/actions/backup", { tier: "tier1" }, backupKey.current);
      backupKey.current = null;
      const job = payload.job as { id: string; status: string };
      if (payload.alreadyActive === true) {
        toast({ tone: "info", title: `The critical settings backup is already ${job.status === "running" ? "running" : "queued"}`, detail: "Keel does not start the same tier twice.", href: `/jobs/${encodeURIComponent(job.id)}`, hrefLabel: "Watch it" });
      } else {
        toast({ title: "Backup queued for the critical settings", detail: "It starts when a worker is free and only reads your tenant; nothing changes.", href: `/jobs/${encodeURIComponent(job.id)}`, hrefLabel: "Watch it" });
      }
    } catch {
      toast({ tone: "warning", title: "Backup not started", detail: "Keel could not start the backup of the critical settings. Try again from What's protected." });
    }
  }

  const commands = useMemo<Command[]>(() => {
    const pages: Command[] = groupNavLinks(links).flatMap((section) =>
      section.links.map((link) => ({
        id: `page:${link.href}`,
        label: link.label,
        hint: isCurrentPath(pathname, link.href) ? "Current page" : section.group,
        keywords: [section.group, link.aliases ?? ""].join(" ").trim(),
        group: "Pages" as const,
        icon: SECTION_ICONS[section.group as NavSection] ?? "page",
        run: () => router.push(link.href),
      })),
    );
    const views: Command[] = (["pinned", "favourites"] as const).flatMap((kind) =>
      prefs[kind].map((item) => ({
        id: `view:${kind}:${item.href}`,
        label: item.label,
        hint: VIEW_HINTS[kind],
        keywords: `${VIEW_HINTS[kind]} view saved`,
        group: "Your views" as const,
        icon: item.icon,
        run: () => router.push(item.href),
      })),
    );
    const go = (id: string, label: string, hint: string, href: string, icon: IconName, keywords: string): Command =>
      ({ id, label, hint, keywords, group: "Actions", icon, run: () => router.push(href) });
    const actions: Command[] = [
      ...(capabilities.canBackup ? [{ id: "action:backup", label: "Back up the critical settings now", hint: "Backup", keywords: "backup run tier 1 now", group: "Actions" as const, icon: "backup" as IconName, run: () => void backUpCritical() }] : []),
      go("action:restore", "Restore from a backup", "Restore", "/restore", "restore", "restore undo put back recover"),
      ...(capabilities.canRead ? [go("action:compare", "Compare two backups", "Baselines", "/compare", "baselines", "compare differences")] : []),
      ...(capabilities.canUsers ? [go("action:person", "Add a person", "Settings", "/people", "settings", "add person people invite role")] : []),
      ...(capabilities.canRead ? [go("action:channel", "Add an alert channel", "Settings", "/notifications", "bell", "add channel notification email teams slack webhook")] : []),
      ...(["system", "light", "dark"] as ThemePreference[]).map((theme) => ({
        id: `theme:${theme}`,
        label: `Use ${theme} theme`,
        hint: "Appearance",
        keywords: "theme appearance colour color mode",
        group: "Actions" as const,
        icon: (theme === "system" ? "monitor" : theme === "light" ? "sun" : "moon") as IconName,
        run: () => applyThemePreference(theme),
      })),
    ];
    const found: Command[] = (items ?? []).map((item) => ({
      id: item.id, label: item.label, hint: item.hint, keywords: item.keywords, group: "People and settings" as const, icon: item.icon, run: () => router.push(item.href),
    }));
    return [...pages, ...views, ...actions, ...found];
    // links is recomputed each render; key the memo on what it is derived from.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capabilities.canRead, capabilities.canPolicies, capabilities.canUsers, capabilities.canApprove, capabilities.canConfigure, capabilities.canBackup, pathname, router, prefs, items]);

  const groups = paletteResults(commands, query);
  const results = groups.flatMap((entry) => entry.commands);

  function open() {
    setQuery("");
    setActive(0);
    dialogRef.current?.showModal();
    inputRef.current?.focus();
    if (items === null) {
      setItems([]);
      void readItems(capabilities).then(setItems);
    }
  }

  function close() {
    dialogRef.current?.close();
  }

  function run(command: Command | undefined) {
    if (!command) return;
    close();
    command.run();
  }

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (dialogRef.current?.open) close();
        else open();
      }
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener(PALETTE_EVENT, open);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(PALETTE_EVENT, open);
    };
  });

  let index = -1;
  return (
    <>
      <dialog
        aria-label="Search"
        className="command-palette"
        onClick={(event) => {
          if (event.target === event.currentTarget) close();
        }}
        ref={dialogRef}
      >
        <div className="command-palette-body">
          <input
            aria-activedescendant={results[active] ? `${listId}-${active}` : undefined}
            aria-autocomplete="list"
            aria-controls={listId}
            aria-expanded="true"
            aria-label="Search pages, your views, actions, people and settings"
            className="command-input"
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActive((current) => Math.min(current + 1, results.length - 1));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActive((current) => Math.max(current - 1, 0));
              } else if (event.key === "Enter") {
                event.preventDefault();
                run(results[active]);
              }
            }}
            placeholder="Search or jump to…"
            ref={inputRef}
            role="combobox"
            value={query}
          />
          <ul className="command-list" id={listId} role="listbox">
            {groups.length ? groups.map((entry) => (
              <li className="command-group" key={entry.group} role="presentation">
                <span aria-hidden="true" className="command-group-title">{entry.group}</span>
                <ul aria-label={entry.group} role="group">
                  {entry.commands.map((command) => {
                    index += 1;
                    const position = index;
                    return (
                      <li
                        aria-selected={position === active}
                        className="command-item"
                        id={`${listId}-${position}`}
                        key={command.id}
                        onClick={() => run(command)}
                        onMouseMove={() => setActive(position)}
                        role="option"
                      >
                        <Icon name={command.icon} />
                        <span className="command-label">{command.label}</span>
                        <small>{command.hint}</small>
                      </li>
                    );
                  })}
                </ul>
              </li>
            )) : <li className="command-empty">Nothing matches “{query}”.</li>}
          </ul>
          <p className="command-footer">
            <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
            <span><kbd>↵</kbd> open</span>
            <span><kbd>esc</kbd> close</span>
          </p>
        </div>
      </dialog>
    </>
  );
}
