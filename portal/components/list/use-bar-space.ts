"use client";

import { useEffect, type RefObject } from "react";

const spaces = new Map<object, number>();
function applySpace() {
  const root = document.documentElement;
  if (spaces.size) root.style.setProperty("--sel-bar-space", `${Math.max(...spaces.values())}px`);
  else root.style.removeProperty("--sel-bar-space");
}

// A selection bar sticks to the bottom of the window and would cover the rows behind
// it (UI audit E4). While it shows, the page keeps that much room clear at the bottom:
// the bar's height goes into --sel-bar-space, which sets the page's scroll padding, so a
// row reached with the keyboard or Find, or just picked, is never left under it. A page
// can show two bars (What's protected); the tallest one sets the space.
export function useBarSpace(bar: RefObject<HTMLElement | null>, shown: boolean, row?: string | null) {
  useEffect(() => {
    const element = bar.current;
    if (!shown || !element) return;
    const key = {};
    const measure = () => {
      const offset = parseFloat(getComputedStyle(element).bottom) || 0;
      spaces.set(key, Math.ceil(element.offsetHeight + offset + 8));
      applySpace();
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      spaces.delete(key);
      applySpace();
    };
  }, [bar, shown]);

  // The row just picked stays in sight: if the bar now covers it, scroll it clear.
  useEffect(() => {
    const element = bar.current;
    if (!shown || !element || !row) return;
    const list = element.parentElement ?? document;
    const picked = list.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(row)}"]`);
    if (!picked) return;
    // Where the bar comes to rest, not where its slide-in animation has it now.
    const barTop = window.innerHeight - (parseFloat(getComputedStyle(element).bottom) || 0) - element.offsetHeight;
    if (picked.getBoundingClientRect().bottom > barTop) picked.scrollIntoView({ block: "nearest" });
  }, [bar, shown, row]);
}
