"use client";

import { useState, type ReactNode } from "react";

// Portal experience contract, the record layer: every identifier, hash and raw value
// lives here, collapsed under "Technical details", each labelled with what it is and
// where it is accepted, with a copy control.
export function TechnicalDetails({ children, summary = "Technical details" }: { children: ReactNode; summary?: string }) {
  return (
    <details className="technical-details" data-layer="record">
      <summary>{summary}</summary>
      <dl className="technical-fields">{children}</dl>
    </details>
  );
}

export function RecordField({ label, value, usage, copy = true }: { label: string; value: string | null; usage?: ReactNode; copy?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="technical-field">
      <dt>{label}</dt>
      <dd>
        <code>{value ?? "none"}</code>
        {copy && value ? (
          <button
            aria-label={`Copy ${label}`}
            className="btn btn-ghost btn-sm technical-copy"
            onClick={() => {
              void navigator.clipboard?.writeText(value).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              });
            }}
            type="button"
          >
            {copied ? "Copied" : "Copy"}
          </button>
        ) : null}
        {usage ? <small className="technical-usage">{usage}</small> : null}
      </dd>
    </div>
  );
}
