"use client";

import { useEffect, useId, useRef, useState, type MouseEvent, type ReactNode } from "react";

import { Icon } from "@/components/shell/icons";

import { Badge } from "@/components/ui/badge";
import { compareSides } from "@/lib/record-compare";
import { fieldInfo, type FieldInfo } from "@/lib/record-glossary";
import { refUsage, type RefLike } from "@/lib/record-refs";
import { shownValue, type ShownValue } from "@/lib/record-values";

// Portal experience contract, the record layer: every identifier, hash and raw value
// lives here, collapsed under "Technical details". Each field reads in plain words with
// a one-line meaning (lib/record-glossary); IDs, codes and commands for support stay
// behind the panel's "Show support details" switch, with a copy control.
//
// The link opens the record in a side panel (a phone gets a full-screen sheet), so long
// ids and payloads get the full width instead of squeezing into the card. The panel is a
// popover inside the <details>, so the record stays part of the page it belongs to; a
// browser without popovers opens it in place instead.
//
// The markup must stay `<details class="technical-details" data-layer="record">` with no
// nested <details>: the visible-text tests strip the record up to its first </details>.
export function TechnicalDetails({ children, summary = "Technical details" }: { children: ReactNode; summary?: string }) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const [showSupport, setShowSupport] = useState(false);
  const [supportCount, setSupportCount] = useState<number | null>(null);
  const [plainCount, setPlainCount] = useState<number | null>(null);

  function show(event: MouseEvent) {
    const details = detailsRef.current;
    const panel = panelRef.current;
    if (!details || !panel || typeof panel.showPopover !== "function") return;
    event.preventDefault();
    details.open = true;
    try {
      panel.showPopover();
    } catch {
      return;
    }
    setOpen(true);
    panel.querySelector<HTMLElement>(".technical-panel-close")?.focus();
  }

  function hide() {
    try {
      panelRef.current?.hidePopover();
    } catch {
      // Already closed.
    }
  }

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const onToggle = (event: Event) => {
      if ((event as ToggleEvent).newState !== "closed" || panel.matches(":popover-open")) return;
      setOpen(false);
      if (detailsRef.current) detailsRef.current.open = false;
    };
    panel.addEventListener("toggle", onToggle);
    return () => panel.removeEventListener("toggle", onToggle);
  }, []);

  // How many fields are plain and how many are for support, so the switch can say
  // what it adds and a record of only references says so instead of looking empty.
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const fields = Array.from(panel.querySelectorAll<HTMLElement>(".technical-field"));
    setSupportCount(fields.filter((field) => field.dataset.support === "only").length);
    setPlainCount(fields.filter((field) => field.dataset.support !== "only").length);
  }, [children]);

  useEffect(() => {
    if (!open) return;
    // Esc closes this panel only, not the sheet or page behind it.
    const onKey = (event: KeyboardEvent) => {
      // The panel may already be closed while React has not yet run the toggle
      // handler; a second Esc then belongs to the sheet behind it.
      if (event.key !== "Escape" || !panelRef.current?.matches(":popover-open")) return;
      event.stopPropagation();
      hide();
      detailsRef.current?.querySelector<HTMLElement>("summary")?.focus();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  return (
    <details className="technical-details" data-layer="record" ref={detailsRef}>
      <summary aria-haspopup="dialog" onClick={show}>
        <span className="technical-summary-text">{summary}</span>
        <span aria-hidden="true" className="technical-summary-hint">{SUMMARY_HINT}</span>
        <Icon className="technical-summary-icon" name="chevron" />
      </summary>
      <div aria-labelledby={titleId} className="technical-body" data-support-shown={showSupport ? "true" : "false"} popover="auto" ref={panelRef} role="dialog">
        <header className="technical-panel-head">
          <div>
            <p className="technical-panel-kicker">{SUMMARY_HINT}</p>
            <p className="technical-panel-title" id={titleId}>{summary}</p>
          </div>
          <button aria-label="Close technical details" className="icon-button technical-panel-close" onClick={hide} title="Close (Esc)" type="button"><Icon name="close" /></button>
        </header>
        <div className="technical-toolbar" hidden={supportCount === 0}>
          <p className="technical-toolbar-text">
            {plainCount === 0 && !showSupport
              ? "This record only holds references that support uses to find it."
              : "Each value is in plain words, with what it means."}
          </p>
          <button
            aria-pressed={showSupport}
            className="btn btn-ghost btn-sm technical-support-toggle"
            onClick={() => setShowSupport((value) => !value)}
            type="button"
          >
            <Icon name={showSupport ? "hide" : "show"} />
            {showSupport ? "Hide support details" : `Show support details${supportCount ? ` (${supportCount})` : ""}`}
          </button>
        </div>
        <dl className="technical-fields">{children}</dl>
      </div>
    </details>
  );
}

/** The hint on every "Technical details" link and the panel's kicker. */
export const SUMMARY_HINT = "What each value means";

/** A titled block of fields for one object (a job, a request, a channel), so a record
 *  that covers a list says which object each field belongs to. */
export function RecordGroup({ title, note, children }: { title: ReactNode; note?: ReactNode; children: ReactNode }) {
  return (
    <div className="technical-group">
      <dt className="technical-group-title">{title}{note ? <small className="technical-group-note">{note}</small> : null}</dt>
      <dd className="technical-group-body"><dl className="technical-fields">{children}</dl></dd>
    </div>
  );
}

export type RecordValue = string | number | boolean | null | undefined | readonly unknown[] | { readonly [key: string]: unknown };

/** How one stored value is shown to support: missing values say "none", objects and
 *  JSON text are pretty-printed as a block, multi-line text is a block, the rest is inline. */
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

function CopyButton({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  return (
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
  );
}

function FieldTerm({ info, label }: { info: FieldInfo | null; label: string }) {
  return (
    <dt>
      <span className="technical-label">{info?.label ?? label}</span>
      {info?.meaning ? <small className="technical-meaning">{info.meaning}</small> : null}
    </dt>
  );
}

/** The stored value, for support: the raw text with a copy control. */
function StoredValue({ label, value, copy, prefix }: { label: string; value: RecordValue; copy: boolean; prefix?: string }) {
  const { text, block } = recordText(value);
  return (
    <>
      {text === null ? <span className="technical-none">none</span> : block ? <pre className="technical-block"><code>{text}</code></pre> : <>{prefix ? <span className="technical-stored-label">{prefix}</span> : null}<code>{text}</code></>}
      {copy && text !== null ? <CopyButton label={label} text={text} /> : null}
    </>
  );
}

function PlainValue({ shown }: { shown: ShownValue }) {
  switch (shown.kind) {
    case "missing":
      return (
        <>
          <Badge tone={shown.tone === "neutral" ? "neutral" : shown.tone} icon={shown.tone === "neutral" ? null : undefined}>{shown.text}</Badge>
          {shown.why ? <small className="technical-why">{shown.why}</small> : null}
        </>
      );
    case "text":
      return shown.tone ? <Badge tone={shown.tone}>{shown.text}</Badge> : <span className="technical-value">{shown.text}</span>;
    case "lines":
      return (
        <ul className="technical-lines">
          {shown.lines.map((line, index) => <li key={index}>{line.label ? <><b>{line.label}:</b> </> : null}{line.text}</li>)}
          {shown.more ? <li className="technical-more">And {shown.more} more</li> : null}
        </ul>
      );
    case "error":
      return null;
  }
}

function ErrorValue({ shown, label, copy }: { shown: Extract<ShownValue, { kind: "error" }>; label: string; copy: boolean }) {
  const [full, setFull] = useState(false);
  return (
    <>
      <span className="technical-error-line"><Icon name="x-circle" />{shown.line}</span>
      {shown.cut ? (
        <button aria-expanded={full} className="btn btn-ghost btn-sm technical-error-toggle" onClick={() => setFull((value) => !value)} type="button">
          {full ? "Hide full error" : "Show full error"}
        </button>
      ) : null}
      <div className="technical-error-full" hidden={!full}>
        <pre className="technical-block"><code>{shown.full}</code></pre>
        {copy ? <CopyButton label={label} text={shown.full} /> : null}
      </div>
    </>
  );
}

/** One field of a record. The label is looked up in lib/record-glossary for its plain
 *  words, meaning and format; support-only fields (IDs, codes, commands) and the stored
 *  value behind a plain one show only with support details on; an error shows one
 *  line and the full text on a click. */
export function RecordField({ label, value, usage, copy = true }: { label: string; value: RecordValue; usage?: ReactNode; copy?: boolean }) {
  const info = fieldInfo(label);
  if (info?.support || !info) {
    const { block } = recordText(value);
    return (
      <div className="technical-field" data-block={block || undefined} data-field={label} data-support="only">
        <FieldTerm info={info} label={label} />
        <dd>
          <StoredValue copy={copy} label={info?.label ?? label} value={value} />
          {usage ? <small className="technical-usage">{usage}</small> : null}
        </dd>
      </div>
    );
  }
  const shown = shownValue(value, info);
  const { text: stored } = recordText(value);
  const plainUsage = typeof usage === "string";
  return (
    <div className="technical-field" data-error={shown.kind === "error" || undefined} data-field={label}>
      <FieldTerm info={info} label={label} />
      <dd>
        {shown.kind === "error" ? <ErrorValue copy={copy} label={info.label} shown={shown} /> : <PlainValue shown={shown} />}
        {usage && plainUsage ? <small className="technical-usage">{usage}</small> : null}
        {shown.kind !== "error" && shown.kind !== "missing" && stored !== null && stored !== plainOf(shown) ? (
          <span className="technical-stored" data-support="only">
            <StoredValue copy={copy} label={info.label} prefix="Stored as" value={value} />
          </span>
        ) : null}
        {usage && !plainUsage ? <small className="technical-usage" data-support="only">{usage}</small> : null}
      </dd>
    </div>
  );
}

/** The plain value as text, to skip "Stored as" when it says the same. */
function plainOf(shown: ShownValue): string | null {
  return shown.kind === "text" || shown.kind === "missing" ? shown.text : null;
}

/** Two sides of one setting (the approved or recommended value and the value now),
 *  with the settings that differ marked. Objects compare setting by setting; the
 *  settings that match are counted, not listed. */
export function RecordCompare({ label, before, after, sides = { before: "Approved setup", after: "Now" } }: {
  label: string;
  before: unknown;
  after: unknown;
  sides?: { before: string; after: string };
}) {
  const info = fieldInfo(label);
  const compared = compareSides(before, after);
  return (
    <div className="technical-field technical-compare" data-change={compared.change} data-field={label}>
      <FieldTerm info={info} label={label} />
      <dd>
        <Badge tone={COMPARE_TONES[compared.change]} icon={COMPARE_ICONS[compared.change]}>{COMPARE_WORDS[compared.change]}</Badge>
        <div className="technical-sides">
          {(["before", "after"] as const).map((side) => (
            <div className="technical-side" data-side={side} key={side}>
              <small>{sides[side]}</small>
              {compared[side] === null ? (
                <span className="technical-none">{side === "before" ? `Not in the ${sides.before.toLowerCase()}` : "Not there now"}</span>
              ) : (
                <ul className="technical-lines">
                  {compared[side]!.map((line, index) => (
                    <li data-differs={line.differs || undefined} key={index}>
                      {line.label ? <><b>{line.label}:</b> </> : null}{line.text}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
        {compared.same ? <small className="technical-why">{compared.same === 1 ? "1 other setting is the same on both sides." : `${compared.same} other settings are the same on both sides.`}</small> : null}
      </dd>
    </div>
  );
}

const COMPARE_WORDS = { same: "Same on both sides", changed: "Different", added: "Added", removed: "Removed" } as const;
const COMPARE_TONES = { same: "fine", changed: "soon", added: "soon", removed: "urgent" } as const;
const COMPARE_ICONS = { same: "check-circle", changed: "swap", added: "plus", removed: "close" } as const;

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
