import { RecordField, TechnicalDetails } from "@/components/technical-details";
import { changeKindWords, fieldWords, valueWords } from "@/lib/changes-view";
import { diffPayloads, formatValue } from "@/lib/drift-diff";
import { resourceLabel } from "@/lib/presentation";
import type { DriftRecord } from "@/lib/types";

function displayPayload(payload: unknown): string {
  if (payload === null) return "not present";
  return JSON.stringify(payload, null, 2) ?? "not captured";
}

// The comparison for one change: each field that differs, in words, first; the field
// paths and both full payloads stay in the record for anything the words do not explain.
export function DriftDiff({ item }: { item: DriftRecord }) {
  const changes = diffPayloads(item.before, item.after);
  const summary = item.changeType === "added"
    ? "This exists in the tenant but not in the baseline."
    : item.changeType === "removed"
      ? "This is in the baseline but no longer exists in the tenant."
      : changes.length
        ? `${changes.length} ${changes.length === 1 ? "setting differs" : "settings differ"} from the baseline.`
        : "The settings compare equal one by one; the full copies are in Technical details.";

  return (
    <section aria-labelledby={`drift-diff-heading-${item.id}`} className="drift-diff" id={`drift-diff-${item.id}`}>
      <div className="drift-diff-head">
        <p className="section-kicker">Baseline → now</p>
        <h3 id={`drift-diff-heading-${item.id}`}>{resourceLabel(item.naturalKey)}</h3>
        <p className="field-help">{summary}</p>
      </div>
      {changes.length ? (
        <div className="table-scroll">
          <table className="data-table diff-table">
            <thead>
              <tr>
                <th scope="col">Setting</th>
                <th scope="col">In the baseline</th>
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
                  <td data-label="In the baseline"><span className="diff-before">{change.kind === "added" ? "—" : valueWords(change.before)}</span></td>
                  <td data-label="Now"><span className="diff-after">{change.kind === "removed" ? "—" : valueWords(change.after)}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <TechnicalDetails>
        <RecordField label="Natural key" value={item.naturalKey} />
        <RecordField label="Drift ID" value={item.id} usage={<>The <code>driftId</code> for <code>POST /api/actions/dispose</code></>} />
        <RecordField copy={false} label="Change and blast radius" value={`${item.changeType} · ${item.blastRadius}`} />
        {changes.map((change) => (
          <RecordField copy={false} key={change.path} label={`Field ${change.path}`}
            value={`${change.kind}: ${change.kind === "added" ? "—" : formatValue((change as { before?: unknown }).before)} → ${change.kind === "removed" ? "—" : formatValue((change as { after?: unknown }).after)}`} />
        ))}
        <RecordField copy={false} label="Baseline payload" value={displayPayload(item.before)} />
        <RecordField copy={false} label="Observed payload" value={displayPayload(item.after)} />
      </TechnicalDetails>
    </section>
  );
}
