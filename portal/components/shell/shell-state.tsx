"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

import { addItem, EMPTY_PREFS, loadMenuPrefs, MENU_EVENT, saveMenuPrefs, type MenuItem, type MenuPrefs, type PersonalGroup } from "@/lib/menu-prefs";
import { toast } from "@/lib/toast";

interface ShellState {
  prefs: MenuPrefs;
  update: (next: MenuPrefs) => void;
  // Adds to Pinned, Favourites or Custom, and says so when the group is full.
  add: (group: PersonalGroup, item: MenuItem) => boolean;
}

const GROUP_NAMES: Record<PersonalGroup, string> = { pinned: "Pinned", favourites: "Favourites", custom: "Custom" };

const ShellContext = createContext<ShellState>({ prefs: EMPTY_PREFS, update: () => {}, add: () => false });

export function ShellStateProvider({ initial, children }: { initial: MenuPrefs; children: ReactNode }) {
  const [prefs, setPrefs] = useState<MenuPrefs>(() => loadMenuPrefs(initial));

  useEffect(() => {
    const sync = (event: Event) => setPrefs((event as CustomEvent<MenuPrefs>).detail);
    window.addEventListener(MENU_EVENT, sync);
    return () => window.removeEventListener(MENU_EVENT, sync);
  }, []);

  const update = useCallback((next: MenuPrefs) => saveMenuPrefs(next), []);
  const add = useCallback((group: PersonalGroup, item: MenuItem) => {
    const result = addItem(loadMenuPrefs(prefs), group, item);
    if (!result.ok) {
      toast({
        tone: "warning",
        title: result.reason === "full" ? `${GROUP_NAMES[group]} is full` : "This page can't be added",
        detail: result.reason === "full" ? "Remove something from it first, then try again." : "Only pages inside Keel can go in the menu.",
      });
      return false;
    }
    saveMenuPrefs(result.prefs);
    return true;
  }, [prefs]);

  return <ShellContext.Provider value={{ prefs, update, add }}>{children}</ShellContext.Provider>;
}

export function useShellState(): ShellState {
  return useContext(ShellContext);
}
