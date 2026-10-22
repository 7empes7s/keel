import type { ReactNode } from "react";

import { ChangedValuesStyles, SidesRow, Value } from "@/components/changed-values";
import { DecisionStyles } from "@/components/decision-styles";
import { compareSides, FieldRecord } from "@/components/drift-diff";
import { RecordCompare, RecordField, TechnicalDetails } from "@/components/technical-details";
import { changeKindWords, changeLabel, fieldWords } from "@/lib/changes-view";
import { IMPACT_HEADINGS, cosmeticSentence, semanticSummarySentence } from "@/lib/semantic-drift";
import type { DriftRecord, SemanticChange, SemanticField } from "@/lib/types";

const GROUPS = ["fixed", "behaviour", "unknown-before"] as const;

function kindWords(field: SemanticField): string {
  return field.kind === "unknown-before" ? "Now set" : changeKindWords(field.kind);
}

function beforeWords(field: SemanticField, names: Record<string, string>): ReactNode {
  if (field.kind === "unknown-before") return "Not known";
  if (field.kind === "added") return "Not set";
  return <Value names={names} value={field.before} />;
}

function afterWords(field: SemanticField, names: Record<string, string>): ReactNode {
  if (field.kind === "removed") return "No longer set";
  return <Value names={names} value={field.after} />;
}

// Roadmap task-98: the settings of one change that alter behaviour, grouped by what a
// roll back can do with them. Fields Microsoft sets itself are counted, never listed;
// an earlier value Keel did not keep reads "Not known", never as a removal.
export function SemanticDiff({ item, change, record }: { item: DriftRecord; change: SemanticChange; record?: ReactNode }) {
  const headingId = `semantic-diff-heading-${item.id}`;
  const cosmetic = cosmeticSentence(change);
  return (
    <section aria-labelledby={headingId} className="drift-diff semantic-diff" id={`drift-diff-${item.id}`}>
      <DecisionStyles />
      <ChangedValuesStyles />
      <div className="drift-diff-head">
        <h3 id={headingId}>{changeLabel(item)}</h3>
        <p className="field-help semantic-summary">{semanticSummarySentence(change, item.changeType)}</p>
        {cosmetic ? <p className="field-help semantic-cosmetic">{cosmetic}</p> : null}
        {change.rules === "generic" ? (
          <p className="field-help">Keel has no detailed rules for this kind yet, so every setting that differs is listed.</p>
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
            <ul aria-labelledby={groupId} className="cv-list">
              {fields.map((field) => (
                <SidesRow
                  after={afterWords(field, item.refNames ?? {})}
                  before={beforeWords(field, item.refNames ?? {})}
                  key={field.path}
                  name={fieldWords(field.path)}
                  note={kindWords(field)}
                  sides={{ before: "Approved", after: "Now" }}
                />
              ))}
            </ul>
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
        <RecordField copy={false} label="Change type" value={item.changeType} />
        <RecordField copy={false} label="Blast radius" value={item.blastRadius} />
        {record}
        <RecordField copy={false} label="Comparison state" value={change.state} />
        <RecordField copy={false} label="Comparison rules" value={change.rules} />
        <RecordField copy={false} label="Behavioural settings" value={`${change.total}: ${change.groups.fixed} cannot be changed back in place, ${change.groups.behaviour} can be changed back, ${change.groups["unknown-before"]} with no earlier value`} />
        <RecordField copy={false} label="Server-owned settings not shown" value={change.cosmetic} />
        <RecordCompare after={item.after} before={item.before} label="Whole item" sides={compareSides(false)} />
        {change.fields.map((field) => (
          <FieldRecord
            after={field.kind === "removed" ? undefined : field.after}
            before={field.kind === "unknown-before" || field.kind === "added" ? undefined : field.before}
            change={field.kind}
            key={field.path}
            note={field.impact}
            path={field.path}
          />
        ))}
        <RecordField copy={false} label="Baseline copy (compared settings)" value={item.before === null || item.before === undefined ? "not kept" : JSON.stringify(item.before, null, 2) ?? "not kept"} />
        <RecordField copy={false} label="Current copy (compared settings)" value={item.after === null || item.after === undefined ? "not kept" : JSON.stringify(item.after, null, 2) ?? "not kept"} />
      </TechnicalDetails>
    </section>
  );
}
