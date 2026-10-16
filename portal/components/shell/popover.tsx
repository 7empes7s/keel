"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";

// A button that opens a small panel under it: the bell, the cloud switcher, pickers.
// Esc or a click outside closes it and gives focus back to the button. The panel is
// drawn at the end of the page (a portal), so no scrolling or animated parent clips or
// moves it. On a phone it becomes a bottom sheet (CSS), with the same markup.
export function Popover({
  label,
  button,
  buttonClassName,
  panelClassName,
  title,
  children,
}: {
  label: string;
  button: ReactNode;
  buttonClassName?: string;
  panelClassName?: string;
  // Heading inside the panel, so a phone sheet says what it is.
  title?: string;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<CSSProperties>({});
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  function close(returnFocus = true) {
    setOpen(false);
    if (returnFocus) buttonRef.current?.focus();
  }

  // The panel is fixed to the viewport, so a scrolling menu never clips it; it opens
  // under its button and stays inside the window.
  useLayoutEffect(() => {
    if (!open) return;
    let frame = 0;
    function place() {
      const button = buttonRef.current?.getBoundingClientRect();
      const box = panelRef.current?.getBoundingClientRect();
      // The natural height, not the one a max-height has already cut short.
      const panel = box && panelRef.current ? { width: box.width, height: Math.max(box.height, panelRef.current.scrollHeight) } : null;
      if (!button || !panel) return;
      const left = Math.max(8, Math.min(button.left, window.innerWidth - panel.width - 8));
      // Opens upwards when there is no room below, and never above the window's top.
      const below = button.bottom + 6;
      const top = below + panel.height > window.innerHeight - 8 && button.top - 6 - panel.height >= 8 ? button.top - 6 - panel.height : below;
      setPlace({ "--pop-top": `${Math.round(top)}px`, "--pop-left": `${Math.round(left)}px` } as CSSProperties);
    }
    function measure() {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(place);
    }
    place();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
      cancelAnimationFrame(frame);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector<HTMLElement>("a[href], button:not([disabled]), input, [tabindex='0']")?.focus();
    function onPointer(event: PointerEvent) {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !panelRef.current?.contains(target)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
      } else if (event.key === "Tab" && panelRef.current?.contains(document.activeElement)) {
        // Keep Tab inside the open panel; Esc leaves it.
        const items = [...panelRef.current.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), input, [tabindex='0']")];
        const at = items.indexOf(document.activeElement as HTMLElement);
        const next = event.shiftKey ? (at <= 0 ? items.length - 1 : at - 1) : (at === items.length - 1 ? 0 : at + 1);
        event.preventDefault();
        items[next]?.focus();
      }
    }
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="popover" ref={rootRef}>
      <button
        aria-controls={id}
        aria-expanded={open}
        aria-label={label}
        className={buttonClassName}
        onClick={() => setOpen((value) => !value)}
        ref={buttonRef}
        type="button"
      >
        {button}
      </button>
      {open ? createPortal(
        <>
          <div aria-hidden="true" className="popover-scrim" onClick={() => close(false)} />
          <div aria-label={title ?? label} className={panelClassName ? `popover-panel ${panelClassName}` : "popover-panel"} id={id} ref={panelRef} role="dialog" style={place}>
            {title ? <p className="popover-title">{title}</p> : null}
            {children(() => close())}
          </div>
        </>,
        document.body,
      ) : null}
    </div>
  );
}
