"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useTransition } from "react";

// Every poll is one request that holds one of the portal's 8 database connections until
// the server answers. A poll that fires again before the last answer came back stacks
// requests on the server, and a few open pages then fill every connection, so everyone
// sees "Keel is busy". So a poll never starts while its previous read is still running,
// and it never runs while the tab is hidden.

/** Whether a new poll may start now: the tab is visible and the last read has finished. */
export function shouldPoll(visibility: DocumentVisibilityState, inFlight: boolean): boolean {
  return visibility === "visible" && !inFlight;
}

export interface PollEnv {
  document: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;
  now: () => number;
}

/**
 * Calls `tick` every `intervalMs` while the tab is visible. A hidden tab keeps no timer
 * at all. On return to the tab it ticks at once only if a tick fell due while away, so
 * flicking between tabs does not refetch, and then keeps the schedule. When `tick`
 * returns a promise, no new tick starts until it settles. The caller has just loaded its
 * data when this starts. Returns a function that stops the poll.
 */
export function startPoll(
  tick: () => void | Promise<unknown>,
  intervalMs: number,
  env: PollEnv = { document, now: Date.now },
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let last = env.now();
  let inFlight = false;
  const run = () => {
    last = env.now();
    if (!shouldPoll(env.document.visibilityState, inFlight)) return;
    const result = tick();
    if (result && typeof (result as Promise<unknown>).finally === "function") {
      inFlight = true;
      void (result as Promise<unknown>).catch(() => undefined).finally(() => { inFlight = false; });
    }
  };
  const pause = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  // The next tick falls one interval after the last one, wherever the tab was meanwhile.
  const schedule = () => {
    pause();
    timer = setTimeout(() => {
      timer = null;
      // A tick that throws must not end the poll.
      try {
        run();
      } finally {
        schedule();
      }
    }, Math.max(0, last + intervalMs - env.now()));
  };
  const onVisibility = () => {
    if (env.document.visibilityState !== "visible") return pause();
    try {
      if (env.now() - last >= intervalMs) run();
    } finally {
      schedule();
    }
  };
  if (env.document.visibilityState === "visible") schedule();
  env.document.addEventListener("visibilitychange", onVisibility);
  return () => {
    pause();
    env.document.removeEventListener("visibilitychange", onVisibility);
  };
}

/** Runs `tick` every `intervalMs` while the tab is visible (see `startPoll`). */
export function usePoll(tick: () => void | Promise<unknown>, intervalMs: number, enabled = true): void {
  const latest = useRef(tick);
  latest.current = tick;

  useEffect(() => {
    if (!enabled) return;
    return startPoll(() => latest.current(), intervalMs);
  }, [intervalMs, enabled]);
}

/**
 * Re-reads the page's server data every `intervalMs` while the tab is visible. A refresh
 * still running (a slow page) is never stacked with another one.
 */
export function useRefreshPoll(intervalMs: number, enabled = true): void {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const pendingRef = useRef(pending);
  pendingRef.current = pending;

  useEffect(() => {
    if (!enabled) return;
    return startPoll(() => {
      if (pendingRef.current) return;
      // Marked pending right away, so a tick before React re-renders cannot stack another.
      pendingRef.current = true;
      startTransition(() => router.refresh());
    }, intervalMs);
  }, [intervalMs, enabled, router]);
}
