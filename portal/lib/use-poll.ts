"use client";

import { useEffect, useRef } from "react";

interface PollEnv {
  document: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;
  now: () => number;
}

/**
 * Calls `tick` every `intervalMs` while the tab is visible. A hidden tab keeps no timer
 * at all. On return, it ticks at once only if a tick fell due while away, so flicking
 * between tabs does not refetch. The caller has just loaded its data when this starts.
 * Returns a function that stops the poll.
 */
export function startPoll(tick: () => void, intervalMs: number, env: PollEnv = { document, now: Date.now }): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let last = env.now();
  const pause = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  // The next tick falls one interval after the last one, wherever the tab was meanwhile.
  const schedule = () => {
    pause();
    timer = setTimeout(() => {
      timer = null;
      last = env.now();
      // A tick that throws must not end the poll.
      try {
        tick();
      } finally {
        schedule();
      }
    }, Math.max(0, last + intervalMs - env.now()));
  };
  const onVisibility = () => {
    if (env.document.visibilityState !== "visible") return pause();
    if (env.now() - last >= intervalMs) {
      last = env.now();
      tick();
    }
    schedule();
  };
  if (env.document.visibilityState === "visible") schedule();
  env.document.addEventListener("visibilitychange", onVisibility);
  return () => {
    pause();
    env.document.removeEventListener("visibilitychange", onVisibility);
  };
}

/** Runs `tick` every `intervalMs` while the tab is visible (see `startPoll`). */
export function usePoll(tick: () => void, intervalMs: number, enabled = true): void {
  const latest = useRef(tick);
  latest.current = tick;

  useEffect(() => {
    if (!enabled) return;
    return startPoll(() => latest.current(), intervalMs);
  }, [intervalMs, enabled]);
}
