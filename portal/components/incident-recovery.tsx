"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import type { IncidentDetail, IncidentRecoveryPoint, IncidentSummary } from "@/lib/portal-data";
import { formatTimestamp } from "@/lib/presentation";
import { toast } from "@/lib/toast";

// Roadmap task-71: incident-qualified recovery points. During a compromise the newest
// snapshot is the one most likely to carry the attacker's changes, so this view never
// recommends "the latest backup": the engine qualifies each snapshot against the
// incident's compromise intervals and the investigator's assessments, and the
// recommended point is the newest QUALIFIED one. Pins keep a snapshot from routine
// prune; they say nothing about whether it is clean.
export type RecoveryPointStatus = IncidentRecoveryPoint["status"];

const STATUS_LABELS: Record<RecoveryPointStatus, string> = {
  qualified: "Qualified",
  unsuitable: "Unsuitable",
  unassessed: "Unassessed",
};

const STATUS_TONES: Record<RecoveryPointStatus, string> = {
  qualified: "ok",
  unsuitable: "bad",
  unassessed: "warn",
};

export function recoveryPointStatusLabel(status: RecoveryPointStatus): string {
  return STATUS_LABELS[status] ?? status;
}

export interface ParsedExclusion {
  naturalKey: string;
  field: string | null;
  reason: string;
}

/** One exclusion per line: `naturalKey | reason` for a whole malicious object, or
 * `naturalKey#field.path | reason` for one malicious field. */
export function parseExclusions(text: string): { exclusions: ParsedExclusion[]; error: string | null } {
  const exclusions: ParsedExclusion[] = [];
  const lines = text.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  for (const [index, line] of lines.entries()) {
    const [target, ...reasonParts] = line.split("|");
    const reason = reasonParts.join("|").trim();
    const [naturalKey, field] = target.trim().split("#");
    if (!naturalKey || !reason) {
      return { exclusions: [], error: `Line ${index + 1}: write "naturalKey | reason" or "naturalKey#field | reason".` };
    }
    exclusions.push({ naturalKey: naturalKey.trim(), field: field?.trim() || null, reason });
  }
  return { exclusions, error: null };
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

export function RecoveryPointTable({
  detail,
  canInvestigate = false,
  busy = null,
  onAction,
}: {
  detail: IncidentDetail;
  canInvestigate?: boolean;
  busy?: string | null;
  onAction?: (op: string, body: Record<string, unknown>, success: string) => void;
}) {
  const [assessing, setAssessing] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const pinBySnapshot = new Map(detail.pins.map((pin) => [pin.snapshotId, pin]));
  const incidentOpen = detail.incident.status === "open";

  if (detail.points.length === 0) {
    return <p className="empty-state">No completed snapshots exist for this tenant yet.</p>;
  }

  function submitAssessment(event: FormEvent<HTMLFormElement>, snapshotId: string) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const verdict = String(data.get("verdict") ?? "");
    const parsed = parseExclusions(String(data.get("exclusions") ?? ""));
    if (parsed.error) {
      setFormError(parsed.error);
      return;
    }
    if (verdict === "compromised" && parsed.exclusions.length > 0) {
      setFormError("A compromised verdict refuses the whole point. Exclusions apply only to a clean verdict.");
      return;
    }
    setFormError(null);
    onAction?.("assess", {
      snapshotId, verdict, rationale: String(data.get("rationale") ?? ""), exclusions: parsed.exclusions,
    }, "Assessment recorded");
    setAssessing(null);
  }

  return (
    <div className="table-scroll">
      <table className="data-table incident-points">
        <caption className="visually-hidden">Recovery points for {detail.incident.title}, newest first</caption>
        <thead>
          <tr>
            <th scope="col">Snapshot</th>
            <th scope="col">Qualification</th>
            <th scope="col">Assessment</th>
            <th scope="col">Retention</th>
            <th scope="col"><span className="visually-hidden">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {detail.points.map((point) => {
            const pin = pinBySnapshot.get(point.snapshotId);
            const recommended = detail.recommended === point.snapshotId;
            return (
              <tr className={`incident-point incident-point-${point.status}${recommended ? " incident-point-recommended" : ""}`} key={point.snapshotId}>
                <th scope="row">
                  <code className="natural-key">{shortId(point.snapshotId)}</code>
                  <small className="incident-point-time">
                    <time dateTime={point.observedTo ?? undefined}>{formatTimestamp(point.observedTo ?? point.observedFrom)}</time>
                  </small>
                </th>
                <td>
                  <span className={`pill pill-${STATUS_TONES[point.status]}`}>{recoveryPointStatusLabel(point.status)}</span>
                  {recommended ? <span className="pill pill-info incident-recommended">Recommended</span> : null}
                  {point.inCompromiseWindow ? <small className="incident-window">In compromise window</small> : null}
                  <ul className="incident-reasons">
                    {point.reasons.map((reason) => <li key={reason}>{reason}</li>)}
                  </ul>
                </td>
                <td>
                  {point.assessment ? (
                    <>
                      <span>v{point.assessment.version} · {point.assessment.verdict}</span>
                      {point.assessment.exclusions.length ? (
                        <ul className="incident-exclusions">
                          {point.assessment.exclusions.map((exclusion) => (
                            <li key={`${exclusion.naturalKey}#${exclusion.field ?? ""}`}>
                              Excluded <code>{exclusion.naturalKey}</code>
                              {exclusion.field ? <> field <code>{exclusion.field}</code></> : null}: {exclusion.reason}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </>
                  ) : (
                    <span className="muted-value">{point.stale ? "Stale — reassess" : "None"}</span>
                  )}
                </td>
                <td>
                  {pin ? (
                    <>
                      <span className="pill pill-neutral">Pinned</span>
                      <small className="incident-pin-note">Kept from prune · not proof of a clean state</small>
                    </>
                  ) : (
                    <span className="muted-value">Routine</span>
                  )}
                </td>
                <td>
                  <div className="incident-actions">
                    <Link
                      className="btn btn-secondary btn-sm"
                      href={`/restore?snapshot=${encodeURIComponent(point.snapshotId)}&incident=${encodeURIComponent(detail.incident.id)}`}
                    >
                      {point.status === "qualified" ? "Restore from here" : "Restore (override needed)"}
                    </Link>
                    {canInvestigate && incidentOpen ? (
                      <>
                        <button
                          aria-expanded={assessing === point.snapshotId}
                          className="btn btn-ghost btn-sm"
                          disabled={busy !== null}
                          onClick={() => { setFormError(null); setAssessing(assessing === point.snapshotId ? null : point.snapshotId); }}
                          type="button"
                        >
                          Assess
                        </button>
                        {pin ? (
                          <button
                            className="btn btn-ghost btn-sm"
                            disabled={busy !== null}
                            onClick={() => {
                              const reason = window.prompt("Why is this pin being released? The snapshot returns to routine retention.");
                              if (reason) onAction?.("release", { pinId: pin.id, reason }, "Pin released");
                            }}
                            type="button"
                          >
                            Release pin
                          </button>
                        ) : (
                          <button
                            className="btn btn-ghost btn-sm"
                            disabled={busy !== null}
                            onClick={() => {
                              const reason = window.prompt("Why must this snapshot be kept from routine prune?");
                              if (reason) onAction?.("pin", { snapshotId: point.snapshotId, reason }, "Snapshot pinned");
                            }}
                            type="button"
                          >
                            Pin
                          </button>
                        )}
                        {point.status !== "qualified" ? (
                          <button
                            className="btn btn-ghost btn-sm"
                            disabled={busy !== null}
                            onClick={() => {
                              const reason = window.prompt("Why must a restore use this unqualified point? Another person must request the restore.");
                              if (reason) onAction?.("override", { snapshotId: point.snapshotId, reason }, "Override authorized");
                            }}
                            type="button"
                          >
                            Authorize override
                          </button>
                        ) : null}
                      </>
                    ) : null}
                    {assessing === point.snapshotId ? (
                      <form className="incident-assess-form" onSubmit={(event) => submitAssessment(event, point.snapshotId)}>
                        <label className="filter-field">
                          <span>Verdict</span>
                          <select defaultValue="clean" name="verdict">
                            <option value="clean">Clean</option>
                            <option value="compromised">Compromised</option>
                          </select>
                        </label>
                        <label className="filter-field">
                          <span>Rationale</span>
                          <input autoComplete="off" name="rationale" required />
                        </label>
                        <label className="filter-field">
                          <span>Malicious exclusions (clean only), one per line</span>
                          <textarea name="exclusions" placeholder={"group:backdoor | attacker-created group\ngroup:board#description | defaced"} rows={3} />
                        </label>
                        {formError ? <p className="data-error" role="alert">{formError}</p> : null}
                        <div className="form-actions">
                          <button className="btn btn-primary btn-sm" disabled={busy !== null} type="submit">Record assessment</button>
                        </div>
                      </form>
                    ) : null}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** The incident context a restore dry run was planned under, shown in its review. */
export function IncidentQualificationSummary({ context }: {
  context: {
    incidentId: string;
    qualification: "qualified" | "overridden";
    status: RecoveryPointStatus;
    reasons: string[];
    assessment: { version: number; verdict: string } | null;
    exclusions: ParsedExclusion[];
    override: { reason: string; authorizedBy: string } | null;
    postRestoreChecks: { naturalKey: string; field: string | null; expectation: string }[];
  };
}) {
  return (
    <section aria-labelledby="incident-qualification-heading" className={`incident-qualification incident-qualification-${context.qualification}`}>
      <p className="section-kicker">Incident recovery point</p>
      <h4 id="incident-qualification-heading">
        {context.qualification === "qualified" ? "Qualified for this incident" : `Override of a ${context.status} point`}
      </h4>
      <p>{context.reasons.join("; ")}</p>
      {context.override ? (
        <p className="incident-override">Override by <code>{context.override.authorizedBy}</code>: {context.override.reason}</p>
      ) : null}
      {context.postRestoreChecks.length ? (
        <>
          <p>After the restore writes, KEEL re-reads the target and fails the run if any excluded malicious item is still live:</p>
          <ul className="incident-exclusions">
            {context.postRestoreChecks.map((check) => (
              <li key={`${check.naturalKey}#${check.field ?? ""}`}>
                <code>{check.naturalKey}</code>{check.field ? <> field <code>{check.field}</code></> : null}
                {check.expectation === "absent" ? " must be absent" : " must not hold the excluded value"}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <p className="muted-value">A new assessment version, interval change or revoked override after this dry run refuses the promotion.</p>
    </section>
  );
}

export function IncidentRecovery({
  incidents,
  selected,
  canInvestigate,
}: {
  incidents: IncidentSummary[];
  selected: IncidentDetail | null;
  canInvestigate: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);

  async function act(op: string, body: Record<string, unknown>, success: string) {
    setBusy(op);
    try {
      const response = await fetch("/api/actions/incidents", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ op, incidentId: selected?.incident.id, ...body }),
      });
      const payload = (await response.json().catch(() => ({}))) as { message?: string; incident?: { id: string } };
      if (!response.ok) {
        toast({
          tone: "warning",
          title: "Not saved",
          detail: payload.message ?? (response.status === 403 ? "You no longer hold the investigate capability" : "The change was not saved"),
        });
        return;
      }
      toast({ title: success });
      if (op === "open" && payload.incident?.id) router.push(`/incidents?incident=${payload.incident.id}`);
      else router.refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <section aria-labelledby="incident-list-heading" className="report-section">
        <div className="section-heading-row report-heading">
          <div>
            <p className="section-kicker">Incidents</p>
            <h2 id="incident-list-heading">Choose an incident</h2>
          </div>
        </div>
        {incidents.length === 0 ? (
          <p className="empty-state">No incidents are recorded. Restores use routine snapshot selection.</p>
        ) : (
          <nav aria-label="Incidents" className="incident-list">
            {incidents.map((incident) => (
              <Link
                aria-current={selected?.incident.id === incident.id ? "page" : undefined}
                className="incident-link"
                href={`/incidents?incident=${incident.id}`}
                key={incident.id}
              >
                <strong>{incident.title}</strong>
                <span className={`pill pill-${incident.status === "open" ? "bad" : "neutral"}`}>{incident.status === "open" ? "Open" : "Closed"}</span>
                <small>Opened {formatTimestamp(incident.openedAt)}</small>
              </Link>
            ))}
          </nav>
        )}
        {canInvestigate ? (
          <form
            className="incident-open-form"
            onSubmit={(event) => {
              event.preventDefault();
              const form = event.currentTarget;
              const title = String(new FormData(form).get("title") ?? "");
              void act("open", { title, incidentId: undefined }, "Incident opened").then(() => form.reset());
            }}
          >
            <label className="filter-field">
              <span>New incident title</span>
              <input autoComplete="off" name="title" required />
            </label>
            <button className="btn btn-secondary btn-sm" disabled={busy !== null} type="submit">Open incident</button>
          </form>
        ) : null}
      </section>

      {selected ? (
        <section aria-labelledby="incident-detail-heading" className="report-section">
          <div className="section-heading-row report-heading">
            <div>
              <p className="section-kicker">{selected.incident.status === "open" ? "Open incident" : "Closed incident"}</p>
              <h2 id="incident-detail-heading">{selected.incident.title}</h2>
            </div>
            <span className="result-count">
              {selected.recommended ? `Recommended: ${shortId(selected.recommended)}` : "No qualified point yet"}
            </span>
          </div>

          <h3 className="incident-subhead">Compromise intervals</h3>
          {selected.intervals.length === 0 ? (
            <p className="muted-value">None recorded. Without an interval, no snapshot is marked as observed during the compromise.</p>
          ) : (
            <ul className="incident-intervals">
              {selected.intervals.map((interval) => (
                <li key={interval.id}>
                  {formatTimestamp(interval.startsAt)} → {interval.endsAt ? formatTimestamp(interval.endsAt) : "ongoing"} · {interval.reason}
                </li>
              ))}
            </ul>
          )}
          {canInvestigate && selected.incident.status === "open" ? (
            <form
              className="incident-interval-form"
              onSubmit={(event) => {
                event.preventDefault();
                const form = event.currentTarget;
                const data = new FormData(form);
                const startsAt = String(data.get("startsAt") ?? "");
                const endsAt = String(data.get("endsAt") ?? "");
                void act("interval", {
                  startsAt: startsAt ? new Date(`${startsAt}Z`).toISOString() : "",
                  endsAt: endsAt ? new Date(`${endsAt}Z`).toISOString() : null,
                  reason: String(data.get("reason") ?? ""),
                }, "Interval recorded").then(() => form.reset());
              }}
            >
              <label className="filter-field"><span>Starts (UTC)</span><input name="startsAt" required type="datetime-local" /></label>
              <label className="filter-field"><span>Ends (UTC, empty if ongoing)</span><input name="endsAt" type="datetime-local" /></label>
              <label className="filter-field"><span>Evidence or reason</span><input autoComplete="off" name="reason" required /></label>
              <button className="btn btn-secondary btn-sm" disabled={busy !== null} type="submit">Record interval</button>
            </form>
          ) : null}

          <h3 className="incident-subhead">Recovery points</h3>
          <RecoveryPointTable busy={busy} canInvestigate={canInvestigate} detail={selected} onAction={(op, body, success) => void act(op, body, success)} />
        </section>
      ) : null}
    </>
  );
}
