"use client";

import { useState, type ReactNode } from "react";

// Portal experience contract, the record layer: every identifier, hash and raw value
// lives here, collapsed under "Technical details", each labelled with what it is and
// where it is accepted, with a copy control.
//
// The markup must stay `<details class="technical-details" data-layer="record">` with no
// nested <details>: the visible-text tests strip the record up to its first </details>.
export function TechnicalDetails({ children, summary = "Technical details" }: { children: ReactNode; summary?: string }) {
  return (
    <details className="technical-details" data-layer="record">
      <summary><span className="technical-summary-text">{summary}</span><span aria-hidden="true" className="technical-summary-hint">IDs and raw values</span></summary>
      <div className="technical-body">
        <dl className="technical-fields">{children}</dl>
      </div>
    </details>
  );
}

/** A titled block of fields for one object (a job, a request, a channel), so a record
 *  that covers a whole list says which object each field belongs to. */
export function RecordGroup({ title, note, children }: { title: ReactNode; note?: ReactNode; children: ReactNode }) {
  return (
    <div className="technical-group">
      <dt className="technical-group-title">{title}{note ? <small className="technical-group-note">{note}</small> : null}</dt>
      <dd className="technical-group-body"><dl className="technical-fields">{children}</dl></dd>
    </div>
  );
}

export type RecordValue = string | number | boolean | null | undefined | readonly unknown[] | { readonly [key: string]: unknown };

/** How one raw value is shown: missing values say "none", objects and JSON text are
 *  pretty-printed as a block, multi-line text is a block, the rest is inline. */
export function recordText(value: RecordValue): { text: string | null; block: boolean } {
  if (value === null || value === undefined || value === "") return { text: null, block: false };
  if (typeof value === "object") return { text: JSON.stringify(value, null, 2), block: true };
  if (typeof value !== "string") return { text: String(value), block: false };
  const trimmed = value.trim();
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") return { text: JSON.stringify(parsed, null, 2), block: true };
    } catch {
      // Not JSON: shown as written.
    }
  }
  return { text: value, block: value.includes("\n") };
}

export function RecordField({ label, value, usage, copy = true }: { label: string; value: RecordValue; usage?: ReactNode; copy?: boolean }) {
  const [copied, setCopied] = useState(false);
  const { text, block } = recordText(value);
  return (
    <div className="technical-field" data-block={block || undefined}>
      <dt>{label}</dt>
      <dd>
        {text === null ? <span className="technical-none">none</span> : block ? <pre className="technical-block"><code>{text}</code></pre> : <code>{text}</code>}
        {copy && text !== null ? (
          <button
            aria-label={`Copy ${label}`}
            className="btn btn-ghost btn-sm technical-copy"
            onClick={() => {
              void navigator.clipboard?.writeText(text).then(() => {
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

type RefLike = { kind: string; id: string; name: string | null; readable: boolean; email?: string | null };
type ReferencesLike = {
  people?: Record<string, RefLike | undefined>;
  baseline?: RefLike | null;
  plan?: (RefLike & { status?: string; dryRunJobId?: string | null }) | null;
  undoes?: (RefLike & { status?: string; dryRunJobId?: string | null }) | null;
  changes?: ((RefLike & { naturalKey?: string; resourceType?: string; changeType?: string }) | undefined)[];
  snapshot?: (RefLike & { takenAt?: string | null }) | null;
};

const ROLE_WORDS: Record<string, string> = {
  requested_by: "Requested by",
  decided_by: "Decided by",
  run_as: "Runs as",
  created_by: "Created by",
  owner: "Owner",
  actor: "Done by",
};

/** What a linked record resolved to, for a field's usage line. */
export function refUsage(ref: RefLike | null | undefined, extra?: string | null): string | undefined {
  if (!ref) return extra ?? undefined;
  const name = ref.readable ? ref.name : "no longer readable";
  const parts = [name !== ref.id ? name : null, ref.email && ref.email !== name && ref.email !== ref.id ? ref.email : null, extra].filter(Boolean);
  return parts.length ? parts.join(" · ") : undefined;
}

/** Every record a row links to (people, approved setup, dry run, snapshot, changes),
 *  each with its id and what it resolved to. */
export function ReferenceFields({ references, skipPeople = [] }: { references: ReferencesLike | null | undefined; skipPeople?: string[] }) {
  if (!references) return null;
  const people = Object.entries(references.people ?? {}).filter((entry): entry is [string, RefLike] => Boolean(entry[1]) && !skipPeople.includes(entry[0]));
  const changes = (references.changes ?? []).filter((change): change is NonNullable<typeof change> => Boolean(change));
  return (
    <>
      {people.map(([role, ref]) => (
        <RecordField key={`person:${role}`} label={`${ROLE_WORDS[role] ?? role.replace(/_/g, " ")} (account ID)`} usage={refUsage(ref)} value={ref.id} />
      ))}
      {references.baseline ? <RecordField label="Approved setup ID" usage={refUsage(references.baseline)} value={references.baseline.id} /> : null}
      {references.plan ? <RecordField label="Dry run ID" usage={refUsage(references.plan, references.plan.status ? `status ${references.plan.status}` : null)} value={references.plan.id} /> : null}
      {references.plan?.dryRunJobId ? <RecordField label="Dry run job ID" usage={<>use with <code>GET /api/jobs/&lt;id&gt;</code></>} value={references.plan.dryRunJobId} /> : null}
      {references.undoes ? <RecordField label="Undoes dry run ID" usage={refUsage(references.undoes)} value={references.undoes.id} /> : null}
      {references.snapshot ? <RecordField label="Snapshot ID" usage={refUsage(references.snapshot, references.snapshot.takenAt ? `taken ${references.snapshot.takenAt}` : null)} value={references.snapshot.id} /> : null}
      {changes.map((change) => (
        <RecordField key={`change:${change.id}`} label="Change ID" usage={refUsage(change, [change.resourceType, change.changeType, change.naturalKey].filter(Boolean).join(" · ") || null)} value={change.id} />
      ))}
    </>
  );
}
