"use client";

import { useId, useRef, type ReactNode } from "react";

// How the button and its confirm step look:
// - primary: the screen's one main action; amber button, amber confirm.
// - neutral: any other change; outlined button, amber confirm.
// - danger: removes access or deletes; outlined button, red confirm inside the dialog only.
export type ConfirmTone = "primary" | "neutral" | "danger";

const TRIGGER_CLASS: Record<ConfirmTone, string> = { primary: "btn btn-primary", neutral: "btn", danger: "btn" };
const CONFIRM_CLASS: Record<ConfirmTone, string> = { primary: "btn btn-primary", neutral: "btn btn-primary", danger: "btn btn-danger" };

// A button that asks before it acts. For writes that take effect immediately with no
// approval step behind them (disabling a channel, pausing a SIEM feed), the dialog
// names exactly what changes; Cancel holds focus so Enter never confirms by accident.
// Red is kept for the final confirm of something that removes access or deletes.
export function ConfirmButton({
  cancelLabel = "Cancel",
  children,
  confirmLabel,
  description,
  disabled = false,
  onConfirm,
  size = "md",
  title,
  tone = "neutral",
}: {
  cancelLabel?: string;
  children: ReactNode;
  confirmLabel: string;
  description: ReactNode;
  disabled?: boolean;
  onConfirm: () => void | Promise<void>;
  size?: "sm" | "md";
  title: string;
  tone?: ConfirmTone;
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
        className={`${TRIGGER_CLASS[tone]}${sizeClass}`}
        data-tone={tone}
        disabled={disabled}
        onClick={() => dialogRef.current?.showModal()}
        type="button"
      >
        {children}
      </button>
      <dialog
        aria-labelledby={titleId}
        className="confirm-dialog"
        data-tone={tone}
        onClick={(event) => {
          // A click on the backdrop lands on the dialog element itself.
          if (event.target === event.currentTarget) close();
        }}
        ref={dialogRef}
      >
        <div className="confirm-dialog-body">
          <h2 id={titleId}>{title}</h2>
          <div className="confirm-dialog-description">{description}</div>
          <div className="form-actions">
            <button autoFocus className="btn" onClick={close} type="button">
              {cancelLabel}
            </button>
            <button
              className={CONFIRM_CLASS[tone]}
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
