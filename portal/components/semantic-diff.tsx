import { DecisionStyles } from "@/components/decision-styles";
import { RecordField, TechnicalDetails } from "@/components/technical-details";
import { changeKindWords, fieldWords, valueWords } from "@/lib/changes-view";
import { formatValue } from "@/lib/drift-diff";
import { resourceLabel } from "@/lib/presentation";
import { IMPACT_HEADINGS, cosmeticSentence, semanticSummarySentence } from "@/lib/semantic-drift";
import type { DriftRecord, SemanticChange, SemanticField } from "@/lib/types";

const GROUPS = ["fixed", "behaviour", "unknown-before"] as const;

function kindWords(field: SemanticField): string {
  return field.kind === "unknown-before" ? "Now set" : changeKindWords(field.kind);
}

function beforeWords(field: SemanticField): string {
  if (field.kind === "unknown-before") return "Not known";
  if (field.kind === "added") return "Not set in the baseline";
  return valueWords(field.before);
}

function afterWords(field: SemanticField): string {
  if (field.kind === "removed") return "No longer set";
  return valueWords(field.after);
}

function recordValue(field: SemanticField): string {
  const before = field.kind === "unknown-before" ? "unknown" : field.kind === "added" ? "absent" : formatValue(field.before);
  const after = field.kind === "removed" ? "absent" : formatValue(field.after);
  return `${field.kind} · ${field.impact}: ${before} → ${after}`;
}

// Roadmap task-98: the settings of one change that alter behaviour, grouped by what a
// roll back can do with them. Fields Microsoft sets itself are counted, never listed;
// an earlier value KEEL did not keep reads "Not known", never as a removal.
export function SemanticDiff({ item, change }: { item: DriftRecord; change: SemanticChange }) {
  const headingId = `semantic-diff-heading-${item.id}`;
  const cosmetic = cosmeticSentence(change);
  return (
    <section aria-labelledby={headingId} className="drift-diff semantic-diff" id={`drift-diff-${item.id}`}>
      <DecisionStyles />
      <div className="drift-diff-head">
        <p className="section-kicker">Baseline → now</p>
        <h3 id={headingId}>{resourceLabel(item.naturalKey)}</h3>
        <p className="field-help semantic-summary">{semanticSummarySentence(change, item.changeType)}</p>
        {cosmetic ? <p className="field-help semantic-cosmetic">{cosmetic}</p> : null}
        {change.rules === "generic" ? (
          <p className="field-help">KEEL has no detailed rules for this kind of setting yet, so only ids and timestamps are left out.</p>
        ) : null}
      </div>
      {GROUPS.map((group) => {
        const fields = change.fields.filter((field) => field.impact === group);
        if (fields.length === 0) return null;
        const groupId = `semantic-${group}-${item.id}`;
        return (
          <div className={`semantic-group semantic-group-${group}`} key={group}>
            <h4 id={groupId}>
              {IMPACT_HEADINGS[group]} <span className="semantic-count">({change.groups[group]})</span>
            </h4>
            <div className="table-scroll">
              <table aria-labelledby={groupId} className="data-table diff-table">
                <thead>
                  <tr>
                    <th scope="col">Setting</th>
                    <th scope="col">In the baseline</th>
                    <th scope="col">Now</th>
                  </tr>
                </thead>
                <tbody>
                  {fields.map((field) => (
                    <tr className={`diff-${field.kind === "unknown-before" ? "unknown" : field.kind}`} key={field.path}>
                      <th data-label="Setting" scope="row">
                        <span className="diff-field">
                          <span className="diff-kind">{kindWords(field)}</span>
                          <span>{fieldWords(field.path)}</span>
                        </span>
                      </th>
                      <td data-label="In the baseline"><span className="diff-before">{beforeWords(field)}</span></td>
                      <td data-label="Now"><span className="diff-after">{afterWords(field)}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
      {change.shown < change.total ? (
        <p className="field-help semantic-capped">
          Showing {change.shown} of {change.total} settings. The rest are counted here and not listed.
        </p>
      ) : null}
      <TechnicalDetails>
        <RecordField label="Natural key" value={item.naturalKey} />
        <RecordField label="Drift ID" value={item.id} usage={<>The <code>driftId</code> for <code>POST /api/actions/dispose</code></>} />
        <RecordField copy={false} label="Change and blast radius" value={`${item.changeType} · ${item.blastRadius}`} />
        <RecordField copy={false} label="Comparison" value={`${change.state} · rules ${change.rules} · ${change.total} behavioural (${change.groups.fixed} immutable, ${change.groups.behaviour} writable, ${change.groups["unknown-before"]} unknown before) · ${change.cosmetic} server-owned not shown`} />
        {change.fields.map((field) => (
          <RecordField copy={false} key={field.path} label={`Field ${field.path}`} value={recordValue(field)} />
        ))}
        <RecordField copy={false} label="Baseline copy (compared settings)" value={item.before === null || item.before === undefined ? "not kept" : JSON.stringify(item.before, null, 2) ?? "not kept"} />
        <RecordField copy={false} label="Current copy (compared settings)" value={item.after === null || item.after === undefined ? "not kept" : JSON.stringify(item.after, null, 2) ?? "not kept"} />
      </TechnicalDetails>
    </section>
  );
}
