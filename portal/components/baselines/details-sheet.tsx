"use client";

import { useEffect, useId, useRef, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { Icon } from "@/components/shell/icons";
import { stepWords, type SheetStep } from "@/lib/sheet-step";

// The details panel (direction A): a panel from the right on a desktop and a full-screen
// sheet on a phone, opening on a short spring (none under reduced motion). Esc, the
// close button or the scrim closes it, and focus returns to what opened it. Tab stays
// inside while it is open.
export function DetailsSheet(props: SheetProps) {
  // The panel goes into the page body, which only the browser has. A link that opens an
  // item (`?open=`) drew it on the server too, which failed there ("document is not
  // defined") and made React redraw the whole page in the browser. It now appears just
  // after the page is drawn in the browser.
  const inBrowser = useSyncExternalStore(noChange, () => true, () => false);
  return inBrowser ? <SheetPanel {...props} /> : null;
}

type SheetProps = {
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
};

function SheetPanel({ title, kicker, onClose, children, footer, wide = false, step = null, onStep, noun = "item" }: SheetProps) {
  const id = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const stepPressed = useRef<"previous" | "next" | null>(null);
  const index = step?.index;
  // A new item opens at its top. Reaching either end disables the button just pressed,
  // so focus moves to the other one instead of falling out of the panel.
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
    const pressed = stepPressed.current;
    stepPressed.current = null;
    const nav = panelRef.current?.querySelector(".bl-sheet-step");
    const buttons = nav ? [...nav.querySelectorAll<HTMLButtonElement>("button")] : [];
    const own = pressed === "previous" ? buttons[0] : pressed === "next" ? buttons[1] : null;
    if (own?.disabled) buttons.find((button) => !button.disabled)?.focus();
  }, [index]);
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
              <button aria-label={`Previous ${noun}`} className="icon-button" disabled={!step.previous} onClick={() => { if (step.previous) { stepPressed.current = "previous"; onStep(step.previous); } }} title={`Previous ${noun}`} type="button"><Icon name="chevron" /></button>
              <span aria-live="polite">{stepWords(step)}</span>
              <button aria-label={`Next ${noun}`} className="icon-button" disabled={!step.next} onClick={() => { if (step.next) { stepPressed.current = "next"; onStep(step.next); } }} title={`Next ${noun}`} type="button"><Icon name="chevron" /></button>
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

const noChange = () => () => {};
