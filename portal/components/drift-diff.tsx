import type { ReactNode } from "react";

import { ChangeComparison } from "@/components/change-comparison";
import { RecordField, RecordGroup, TechnicalDetails } from "@/components/technical-details";
import { changeLabel, fieldWords } from "@/lib/changes-view";
import { diffPayloads } from "@/lib/drift-diff";
import type { DriftRecord } from "@/lib/types";

/** One setting that differs, in the record: its path, what kind of change, and both raw
 *  values in full (a list or object pretty-printed), each in its own field. */
export function FieldRecord({ path, change, before, after, note }: { path: string; change: string; before: unknown; after: unknown; note?: ReactNode }) {
  return (
    <RecordGroup note={note} title={fieldWords(path)}>
      <RecordField label="Setting path" value={path} />
      <RecordField copy={false} label="Change" value={change} />
      <RecordField label="Before" value={before as never} />
      <RecordField label="After" value={after as never} />
    </RecordGroup>
  );
}

function displayPayload(payload: unknown): string {
  if (payload === null) return "not present";
  return JSON.stringify(payload, null, 2) ?? "not captured";
}

// The comparison for one change: each setting that differs, next to its approved value,
// first; the field paths and both full payloads stay in the record.
// A service setting change compares two reads, not the approved setup and now.
// `record` adds the fields the caller knows (the service read, when it was found) to the
// same Technical details, so a change has one record, not two.
export function DriftDiff({ item, record }: { item: DriftRecord; record?: ReactNode }) {
  const changes = diffPayloads(item.before, item.after);
  const read = Boolean(item.serviceRead);

  return (
    <section aria-labelledby={`drift-diff-heading-${item.id}`} className="drift-diff" id={`drift-diff-${item.id}`}>
      <div className="drift-diff-head">
        <h3 id={`drift-diff-heading-${item.id}`}>{read ? "Compared with the previous read" : "Compared with the approved setup"}</h3>
      </div>
      <ChangeComparison
        after={item.after}
        against={read ? "the previous read" : "the approved setup"}
        before={item.before}
        label={`${changeLabel(item)}: settings`}
        names={item.refNames ?? {}}
        sides={read ? { before: "Previous read", after: "Newest read" } : { before: "Approved setup", after: "Now" }}
      />
      <TechnicalDetails>
        <RecordField label="Natural key" value={item.naturalKey} />
        {read ? null : <RecordField label="Drift ID" value={item.id} usage={<>The <code>driftId</code> for <code>POST /api/actions/dispose</code></>} />}
        <RecordField copy={false} label="Change type" value={item.changeType} />
        <RecordField copy={false} label="Blast radius" value={item.blastRadius} />
        {record}
        {changes.map((change) => (
          <FieldRecord after={change.kind === "removed" ? undefined : change.after} before={change.kind === "added" ? undefined : change.before} change={change.kind} key={change.path} path={change.path} />
        ))}
        <RecordField copy={false} label={read ? "Previous read" : "Baseline payload"} value={displayPayload(item.before)} />
        <RecordField copy={false} label={read ? "Newest read" : "Observed payload"} value={displayPayload(item.after)} />
      </TechnicalDetails>
    </section>
  );
}
