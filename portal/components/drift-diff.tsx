import type { ReactNode } from "react";

import { ChangeComparison } from "@/components/change-comparison";
import { RecordCompare, RecordField, RecordGroup, TechnicalDetails, UnnamedRefFields } from "@/components/technical-details";
import { changeLabel, fieldWords } from "@/lib/changes-view";
import { diffPayloads } from "@/lib/drift-diff";
import type { DriftRecord } from "@/lib/types";

/** One setting that differs, in the record: both sides with the difference marked,
 *  and its stored path for support. */
export function FieldRecord({ path, before, after, note, sides }: { path: string; change?: string; before: unknown; after: unknown; note?: ReactNode; sides?: { before: string; after: string } }) {
  return (
    <RecordGroup note={note} title={fieldWords(path)}>
      <RecordCompare after={after} before={before} label="Setting value" sides={sides} />
      <RecordField label="Setting path" value={path} />
    </RecordGroup>
  );
}

/** The two sides' names: the approved setup and now, or two reads of a service. */
export function compareSides(read: boolean): { before: string; after: string } {
  return read ? { before: "Earlier read", after: "Newest read" } : { before: "Approved setup", after: "Now" };
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
  // An older service change compares two reads, unless its service has an approved
  // setup now to compare with; the rest compare with an approved setup.
  const read = item.serviceRead ? item.serviceRead.comparedWith === "previous" && !item.serviceRead.beforeIsApproved : false;

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
        <UnnamedRefFields refs={item.unnamedRefs} />
        {item.serviceRead ? null : <RecordField label="Drift ID" value={item.id} usage={<>The <code>driftId</code> for <code>POST /api/actions/dispose</code></>} />}
        <RecordField copy={false} label="Change type" value={item.changeType} />
        <RecordField copy={false} label="Blast radius" value={item.blastRadius} />
        {record}
        <RecordCompare after={item.after} before={item.before} label="Whole item" sides={compareSides(read)} />
        {changes.map((change) => (
          <FieldRecord after={change.kind === "removed" ? undefined : change.after} before={change.kind === "added" ? undefined : change.before} change={change.kind} key={change.path} path={change.path} sides={compareSides(read)} />
        ))}
        <RecordField copy={false} label={read ? "Previous read" : "Baseline payload"} value={displayPayload(item.before)} />
        <RecordField copy={false} label={read ? "Newest read" : "Observed payload"} value={displayPayload(item.after)} />
      </TechnicalDetails>
    </section>
  );
}
