"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { RecordField, TechnicalDetails } from "@/components/technical-details";
import type { IncidentDetail, IncidentExclusion, IncidentRecoveryPoint, IncidentSummary } from "@/lib/portal-data";
import {
  ASSESSMENT_VERDICT_LABELS, RECOVERY_POINT_LABELS, ago, formatTimestamp, resourceLabel, words,
} from "@/lib/presentation";
import { toast } from "@/lib/toast";
import type { Ref } from "@/lib/types";

// Roadmap task-71: incident-qualified recovery points, built to the portal experience
// contract. During a compromise the newest snapshot is the one most likely to carry
// the attacker's changes, so this page never recommends "the latest backup": the
// engine checks each snapshot against when the attacker had access and against the
// investigator's checks, and the recommended snapshot is the newest one cleared.
// Verdict → explanation (names, sentences) → record (every id, labelled).
export type RecoveryPointStatus = IncidentRecoveryPoint["status"];

const STATUS_TONES: Record<RecoveryPointStatus, string> = {
  qualified: "ok",
  unsuitable: "bad",
  unassessed: "warn",
};

export function recoveryPointStatusLabel(status: RecoveryPointStatus): string {
  return RECOVERY_POINT_LABELS[status] ?? words(status);
}

export interface ParsedExclusion {
  naturalKey: string;
  field: string | null;
  reason: string;
}

/** One malicious item per line: `resource key | reason`, or `resource key#setting | reason`. */
export function parseExclusions(text: string): { exclusions: ParsedExclusion[]; error: string | null } {
  const exclusions: ParsedExclusion[] = [];
  const lines = text.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  for (const [index, line] of lines.entries()) {
    const [target, ...reasonParts] = line.split("|");
    const reason = reasonParts.join("|").trim();
    const [naturalKey, field] = target.trim().split("#");
    if (!naturalKey || !reason) {
      return { exclusions: [], error: `Line ${index + 1}: write "resource key | reason" or "resource key#setting | reason".` };
    }
    exclusions.push({ naturalKey: naturalKey.trim(), field: field?.trim() || null, reason });
  }
  return { exclusions, error: null };
}

/** "the “description” setting of Board (group)" or "Helpdesk Tier 0 (group)". */
export function exclusionLabel(exclusion: Pick<IncidentExclusion, "naturalKey" | "field"> & { displayName?: string | null }): string {
  const resource = resourceLabel(exclusion.naturalKey, exclusion.displayName ?? null);
  return exclusion.field ? `the “${words(exclusion.field).toLowerCase()}” setting of ${resource}` : resource;
}

function snapshotWhen(snapshot: Ref): string {
  return snapshot.name.replace(/^Snapshot of /, "the snapshot of ");
}

export interface IncidentVerdict {
  tone: "good" | "attention" | "critical";
  text: string;
  action: { label: string; href: string } | null;
}

function restoreHref(snapshotId: string, incidentId: string): string {
  return `/restore?snapshot=${encodeURIComponent(snapshotId)}&incident=${encodeURIComponent(incidentId)}`;
}

/** The page's one sentence (portal experience contract, verdict layer). */
export function incidentVerdict({ incidents, selected }: { incidents: IncidentSummary[]; selected: IncidentDetail | null }): IncidentVerdict {
  if (incidents.length === 0 || !selected) {
    return { tone: "good", text: "No security incidents are recorded. Restores can use any snapshot.", action: null };
  }
  const title = `“${selected.incident.title}”`;
  const recommended = selected.points.find((point) => point.snapshotId === selected.recommended) ?? null;
  if (!recommended) {
    return {
      tone: "critical",
      text: `No snapshot is cleared for ${title} yet. An investigator must check one before you restore.`,
      action: null,
    };
  }
  return {
    tone: selected.incident.status === "open" ? "attention" : "good",
    text: `Restore from ${snapshotWhen(recommended.snapshot)}, the newest one cleared for ${title}.`,
    action: { label: "Restore from this snapshot", href: restoreHref(recommended.snapshotId, selected.incident.id) },
  };
}

function PersonName({ person }: { person: Ref | null }) {
  if (!person) return <>someone no longer readable</>;
  return person.href ? <Link href={person.href}>{person.name}</Link> : <>{person.name}</>;
}

function Ago({ value, now }: { value: string | null; now: string }) {
  return <time dateTime={value ?? undefined} title={value ? formatTimestamp(value) : undefined}>{ago(value, now)}</time>;
}

/** What one snapshot's state means, as sentences with names. */
function PointExplanation({ point, now }: { point: IncidentRecoveryPoint; now: string }) {
  const assessment = point.assessment;
  return (
    <div className="incident-point-explanation">
      {point.status === "qualified" && assessment ? (
        <p>Cleared by <PersonName person={assessment.assessedBy} /> <Ago now={now} value={assessment.assessedAt} />.</p>
      ) : point.status === "unsuitable" && assessment ? (
        <p>Marked unsafe by <PersonName person={assessment.assessedBy} /> <Ago now={now} value={assessment.assessedAt} />.</p>
      ) : point.stale ? (
        <p>Needs a new check: the attack window changed after it was checked.</p>
      ) : (
        <p>Not yet checked by an investigator.</p>
      )}
      {point.inCompromiseWindow ? <p className="incident-window">Taken while the attacker had access.</p> : null}
      {assessment?.exclusions.length ? (
        <>
          <p>The restore leaves out {assessment.exclusions.length === 1 ? "one malicious item" : `${assessment.exclusions.length} malicious items`}:</p>
          <ul className="incident-exclusions">
            {assessment.exclusions.map((exclusion) => (
              <li key={`${exclusion.naturalKey}#${exclusion.field ?? ""}`}>{exclusionLabel(exclusion)}: {exclusion.reason}</li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

function PointRecord({ point, pinId }: { point: IncidentRecoveryPoint; pinId: string | null }) {
  return (
    <TechnicalDetails>
      <RecordField label="Snapshot ID" usage={<>use with <code>keel-restore --snapshot-id &lt;id&gt;</code></>} value={point.snapshotId} />
      <RecordField copy={false} label="Collected between" value={`${point.observedFrom ?? "unknown"} and ${point.observedTo ?? "unknown"}`} />
      <RecordField copy={false} label="Recovery point state" value={`${point.status}${point.stale ? " (stale assessment)" : ""}`} />
      <RecordField copy={false} label="Engine reasons" value={point.reasons.join("; ")} />
      {point.assessment ? (
        <>
          <RecordField copy={false} label="Assessment version" value={`v${point.assessment.version} · ${point.assessment.verdict} · ${point.assessment.assessedAt ?? "unknown time"}`} />
          <RecordField label="Assessment fingerprint" usage="bound into every restore plan made from this snapshot" value={point.assessment.fingerprint} />
          {point.assessment.assessedBy ? <RecordField label="Assessed by (principal ID)" value={point.assessment.assessedBy.id} /> : null}
          {point.assessment.exclusions.map((exclusion) => (
            <RecordField
              copy={false}
              key={`${exclusion.naturalKey}#${exclusion.field ?? ""}`}
              label="Exclusion"
              value={`${exclusion.naturalKey}${exclusion.field ? ` field ${exclusion.field}` : ""}`}
            />
          ))}
        </>
      ) : null}
      {pinId ? <RecordField label="Retention pin ID" usage={<>release with <code>POST /api/actions/incidents</code> (op release)</>} value={pinId} /> : null}
    </TechnicalDetails>
  );
}

export function RecoveryPointTable({
  detail,
  now,
  canInvestigate = false,
  busy = null,
  onAction,
}: {
  detail: IncidentDetail;
  now: string;
  canInvestigate?: boolean;
  busy?: string | null;
  onAction?: (op: string, body: Record<string, unknown>, success: string) => void;
}) {
  const [checking, setChecking] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const pinBySnapshot = new Map(detail.pins.map((pin) => [pin.snapshotId, pin]));
  const incidentOpen = detail.incident.status === "open";

  if (detail.points.length === 0) {
    return <p className="empty-state">No completed snapshots exist for this tenant yet.</p>;
  }

  function submitCheck(event: FormEvent<HTMLFormElement>, snapshotId: string) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const verdict = String(data.get("verdict") ?? "");
    const parsed = parseExclusions(String(data.get("exclusions") ?? ""));
    if (parsed.error) {
      setFormError(parsed.error);
      return;
    }
    if (verdict === "compromised" && parsed.exclusions.length > 0) {
      setFormError("An unsafe snapshot is refused as a whole. Leaving items out applies only to a clean one.");
      return;
    }
    setFormError(null);
    onAction?.("assess", {
      snapshotId, verdict, rationale: String(data.get("rationale") ?? ""), exclusions: parsed.exclusions,
    }, "Check recorded");
    setChecking(null);
  }

  return (
    <div className="table-scroll">
      <table className="data-table incident-points">
        <caption className="visually-hidden">Snapshots for {detail.incident.title}, newest first</caption>
        <thead>
          <tr>
            <th scope="col">Snapshot</th>
            <th scope="col">Safe to restore?</th>
            <th scope="col">Kept</th>
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
                  <span className="incident-point-name">{point.snapshot.name}</span>
                  <PointRecord pinId={pin?.id ?? null} point={point} />
                </th>
                <td>
                  <span className={`pill pill-${STATUS_TONES[point.status]}`}>{recoveryPointStatusLabel(point.status)}</span>
                  {recommended ? <span className="pill pill-info incident-recommended">Recommended</span> : null}
                  <PointExplanation now={now} point={point} />
                </td>
                <td>
                  {pin ? (
                    <p className="incident-pin-note">
                      Kept by <PersonName person={pin.pinnedBy} /> until released. Being kept does not mean it is clean.
                    </p>
                  ) : (
                    <span className="muted-value">Normal retention</span>
                  )}
                </td>
                <td>
                  <div className="incident-actions">
                    <Link className="btn btn-secondary btn-sm" href={restoreHref(point.snapshotId, detail.incident.id)}>
                      {point.status === "qualified" ? "Restore from here" : "Restore needs an override"}
                    </Link>
                    {canInvestigate && incidentOpen ? (
                      <>
                        <button
                          aria-expanded={checking === point.snapshotId}
                          className="btn btn-ghost btn-sm"
                          disabled={busy !== null}
                          onClick={() => { setFormError(null); setChecking(checking === point.snapshotId ? null : point.snapshotId); }}
                          type="button"
                        >
                          Record a check
                        </button>
                        {pin ? (
                          <button
                            className="btn btn-ghost btn-sm"
                            disabled={busy !== null}
                            onClick={() => {
                              const reason = window.prompt("Why can this snapshot go back to normal retention?");
                              if (reason) onAction?.("release", { pinId: pin.id, reason }, "No longer kept");
                            }}
                            type="button"
                          >
                            Stop keeping
                          </button>
                        ) : (
                          <button
                            className="btn btn-ghost btn-sm"
                            disabled={busy !== null}
                            onClick={() => {
                              const reason = window.prompt("Why must this snapshot be kept from routine clean-up?");
                              if (reason) onAction?.("pin", { snapshotId: point.snapshotId, reason }, "Snapshot kept");
                            }}
                            type="button"
                          >
                            Keep
                          </button>
                        )}
                        {point.status !== "qualified" ? (
                          <button
                            className="btn btn-ghost btn-sm"
                            disabled={busy !== null}
                            onClick={() => {
                              const reason = window.prompt("Why must a restore use this snapshot anyway? Someone else must request the restore.");
                              if (reason) onAction?.("override", { snapshotId: point.snapshotId, reason }, "Override approved");
                            }}
                            type="button"
                          >
                            Approve an override
                          </button>
                        ) : null}
                      </>
                    ) : null}
                    {checking === point.snapshotId ? (
                      <form className="incident-assess-form" onSubmit={(event) => submitCheck(event, point.snapshotId)}>
                        <label className="filter-field">
                          <span>Result</span>
                          <select defaultValue="clean" name="verdict">
                            <option value="clean">{ASSESSMENT_VERDICT_LABELS.clean}</option>
                            <option value="compromised">{ASSESSMENT_VERDICT_LABELS.compromised}</option>
                          </select>
                        </label>
                        <label className="filter-field">
                          <span>Why</span>
                          <input autoComplete="off" name="rationale" required />
                        </label>
                        <label className="filter-field">
                          <span>Malicious items to leave out (clean only), one per line</span>
                          <textarea name="exclusions" placeholder={"group:backdoor | attacker-created group\ngroup:board#description | defaced"} rows={3} />
                        </label>
                        {formError ? <p className="data-error" role="alert">{formError}</p> : null}
                        <div className="form-actions">
                          <button className="btn btn-secondary btn-sm" disabled={busy !== null} type="submit">Save check</button>
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

export interface IncidentRecoveryView {
  incidentTitle: string | null;
  authorizedBy: Ref | null;
  checks: { label: string; expectation: string }[];
}

/** The incident context a restore dry run was planned under, shown in its review. */
export function IncidentQualificationSummary({ context, view }: {
  context: {
    incidentId: string;
    qualification: "qualified" | "overridden";
    status: RecoveryPointStatus;
    reasons: string[];
    assessment: { id?: string; version: number; verdict: string; fingerprint?: string } | null;
    exclusions: ParsedExclusion[];
    override: { id?: string; reason: string; authorizedBy: string } | null;
    postRestoreChecks: { naturalKey: string; field: string | null; expectation: string }[];
  };
  view?: IncidentRecoveryView | null;
}) {
  const title = view?.incidentTitle ? `“${view.incidentTitle}”` : "this incident";
  const checks = view?.checks ?? [];
  return (
    <section aria-labelledby="incident-qualification-heading" className={`incident-qualification incident-qualification-${context.qualification}`}>
      <div data-layer="explanation">
        <h4 id="incident-qualification-heading">
          {context.qualification === "qualified"
            ? `This snapshot is cleared for ${title}.`
            : `This snapshot is ${context.status === "unsuitable" ? "marked unsafe" : "not checked"} for ${title}; an override allows it.`}
        </h4>
        {context.override ? (
          <p className="incident-override">
            Override approved by <PersonName person={view?.authorizedBy ?? null} />: {context.override.reason}
          </p>
        ) : null}
        {checks.length > 0 ? (
          <>
            <p>After the restore, KEEL reads the tenant again and fails the restore if any of these is still there:</p>
            <ul className="incident-exclusions">
              {checks.map((check) => (
                <li key={check.label}>{check.expectation === "absent" ? `${check.label} must be gone` : `${check.label} must not hold the malicious value`}</li>
              ))}
            </ul>
          </>
        ) : null}
        <p className="muted-value">If an investigator changes their check before the restore runs, the restore is blocked.</p>
      </div>
      <TechnicalDetails>
        <RecordField label="Incident ID" usage={<>use with <code>keel-restore --incident &lt;id&gt;</code></>} value={context.incidentId} />
        <RecordField copy={false} label="Recovery point state" value={`${context.status} · ${context.qualification} · ${context.reasons.join("; ")}`} />
        {context.assessment ? (
          <>
            <RecordField copy={false} label="Assessment version" value={`v${context.assessment.version} · ${context.assessment.verdict}`} />
            {context.assessment.fingerprint ? <RecordField label="Assessment fingerprint" usage="bound into this plan's digest" value={context.assessment.fingerprint} /> : null}
          </>
        ) : null}
        {context.override ? (
          <>
            {context.override.id ? <RecordField label="Override ID" value={context.override.id} /> : null}
            <RecordField label="Authorized by (principal ID)" value={context.override.authorizedBy} />
          </>
        ) : null}
        {context.postRestoreChecks.map((check) => (
          <RecordField
            copy={false}
            key={`${check.naturalKey}#${check.field ?? ""}`}
            label="Post-restore check"
            value={`${check.naturalKey}${check.field ? ` field ${check.field}` : ""} → ${check.expectation}`}
          />
        ))}
      </TechnicalDetails>
    </section>
  );
}

export function IncidentRecovery({
  incidents,
  selected,
  canInvestigate,
  now,
}: {
  incidents: IncidentSummary[];
  selected: IncidentDetail | null;
  canInvestigate: boolean;
  now: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const verdict = incidentVerdict({ incidents, selected });

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
          detail: payload.message ?? (response.status === 403 ? "You can no longer change incidents" : "The change was not saved"),
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
      <section className={`verdict verdict-${verdict.tone}`} data-layer="verdict">
        <p className="verdict-sentence">{verdict.text}</p>
        {verdict.action ? <Link className="btn btn-primary primary" href={verdict.action.href}>{verdict.action.label}</Link> : null}
      </section>

      <div data-layer="explanation">
        <section aria-labelledby="incident-list-heading" className="report-section">
          <h2 id="incident-list-heading">Incidents</h2>
          {incidents.length === 0 ? null : (
            <nav aria-label="Incidents" className="incident-list">
              {incidents.map((incident) => (
                <Link
                  aria-current={selected?.incident.id === incident.id ? "page" : undefined}
                  className="incident-link"
                  href={`/incidents?incident=${incident.id}`}
                  key={incident.id}
                >
                  <strong>{incident.title}</strong>
                  <span>
                    {incident.status === "open" ? "Open" : "Closed"} · opened <Ago now={now} value={incident.openedAt} /> by {incident.owner.name}
                  </span>
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
            <h2 id="incident-detail-heading">{selected.incident.title}</h2>

            <h3 className="incident-subhead">When the attacker had access</h3>
            {selected.intervals.length === 0 ? (
              <p className="muted-value">Not recorded yet, so no snapshot is marked as taken during the attack.</p>
            ) : (
              <ul className="incident-intervals">
                {selected.intervals.map((interval) => (
                  <li key={interval.id}>
                    From <Ago now={now} value={interval.startsAt} />{" "}
                    {interval.endsAt ? <>until <Ago now={now} value={interval.endsAt} /></> : "and still ongoing"}: {interval.reason}
                    {interval.recordedBy ? <> (recorded by <PersonName person={interval.recordedBy} />)</> : null}
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
                  }, "Attack window recorded").then(() => form.reset());
                }}
              >
                <label className="filter-field"><span>Access started (UTC)</span><input name="startsAt" required type="datetime-local" /></label>
                <label className="filter-field"><span>Access ended (UTC, empty if ongoing)</span><input name="endsAt" type="datetime-local" /></label>
                <label className="filter-field"><span>How you know</span><input autoComplete="off" name="reason" required /></label>
                <button className="btn btn-secondary btn-sm" disabled={busy !== null} type="submit">Record attack window</button>
              </form>
            ) : null}

            <h3 className="incident-subhead">Snapshots, newest first</h3>
            <RecoveryPointTable
              busy={busy}
              canInvestigate={canInvestigate}
              detail={selected}
              now={now}
              onAction={(op, body, success) => void act(op, body, success)}
            />
          </section>
        ) : null}
      </div>

      {selected ? (
        <TechnicalDetails summary="Technical details for this incident">
          <RecordField label="Incident ID" usage={<>use with <code>keel-restore --snapshot-id &lt;id&gt; --select &lt;key&gt; --incident &lt;id&gt;</code></>} value={selected.incident.id} />
          <RecordField label="Owner (principal ID)" value={selected.incident.owner.id || null} />
          <RecordField copy={false} label="Opened" value={selected.incident.openedAt} />
          {selected.intervals.map((interval) => (
            <RecordField
              copy={false}
              key={interval.id}
              label="Compromise interval"
              value={`${interval.startsAt ?? "unknown"} → ${interval.endsAt ?? "ongoing"} · ${interval.id}`}
            />
          ))}
          <RecordField copy={false} label="Changes" value="POST /api/actions/incidents (requires investigate)" />
        </TechnicalDetails>
      ) : null}
    </>
  );
}
