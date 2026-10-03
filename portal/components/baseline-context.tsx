import { RecordField, TechnicalDetails } from "@/components/technical-details";
import { ago, formatTimestamp } from "@/lib/presentation";
import type { BaselineRecord } from "@/lib/types";

/** The baseline every change is measured against, by name, with its ids in the record. */
export function BaselineContext({ baseline, now }: { baseline: BaselineRecord; now: string }) {
  return (
    <section aria-label="Active baseline" className="context-strip">
      <span className="active-indicator">Measured against</span>
      <strong>{baseline.label ?? "Unnamed baseline"}</strong>
      <span>{baseline.resourceCount.toLocaleString("en-GB")} resources</span>
      <span>set <time dateTime={baseline.setAt} title={formatTimestamp(baseline.setAt)}>{ago(baseline.setAt, now)}</time></span>
      <TechnicalDetails>
        <RecordField label="Baseline ID" value={baseline.id} usage={<code>GET /api/baselines</code>} />
        <RecordField copy={false} label="Set at" value={baseline.setAt} />
      </TechnicalDetails>
    </section>
  );
}
