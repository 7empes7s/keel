"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import {
  dismissToast,
  getServerToasts,
  getToasts,
  subscribeToasts,
  type Toast,
} from "@/lib/toast";

const LIFETIME_MS = 6000;
const EXIT_MS = 200;

function ToastItem({ item }: { item: Toast }) {
  const [leaving, setLeaving] = useState(false);
  const [paused, setPaused] = useState(false);
  const remaining = useRef(LIFETIME_MS);
  const startedAt = useRef(0);

  function close() {
    setLeaving(true);
    setTimeout(() => dismissToast(item.id), EXIT_MS);
  }

  // Counts down only while not hovered or focused, so a toast never vanishes
  // under the pointer of someone reading it.
  useEffect(() => {
    if (paused || leaving) return undefined;
    startedAt.current = Date.now();
    const timer = setTimeout(close, remaining.current);
    return () => {
      clearTimeout(timer);
      remaining.current -= Date.now() - startedAt.current;
    };
    // close is stable for the lifetime of this item.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paused, leaving]);

  return (
    <li
      className={`toast toast-${item.tone}${leaving ? " toast-leaving" : ""}`}
      onBlur={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <span aria-hidden="true" className="toast-icon">{item.tone === "warning" ? "!" : item.tone === "info" ? "i" : "✓"}</span>
      <div className="toast-body">
        <strong>{item.title}</strong>
        {item.detail ? <p>{item.detail}</p> : null}
        {item.href ? (
          <Link className="toast-link" href={item.href} onClick={close}>
            {item.hrefLabel ?? "Open"} <span aria-hidden="true">→</span>
          </Link>
        ) : null}
      </div>
      <button aria-label="Dismiss notification" className="toast-close" onClick={close} type="button">×</button>
      <span aria-hidden="true" className={`toast-timer${paused ? " toast-timer-paused" : ""}`} />
    </li>
  );
}

export function Toaster() {
  const toasts = useSyncExternalStore(subscribeToasts, getToasts, getServerToasts);
  return (
    <section aria-label="Notifications" aria-live="polite" className="toaster">
      <ol>
        {toasts.map((item) => <ToastItem item={item} key={item.id} />)}
      </ol>
    </section>
  );
}
