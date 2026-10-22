"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { Icon } from "@/components/shell/icons";
import { stepWords, type SheetStep } from "@/lib/sheet-step";

// The details panel (direction A): a panel from the right on a desktop and a full-screen
// sheet on a phone, opening on a short spring (none under reduced motion). Esc, the
// close button or the scrim closes it, and focus returns to what opened it. Tab stays
// inside while it is open.
export function DetailsSheet({ title, kicker, onClose, children, footer, wide = false, step = null, onStep, noun = "item" }: {
  title: string;
  kicker?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  // Previous and next through the list the item was opened from ("3 of 12"). `noun`
  // names one item for the buttons ("change" reads "Next change").
  step?: SheetStep | null;
  onStep?: (id: string) => void;
  noun?: string;
}) {
  const id = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const index = step?.index;
  // A new item opens at its top.
  useEffect(() => { if (bodyRef.current) bodyRef.current.scrollTop = 0; }, [index]);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape" && !document.querySelector(".popover-panel")) {
        event.stopPropagation();
        closeRef.current();
      } else if (event.key === "Tab" && panelRef.current) {
        const items = [...panelRef.current.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), input, summary, [tabindex='0']")];
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    }
    document.addEventListener("keydown", onKey);
    document.body.dataset.sheetOpen = "";
    return () => {
      document.removeEventListener("keydown", onKey);
      delete document.body.dataset.sheetOpen;
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  return createPortal(
    <div className="bl-sheet-root">
      <div aria-hidden="true" className="bl-sheet-scrim" onClick={() => onClose()} />
      <div aria-labelledby={`${id}-title`} aria-modal="true" className="bl-sheet" data-wide={wide || undefined} ref={panelRef} role="dialog" tabIndex={-1}>
        <header className="bl-sheet-head">
          <div>
            {kicker ? <div className="bl-sheet-kicker">{kicker}</div> : null}
            <h2 id={`${id}-title`}>{title}</h2>
          </div>
          {step && onStep ? (
            <nav aria-label={`Move between ${noun}s`} className="bl-sheet-step">
              <button aria-label={`Previous ${noun}`} className="icon-button" disabled={!step.previous} onClick={() => step.previous && onStep(step.previous)} title={`Previous ${noun}`} type="button"><Icon name="chevron" /></button>
              <span aria-live="polite">{stepWords(step)}</span>
              <button aria-label={`Next ${noun}`} className="icon-button" disabled={!step.next} onClick={() => step.next && onStep(step.next)} title={`Next ${noun}`} type="button"><Icon name="chevron" /></button>
            </nav>
          ) : null}
          <button aria-label="Close" className="icon-button bl-sheet-close" onClick={() => onClose()} title="Close (Esc)" type="button"><Icon name="close" /></button>
        </header>
        <div className="bl-sheet-body" ref={bodyRef}>{children}</div>
        {footer ? <footer className="bl-sheet-foot">{footer}</footer> : null}
      </div>
    </div>,
    document.body,
  );
}
