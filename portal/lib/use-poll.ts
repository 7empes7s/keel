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

/**
 * Runs `tick` every `intervalMs` while the tab is visible, and once on return to it.
 * When `tick` returns a promise, no new tick starts until it settles.
 */
export function usePoll(tick: () => void | Promise<unknown>, intervalMs: number, enabled = true): void {
  const latest = useRef(tick);
  latest.current = tick;

  useEffect(() => {
    if (!enabled) return;
    let inFlight = false;
    const run = () => {
      if (!shouldPoll(document.visibilityState, inFlight)) return;
      const result = latest.current();
      if (result && typeof (result as Promise<unknown>).finally === "function") {
        inFlight = true;
        void (result as Promise<unknown>).catch(() => undefined).finally(() => { inFlight = false; });
      }
    };
    const timer = setInterval(run, intervalMs);
    document.addEventListener("visibilitychange", run);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", run);
    };
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
    const run = () => {
      if (!shouldPoll(document.visibilityState, pendingRef.current)) return;
      // Marked pending right away, so a tick before React re-renders cannot stack another.
      pendingRef.current = true;
      startTransition(() => router.refresh());
    };
    const timer = setInterval(run, intervalMs);
    document.addEventListener("visibilitychange", run);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", run);
    };
  }, [intervalMs, enabled, router]);
}
