import { RecordField, TechnicalDetails } from "@/components/technical-details";
import { changeKindWords, changeLabel, fieldWords, valueWords } from "@/lib/changes-view";
import { diffPayloads, formatValue } from "@/lib/drift-diff";
import type { DriftRecord } from "@/lib/types";

function displayPayload(payload: unknown): string {
  if (payload === null) return "not present";
  return JSON.stringify(payload, null, 2) ?? "not captured";
}

// The comparison for one change: each field that differs, in words, first; the field
// paths and both full payloads stay in the record for anything the words do not explain.
// A service setting change compares two reads, not the approved setup and now.
export function DriftDiff({ item }: { item: DriftRecord }) {
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
                  <td data-label={beforeLabel}><span className="diff-before">{change.kind === "added" ? "—" : valueWords(change.before, item.refNames ?? {})}</span></td>
                  <td data-label="Now"><span className="diff-after">{change.kind === "removed" ? "—" : valueWords(change.after, item.refNames ?? {})}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <TechnicalDetails>
        <RecordField label="Natural key" value={item.naturalKey} />
        {read ? null : <RecordField label="Drift ID" value={item.id} usage={<>The <code>driftId</code> for <code>POST /api/actions/dispose</code></>} />}
        <RecordField copy={false} label="Change and blast radius" value={`${item.changeType} · ${item.blastRadius}`} />
        {changes.map((change) => (
          <RecordField copy={false} key={change.path} label={`Field ${change.path}`}
            value={`${change.kind}: ${change.kind === "added" ? "—" : formatValue((change as { before?: unknown }).before)} → ${change.kind === "removed" ? "—" : formatValue((change as { after?: unknown }).after)}`} />
        ))}
        <RecordField copy={false} label={read ? "Previous read" : "Baseline payload"} value={displayPayload(item.before)} />
        <RecordField copy={false} label={read ? "Newest read" : "Observed payload"} value={displayPayload(item.after)} />
      </TechnicalDetails>
    </section>
  );
}
