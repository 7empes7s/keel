import { diffPayloads, formatValue } from "@/lib/drift-diff";
import type { DriftRecord } from "@/lib/types";

function displayPayload(payload: unknown): string {
  if (payload === null) return "Not present";
  return JSON.stringify(payload, null, 2) ?? "Not captured";
}

// The comparison for one drift row: the fields that changed first, then both full
// payloads behind a disclosure for anything the field list does not explain.
export function DriftDiff({ item }: { item: DriftRecord }) {
  const changes = diffPayloads(item.before, item.after);
  const summary = item.changeType === "added"
    ? "This resource exists in the tenant but not in the baseline."
    : item.changeType === "removed"
      ? "This resource is in the baseline but no longer exists in the tenant."
      : changes.length
        ? `${changes.length} ${changes.length === 1 ? "field differs" : "fields differ"} from the baseline.`
        : "The stored payloads compare equal field by field; see the full payloads below.";

  return (
    <section aria-labelledby={`drift-diff-heading-${item.id}`} className="drift-diff" id={`drift-diff-${item.id}`}>
      <div className="drift-diff-head">
        <p className="section-kicker">Baseline → observed</p>
        <h3 id={`drift-diff-heading-${item.id}`}>{item.naturalKey}</h3>
        <p className="field-help">{summary}</p>
      </div>
      {changes.length ? (
        <div className="table-scroll">
          <table className="data-table diff-table">
            <thead>
              <tr>
                <th scope="col">Field</th>
                <th scope="col">Baseline</th>
                <th scope="col">Observed</th>
              </tr>
            </thead>
            <tbody>
              {changes.map((change) => (
                <tr className={`diff-${change.kind}`} key={change.path}>
                  <th data-label="Field" scope="row">
                    <span className="diff-field">
                      <span className="diff-kind">{change.kind}</span>
                      <code>{change.path}</code>
                    </span>
                  </th>
                  <td data-label="Baseline"><pre className="diff-before">{change.kind === "added" ? "—" : formatValue(change.before)}</pre></td>
                  <td data-label="Observed"><pre className="diff-after">{change.kind === "removed" ? "—" : formatValue(change.after)}</pre></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <details className="diff-full" open={changes.length === 0}>
        <summary>Full payloads</summary>
        <div className="difference-payloads">
          <section aria-label="Baseline before">
            <h4>Baseline before</h4>
            <pre>{displayPayload(item.before)}</pre>
          </section>
          <section aria-label="Observed after">
            <h4>Observed after</h4>
            <pre>{displayPayload(item.after)}</pre>
          </section>
        </div>
      </details>
    </section>
  );
}
