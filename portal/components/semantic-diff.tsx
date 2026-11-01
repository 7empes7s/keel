import type { ReactNode } from "react";

import { ChangeComparison } from "@/components/change-comparison";
import { compareSides, FieldRecord } from "@/components/drift-diff";
import { RecordCompare, RecordField, TechnicalDetails } from "@/components/technical-details";
import { changeLabel } from "@/lib/changes-view";
import { IMPACT_HEADINGS } from "@/lib/semantic-drift";
import type { DriftRecord, SemanticChange } from "@/lib/types";

// Roadmap task-98: one change, setting by setting, against the approved setup. Settings
// Microsoft sets itself fold away; a setting Microsoft will not let Keel change back in
// place says so; an earlier value Keel did not keep reads "Not known", never as removed.
export function SemanticDiff({ item, change, record }: { item: DriftRecord; change: SemanticChange; record?: ReactNode }) {
  const headingId = `semantic-diff-heading-${item.id}`;
  const notes = Object.fromEntries(change.fields.filter((field) => field.impact === "fixed").map((field) => [field.path, IMPACT_HEADINGS.fixed]));
  // Only a reviewed comparison of two kept copies knows which settings change behaviour.
  const behaviour = change.state === "compared" && change.rules !== "generic" ? change.fields.map((field) => field.path) : null;
  return (
    <section aria-labelledby={headingId} className="drift-diff semantic-diff" id={`drift-diff-${item.id}`}>
      <div className="drift-diff-head">
        <h3 id={headingId}>Compared with the approved setup</h3>
      </div>
      <ChangeComparison
        after={item.after}
        against="the approved setup"
        before={item.before}
        behaviour={behaviour}
        beforeKnown={change.state !== "unknown-before"}
        label={`${changeLabel(item)}: settings`}
        names={item.refNames ?? {}}
        notes={notes}
        sides={{ before: "Approved setup", after: "Now" }}
      />
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
        <RecordCompare after={item.after} before={item.before} label="Whole setting" sides={compareSides(false)} />
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
