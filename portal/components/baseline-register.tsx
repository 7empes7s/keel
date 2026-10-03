import { ActivateBaseline } from "@/components/activate-baseline";
import { RecordField, TechnicalDetails } from "@/components/technical-details";
import { ago, formatTimestamp } from "@/lib/presentation";
import type { BaselineRecord } from "@/lib/types";

// Every baseline by name, one time per fact (a relative age with the absolute time in
// its title and in the record), who set it by name; ids in the record (roadmap task-130).
export function BaselineRegister({ baselines, canBaseline, now }: { baselines: BaselineRecord[]; canBaseline: boolean; now: string }) {
  const maxResources = Math.max(1, ...baselines.map((baseline) => baseline.resourceCount));
  return (
    <section aria-labelledby="baseline-list-heading" className="report-section">
      <div className="section-heading-row report-heading">
        <div>
          <p className="section-kicker">Newest first</p>
          <h2 id="baseline-list-heading">All baselines</h2>
        </div>
        <span className="result-count">
          {baselines.length} {baselines.length === 1 ? "baseline" : "baselines"}
        </span>
      </div>

      {baselines.length ? (
        <div className="table-scroll">
          <table className="data-table baselines-table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Set</th>
                <th scope="col">Set by</th>
                <th scope="col">State</th>
                <th className="number-column" scope="col">Resources</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {baselines.map((baseline) => (
                <tr className={baseline.active ? "active-row" : undefined} key={baseline.id}>
                  <th data-label="Name" scope="row">
                    <span className="baseline-table-label">
                      <strong>{baseline.label ?? "Unnamed baseline"}</strong>
                      {baseline.description ? <small>{baseline.description}</small> : null}
                    </span>
                    <TechnicalDetails>
                      <RecordField label="Baseline ID" usage={<>use with <code>POST /api/actions/baseline/activate</code></>} value={baseline.id} />
                      <RecordField copy={false} label="Set at" value={baseline.setAt} />
                      <RecordField label="Set by (principal ID)" value={baseline.setBy} />
                    </TechnicalDetails>
                  </th>
                  <td data-label="Set">
                    <time dateTime={baseline.setAt} title={formatTimestamp(baseline.setAt)}>{ago(baseline.setAt, now)}</time>
                  </td>
                  <td className="wrap-value" data-label="Set by">{baseline.setByRef?.name ?? "an unknown account"}</td>
                  <td data-label="State">
                    {baseline.active ? (
                      <span className="active-indicator">Active</span>
                    ) : (
                      <span className="inactive-indicator">Not active</span>
                    )}
                  </td>
                  <td className="number-column" data-label="Resources">
                    <span className="resource-bar-cell">
                      {baseline.resourceCount.toLocaleString("en-GB")}
                      <span aria-hidden="true" className="resource-bar">
                        <span style={{ width: `${(baseline.resourceCount / maxResources) * 100}%` }} />
                      </span>
                    </span>
                  </td>
                  <td data-label="Actions">
                    {baseline.active ? null : (
                      <ActivateBaseline
                        baselineId={baseline.id}
                        disabled={!canBaseline}
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="empty-state">No baselines are recorded for this tenant.</p>
      )}
    </section>
  );
}
