import type { ReactNode } from "react";

import { ChangedValuesStyles, Value } from "@/components/changed-values";
import { RecordField, RecordGroup, TechnicalDetails } from "@/components/technical-details";
import { changeKindWords, changeLabel, fieldWords } from "@/lib/changes-view";
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

// The comparison for one change: each field that differs, in words, first; the field
// paths and both full payloads stay in the record for anything the words do not explain.
// A service setting change compares two reads, not the approved setup and now.
// `record` adds the fields the caller knows (the service read, when it was found) to the
// same Technical details, so a change has one record, not two.
export function DriftDiff({ item, record }: { item: DriftRecord; record?: ReactNode }) {
  const changes = diffPayloads(item.before, item.after);
  const read = Boolean(item.serviceRead);
  const summary = item.changeType === "added"
    ? read ? "This is new since the previous read." : "This exists in the tenant but not in the approved setup."
    : item.changeType === "removed"
      ? read ? "This was missing from the newest read." : "This is in the approved setup but no longer exists in the tenant."
      : changes.length
        ? `${changes.length} ${changes.length === 1 ? "setting" : "settings"} ${read ? `changed since the previous read` : changes.length === 1 ? "differs from the approved setup" : "differ from the approved setup"}.`
        : "The settings compare equal one by one; the full copies are in Technical details.";
  const beforeLabel = read ? "Before" : "Approved";

  return (
    <section aria-labelledby={`drift-diff-heading-${item.id}`} className="drift-diff" id={`drift-diff-${item.id}`}>
      <ChangedValuesStyles />
      <div className="drift-diff-head">
        <p className="section-kicker">{read ? "Previous read → newest read" : "Approved setup → now"}</p>
        <h3 id={`drift-diff-heading-${item.id}`}>{changeLabel(item)}</h3>
        <p className="field-help">{summary}</p>
      </div>
      {changes.length ? (
        <div className="table-scroll">
          <table className="data-table diff-table">
            <thead>
              <tr>
                <th scope="col">Setting</th>
                <th scope="col">{beforeLabel}</th>
                <th scope="col">Now</th>
              </tr>
            </thead>
            <tbody>
              {changes.map((change) => (
                <tr className={`diff-${change.kind}`} key={change.path}>
                  <th data-label="Setting" scope="row">
                    <span className="diff-field">
                      <span className="diff-kind">{changeKindWords(change.kind)}</span>
                      <span>{fieldWords(change.path)}</span>
                    </span>
                  </th>
                  <td data-label={beforeLabel}><span className="diff-before">{change.kind === "added" ? "—" : <Value names={item.refNames ?? {}} value={change.before} />}</span></td>
                  <td data-label="Now"><span className="diff-after">{change.kind === "removed" ? "—" : <Value names={item.refNames ?? {}} value={change.after} />}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
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
