import { ActivateBaseline } from "@/components/activate-baseline";
import { ResnapshotBaseline } from "@/components/resnapshot-baseline";
import { RecordField, TechnicalDetails } from "@/components/technical-details";
import {
  baselineState,
  captureAge,
  captureScope,
  changesSentence,
  resnapshotSource,
  versionLabel,
} from "@/lib/compliance-view";
import { formatTimestamp } from "@/lib/presentation";
import type { BaselineRecord } from "@/lib/types";

export interface CaptureSource {
  id: string;
  completedAt: string | null;
}

// Every baseline by name, one time per fact (a relative age with the absolute time in
// its title and in the record), who set it by name; ids in the record (roadmap task-130).
// Task-87: the age is the capture's (when its backup was collected), with what it
// covered, the changes since, its version, and a re-capture that keeps the old version.
export function BaselineRegister({
  baselines,
  canBaseline,
  now,
  snapshots = [],
}: {
  baselines: BaselineRecord[];
  canBaseline: boolean;
  now: string;
  snapshots?: CaptureSource[];
}) {
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
                <th scope="col">Captured</th>
                <th scope="col">Since capture</th>
                <th scope="col">Set by</th>
                <th scope="col">State</th>
                <th className="number-column" scope="col">Resources</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {baselines.map((baseline) => {
                const name = baseline.label ?? "Unnamed baseline";
                const source = resnapshotSource(baseline, snapshots);
                const superseded = Boolean(baseline.supersededById || baseline.supersededAt);
                const capture = baseline.capture;
                const changes = baseline.changesSinceCapture;
                return (
                  <tr className={baseline.active ? "active-row" : undefined} key={baseline.id}>
                    <th data-label="Name" scope="row">
                      <span className="baseline-table-label">
                        <strong>{name}</strong>
                        <small>{versionLabel(baseline)}{baseline.description ? ` · ${baseline.description}` : ""}</small>
                      </span>
                      <TechnicalDetails>
                        <RecordField label="Baseline ID" usage={<>use with <code>POST /api/actions/baseline/activate</code></>} value={baseline.id} />
                        <RecordField copy={false} label="Set at" value={baseline.setAt} />
                        <RecordField label="Set by (principal ID)" value={baseline.setBy} />
                        <RecordField copy={false} label="Version" value={String(baseline.version ?? 1)} />
                        {baseline.supersedesId ? <RecordField label="Supersedes baseline ID" value={baseline.supersedesId} /> : null}
                        {baseline.supersededById ? <RecordField label="Superseded by baseline ID" value={baseline.supersededById} /> : null}
                        {baseline.supersededAt ? <RecordField copy={false} label="Superseded at" value={baseline.supersededAt} /> : null}
                        <RecordField copy={false} label="Capture basis" value={capture?.basis ?? "unknown"} />
                        <RecordField copy={false} label="Captured at" value={capture?.capturedAt ?? null} />
                        {capture?.sourceSnapshotId ? <RecordField label="Source snapshot ID" usage={<>use with <code>keel-baseline-create --snapshot-id</code></>} value={capture.sourceSnapshotId} /> : null}
                        <RecordField copy={false} label="Collection window" value={capture?.window ? `${capture.window.startedAt ?? "unknown"} → ${capture.window.completedAt ?? "unknown"}` : null} />
                        <RecordField copy={false} label="Types captured" value={capture?.types.length ? capture.types.join(", ") : null} />
                        <RecordField copy={false} label="Compared with snapshot ID" value={changes?.comparedSnapshotId ?? null} />
                        <RecordField copy={false} label="Comparison" value={changes ? `${changes.state} · added ${changes.added} · modified ${changes.modified} · removed ${changes.removed}${changes.reason ? ` · ${changes.reason}` : ""}` : null} />
                      </TechnicalDetails>
                    </th>
                    <td data-label="Captured">
                      <time dateTime={capture?.capturedAt ?? undefined} title={formatTimestamp(capture?.capturedAt ?? null)}>{captureAge(capture, now)}</time>
                      <small className="cell-note">{captureScope(capture)}</small>
                    </td>
                    <td className="wrap-value" data-label="Since capture">{changesSentence(changes, { short: true })}</td>
                    <td className="wrap-value" data-label="Set by">{baseline.setByRef?.name ?? "an unknown account"}</td>
                    <td data-label="State">
                      {baseline.active ? (
                        <span className="active-indicator">{baselineState(baseline)}</span>
                      ) : (
                        <span className="inactive-indicator">{baselineState(baseline)}</span>
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
                      {superseded ? null : (
                        <span className="baseline-actions">
                          {baseline.active ? null : (
                            <ActivateBaseline baselineId={baseline.id} disabled={!canBaseline} />
                          )}
                          <ResnapshotBaseline
                            baselineId={baseline.id}
                            disabled={!canBaseline}
                            label={name}
                            snapshotId={source?.id ?? null}
                          />
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="empty-state">No baselines are recorded for this tenant.</p>
      )}
    </section>
  );
}
