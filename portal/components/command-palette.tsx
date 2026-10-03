"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import { groupNavLinks, isCurrentPath, visibleNavLinks, type NavCapabilities } from "@/components/nav-links";
import { applyThemePreference, type ThemePreference } from "@/lib/theme";

interface Command {
  id: string;
  label: string;
  hint: string;
  keywords: string;
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

export function CommandPalette(capabilities: NavCapabilities) {
  const links = visibleNavLinks(capabilities);
  const router = useRouter();
  const pathname = usePathname();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [shortcut, setShortcut] = useState("⌘K");

  useEffect(() => {
    if (!/Mac|iPhone|iPad/.test(navigator.platform)) setShortcut("Ctrl K");
  }, []);

  const commands = useMemo<Command[]>(() => {
    const pages = groupNavLinks(links).flatMap((section) =>
      section.links.map((link) => ({
        id: `page:${link.href}`,
        label: link.label,
        hint: isCurrentPath(pathname, link.href) ? "Current page" : section.group,
        keywords: [section.group, link.aliases ?? ""].join(" ").trim(),
        run: () => router.push(link.href),
      })),
    );
    const themes = (["system", "light", "dark"] as ThemePreference[]).map((theme) => ({
      id: `theme:${theme}`,
      label: `Use ${theme} theme`,
      hint: "Appearance",
      keywords: "theme appearance colour color mode",
      run: () => applyThemePreference(theme),
    }));
    return [...pages, ...themes];
    // links is recomputed each render; key the memo on what it is derived from.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capabilities.canRead, capabilities.canPolicies, capabilities.canUsers, capabilities.canApprove, capabilities.canConfigure, pathname, router]);

  const results = commands
    .map((command, order) => ({ command, order, score: scoreCommand(command.label, command.keywords, query) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map((entry) => entry.command);

  function open() {
    setQuery("");
    setActive(0);
    dialogRef.current?.showModal();
    inputRef.current?.focus();
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
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <>
      <button className="palette-trigger" onClick={open} type="button">
        <span>Jump to…</span>
        <kbd>{shortcut}</kbd>
      </button>
      <dialog
        aria-label="Command palette"
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
            className="command-input"
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActive((index) => Math.min(index + 1, results.length - 1));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActive((index) => Math.max(index - 1, 0));
              } else if (event.key === "Enter") {
                event.preventDefault();
                run(results[active]);
              }
            }}
            placeholder="Go to a page or run a command"
            ref={inputRef}
            role="combobox"
            value={query}
          />
          <ul className="command-list" id={listId} role="listbox">
            {results.length ? results.map((command, index) => (
              <li
                aria-selected={index === active}
                className="command-item"
                id={`${listId}-${index}`}
                key={command.id}
                onClick={() => run(command)}
                onMouseMove={() => setActive(index)}
                role="option"
              >
                <span>{command.label}</span>
                <small>{command.hint}</small>
              </li>
            )) : <li className="command-empty">No page or command matches “{query}”.</li>}
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
