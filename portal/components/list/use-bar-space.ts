"use client";

import { useEffect, type RefObject } from "react";

// A selection bar sticks to the bottom of the window and would cover the rows behind
// it (UI audit E4). While it shows, the page keeps that much room clear at the bottom:
// the bar's height goes into --sel-bar-space, which sets the page's scroll padding and
// the room after the list, so the last rows scroll clear of it and a row reached with
// the keyboard or just picked is never left under it.
export function useBarSpace(bar: RefObject<HTMLElement | null>, shown: boolean, row?: string | null) {
  useEffect(() => {
    const element = bar.current;
    if (!shown || !element) return;
    const root = document.documentElement;
    const measure = () => {
      const offset = parseFloat(getComputedStyle(element).bottom) || 0;
      root.style.setProperty("--sel-bar-space", `${Math.ceil(element.offsetHeight + offset + 8)}px`);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      root.style.removeProperty("--sel-bar-space");
    };
  }, [bar, shown]);

  // The row just picked stays in sight: if the bar now covers it, scroll it clear.
  useEffect(() => {
    const element = bar.current;
    if (!shown || !element || !row) return;
    const picked = document.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(row)}"]`);
    if (!picked) return;
    // Where the bar comes to rest, not where its slide-in animation has it now.
    const barTop = window.innerHeight - (parseFloat(getComputedStyle(element).bottom) || 0) - element.offsetHeight;
    if (picked.getBoundingClientRect().bottom > barTop) picked.scrollIntoView({ block: "nearest" });
  }, [bar, shown, row]);
}
