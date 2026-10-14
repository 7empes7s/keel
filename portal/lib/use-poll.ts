"use client";

import { useEffect, useRef } from "react";

/** Runs `tick` every `intervalMs` while the tab is visible, and once on return to it. */
export function usePoll(tick: () => void, intervalMs: number, enabled = true): void {
  const latest = useRef(tick);
  latest.current = tick;

  useEffect(() => {
    if (!enabled) return;
    const run = () => {
      if (document.visibilityState === "visible") latest.current();
    };
    const timer = setInterval(run, intervalMs);
    document.addEventListener("visibilitychange", run);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", run);
    };
  }, [intervalMs, enabled]);
}
