"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { Icon, type IconName } from "@/components/shell/icons";
import { ShowDetails } from "@/components/ui/alert-list";
import { plainError, rawErrorText } from "@/lib/error-words";
import {
  dismissToast,
  getServerToasts,
  getToasts,
  subscribeToasts,
  type Toast,
} from "@/lib/toast";

const LIFETIME_MS = 6000;
const EXIT_MS = 200;
const TONE_ICONS: Record<Toast["tone"], IconName> = { success: "check", info: "info", warning: "alert" };

function ToastItem({ item }: { item: Toast }) {
  // A failure reads like the shared error notice: plain cause, "What to do:", and the
  // raw answer only behind "Show details".
  const failed = item.error !== undefined;
  const words = failed ? plainError(item.error, { service: "Keel" }) : null;
  const detail = item.detail ?? words?.cause;
  const todo = item.todo ?? words?.todo;
  const raw = failed ? rawErrorText(item.error) : null;
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
      data-error-notice={failed ? "" : undefined}
      onBlur={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <span aria-hidden="true" className="toast-icon"><Icon name={TONE_ICONS[item.tone]} /></span>
      <div className="toast-body">
        <strong>{item.title}</strong>
        {detail ? <p>{detail}</p> : null}
        {todo ? <p className="toast-todo"><b>What to do:</b> {todo}</p> : null}
        {raw ? <ShowDetails lines={[<code className="ui-raw-error" key="raw">{raw}</code>]} /> : null}
        {item.href ? (
          <Link className="toast-link" href={item.href} onClick={close}>
            {item.hrefLabel ?? "Open"} <span aria-hidden="true">→</span>
          </Link>
        ) : null}
        {item.action ? (
          <button className="toast-action" onClick={() => { close(); item.action?.run(); }} type="button">
            {item.action.label}
          </button>
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
