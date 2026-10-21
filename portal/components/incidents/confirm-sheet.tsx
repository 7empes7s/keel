"use client";

import { useState, type FormEvent, type ReactNode } from "react";

import { DetailsSheet } from "@/components/baselines/details-sheet";

// One sheet for every step that asks first: keep a backup, let clean-up remove it,
// allow a restore anyway, withdraw that permission, close an incident. It says what
// will happen before anything happens and, where the engine keeps a reason, needs one.
export function ConfirmSheet({ title, kicker, effect, reasonLabel, placeholder, confirmLabel, onConfirm, onClose, children }: {
  title: string;
  kicker: ReactNode;
  effect: string;
  // Absent when the step keeps no reason (closing, withdrawing).
  reasonLabel?: string;
  placeholder?: string;
  confirmLabel: string;
  // Resolves to an error sentence, or null when it worked.
  onConfirm: (reason: string) => Promise<string | null>;
  onClose: () => void;
  children?: ReactNode;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (reasonLabel && !reason.trim()) { setError("Write why. It is kept with the record."); return; }
    setBusy(true);
    try {
      const failed = await onConfirm(reason.trim());
      if (failed) setError(failed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <DetailsSheet
      footer={<>
        <button aria-busy={busy || undefined} className="btn" disabled={busy} form="ir-confirm" type="submit">{confirmLabel}</button>
        <button className="btn btn-ghost" onClick={onClose} type="button">Cancel</button>
      </>}
      kicker={kicker}
      onClose={onClose}
      title={title}
    >
      <form className="ir-form" id="ir-confirm" onSubmit={submit}>
        <p className="ir-effect">{effect}</p>
        {children}
        {reasonLabel ? (
          <label className="filter-field">
            <span>{reasonLabel}</span>
            <textarea disabled={busy} maxLength={1000} name="reason" onChange={(event) => setReason(event.target.value)} placeholder={placeholder} rows={3} value={reason} />
          </label>
        ) : null}
        {error ? <p className="ir-error" role="alert">{error}</p> : null}
      </form>
    </DetailsSheet>
  );
}
