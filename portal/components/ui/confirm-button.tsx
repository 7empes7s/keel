"use client";

import { useId, useRef, type ReactNode } from "react";

// A button that asks before it acts. For writes that take effect immediately with no
// approval step behind them (disabling a channel, pausing a SIEM feed), the dialog
// names exactly what changes; Cancel holds focus so Enter never confirms by accident.
export function ConfirmButton({
  children,
  confirmLabel,
  description,
  disabled = false,
  onConfirm,
  size = "md",
  title,
}: {
  children: ReactNode;
  confirmLabel: string;
  description: ReactNode;
  disabled?: boolean;
  onConfirm: () => void | Promise<void>;
  size?: "sm" | "md";
  title: string;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const sizeClass = size === "sm" ? " btn-sm" : "";

  function close() {
    dialogRef.current?.close();
  }

  return (
    <>
      <button
        className={`btn btn-danger${sizeClass}`}
        disabled={disabled}
        onClick={() => dialogRef.current?.showModal()}
        type="button"
      >
        {children}
      </button>
      <dialog
        aria-labelledby={titleId}
        className="confirm-dialog"
        onClick={(event) => {
          // A click on the backdrop lands on the dialog element itself.
          if (event.target === event.currentTarget) close();
        }}
        ref={dialogRef}
      >
        <div className="confirm-dialog-body">
          <p className="severity-label">Confirm change</p>
          <h2 id={titleId}>{title}</h2>
          <div className="confirm-dialog-description">{description}</div>
          <div className="form-actions">
            <button autoFocus className="btn btn-ghost" onClick={close} type="button">
              Cancel
            </button>
            <button
              className="btn btn-danger"
              onClick={() => {
                close();
                void onConfirm();
              }}
              type="button"
            >
              {confirmLabel}
            </button>
          </div>
        </div>
      </dialog>
    </>
  );
}
