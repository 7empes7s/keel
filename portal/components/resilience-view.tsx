import Link from "next/link";
import type { ReactNode } from "react";

import { RecordField, TechnicalDetails } from "@/components/technical-details";
import { ago, formatTimestamp } from "@/lib/presentation";
import {
  attemptName,
  attemptReason,
  cadenceSentence,
  dependencyName,
  formatDuration,
  freshnessSentence,
  incidentSentence,
  offsiteReason,
  readinessSentence,
  recoverablePointSentence,
  recoveryTimeSentence,
  storageSentence,
  type ResilienceData,
} from "@/lib/resilience-view";

// Roadmap task-73: the Resilience page's explanation and record layers. Each card
// says what was measured, in words; "Not measured" is shown as its own state, never
// as zero, and the configured timetable is labelled as a plan, never as a result.

type Tone = "ok" | "warn" | "bad";

function StatePill({ tone, label }: { tone: Tone; label: string }) {
  return <span className={`pill pill-${tone}`}>{label}</span>;
}

function measuredPill(state: string): { tone: Tone; label: string } {
  if (state === "measured" || state === "drilled") return { tone: "ok", label: "Measured" };
  if (state === "attention") return { tone: "bad", label: "Needs attention" };
  return { tone: "warn", label: "Not measured" };
}

function Card({ id, title, state, children }: { id: string; title: string; state: { tone: Tone; label: string }; children: ReactNode }) {
  return (
    <section aria-labelledby={`${id}-heading`} className={`item-card resilience-card resilience-${id}`}>
      <div className="item-card-head">
        <h2 id={`${id}-heading`}>{title}</h2>
        <StatePill label={state.label} tone={state.tone} />
      </div>
      {children}
    </section>
  );
}

const REPORT_CLI = "node cli/keel-recovery-metrics.mjs report";

export function ResilienceView({ data }: { data: ResilienceData }) {
  const { metrics, generatedAt: now } = data;
  const { freshness, recoverablePoint, recoveryTime, readiness, configured } = metrics;
  const failedTries = recoveryTime.attempts.filter((attempt) => !attempt.counts).slice(-5).reverse();
  const otherCopies = recoverablePoint.copies.filter((copy) => !copy.counts).slice(-5).reverse();
  return (
    <div className="resilience-grid">
      <Card id="freshness" state={measuredPill(freshness.state)} title="How recent the backups are">
        <p className="resilience-sentence">{freshnessSentence(metrics)}</p>
        {freshness.gaps.length ? (
          <ul className="resilience-list">
            {freshness.gaps.slice(0, 6).map((gap) => (
              <li key={gap.key}>{dependencyName(gap)} has never been backed up successfully.</li>
            ))}
            {freshness.gaps.length > 6 ? <li>And {freshness.gaps.length - 6} more.</li> : null}
          </ul>
        ) : null}
        {freshness.latestFailures.length ? (
          <ul className="resilience-list">
            {freshness.latestFailures.slice(0, 6).map((failure) => (
              <li key={failure.key}>
                {dependencyName(failure)}: the latest backup {failure.outcome === "partial" ? "stopped part way" : "failed"}{" "}
                <span title={formatTimestamp(failure.failedAt)}>{ago(failure.failedAt, now)}</span>, so KEEL still relies on the one from{" "}
                <span title={formatTimestamp(failure.lastSuccessAt)}>{ago(failure.lastSuccessAt, now)}</span>.
              </li>
            ))}
          </ul>
        ) : null}
        <h3>Planned timetable</h3>
        {configured.cadence.length ? (
          <ul className="resilience-list resilience-plan">
            {configured.cadence.map((entry) => <li key={entry.id}>{cadenceSentence(entry)}</li>)}
          </ul>
        ) : <p className="field-help">No backup timetable is set.</p>}
        <p className="field-help">This is the plan, not a result. The age above comes only from backups that finished.</p>
        <TechnicalDetails>
          <RecordField label="Achieved recovery point age (ms)" value={freshness.achievedRpoMs === null ? "unmeasured" : String(freshness.achievedRpoMs)} usage={<>from <code>{REPORT_CLI}</code></>} />
          <RecordField label="Freshness state" value={freshness.state} copy={false} />
          <RecordField label="Required items" value={String(freshness.required)} copy={false} />
          <RecordField label="Oldest required item" value={freshness.oldestDependency ? `${freshness.oldestDependency.key} since ${freshness.oldestDependency.since}` : null} />
          {freshness.gaps.length ? <RecordField label="Never backed up" value={freshness.gaps.map((gap) => gap.key).join(", ")} /> : null}
          {freshness.latestFailures.map((failure) => (
            <RecordField copy={false} key={failure.key} label={`Latest failure · ${failure.key}`} value={`${failure.outcome ?? "unknown"} at ${failure.failedAt ?? "unknown"}; last success ${failure.lastSuccessAt}`} />
          ))}
          {configured.cadence.map((entry) => (
            <RecordField key={entry.id} label={`Schedule ${entry.jobKind}${entry.tier ? ` ${entry.tier}` : ""}`} value={`${entry.id} · ${entry.cron ?? JSON.stringify(entry.cadence)}${entry.enabled ? "" : " · disabled"}`} usage={<><code>GET /api/schedules</code></>} />
          ))}
          <RecordField label="Recovery objectives" value="not set (KEEL stores no recovery objective)" copy={false} />
        </TechnicalDetails>
      </Card>

      <Card id="point" state={measuredPill(recoverablePoint.state)} title="Recovery point if this server were lost">
        <p className="resilience-sentence">{recoverablePointSentence(metrics, now)}</p>
        {recoverablePoint.fromCopy ? (
          <p className="field-help">
            From the copy sent <span title={formatTimestamp(recoverablePoint.fromCopy.shippedAt)}>{ago(recoverablePoint.fromCopy.shippedAt, now)}</span>; its files were checked against its recovery manifest and the off-site copy matched.
          </p>
        ) : null}
        {otherCopies.length ? (
          <ul className="resilience-list">
            {otherCopies.map((copy) => (
              <li key={copy.seq ?? copy.recordedAt}>
                The copy sent <span title={formatTimestamp(copy.shippedAt)}>{ago(copy.shippedAt, now)}</span> does not count: {offsiteReason(copy)}.
              </li>
            ))}
          </ul>
        ) : null}
        <p className="field-help"><Link href="/activity">See off-site copies in Activity</Link></p>
        <TechnicalDetails>
          <RecordField label="Recoverable point" value={recoverablePoint.point ?? "unmeasured"} copy={false} />
          <RecordField label="Recoverable point age (ms)" value={recoverablePoint.ageMs === null ? "unmeasured" : String(recoverablePoint.ageMs)} copy={false} usage={<>from <code>{REPORT_CLI}</code></>} />
          {recoverablePoint.copies.map((copy) => (
            <RecordField
              key={copy.seq ?? copy.recordedAt}
              label={`Evidence sequence ${copy.seq ?? "unknown"} · off-site copy`}
              value={`${copy.counts ? "counted" : copy.reason} · shipped ${copy.shippedAt ?? "unknown"} · dump sha256 ${copy.dumpSha256 ?? "none"}${copy.missing.length ? ` · missing ${copy.missing.join(", ")}` : ""}`}
              usage={<>record with <code>node cli/keel-recovery-metrics.mjs record-offsite</code>; read with <code>GET /api/evidence</code></>}
            />
          ))}
        </TechnicalDetails>
      </Card>

      <Card id="time" state={measuredPill(recoveryTime.state)} title="How long a recovery takes">
        <p className="resilience-sentence">{recoveryTimeSentence(metrics)}</p>
        {recoveryTime.state === "measured" ? (
          <p className="field-help">Measured from {recoveryTime.samples} drill{recoveryTime.samples === 1 ? "" : "s"} and restore{recoveryTime.samples === 1 ? "" : "s"} that finished and were checked; the middle one took {formatDuration(recoveryTime.medianMs)}.</p>
        ) : null}
        {failedTries.length ? (
          <ul className="resilience-list">
            {failedTries.map((attempt) => (
              <li key={`${attempt.source}-${attempt.ref ?? attempt.at}`}>
                {attemptName(attempt)} <span title={formatTimestamp(attempt.at)}>{ago(attempt.at, now)}</span> does not count: {attemptReason(attempt)}.
                {attempt.source === "restore" && attempt.ref ? <> <Link href={`/jobs/${attempt.ref}`}>View the restore</Link></> : null}
              </li>
            ))}
          </ul>
        ) : null}
        <p className="field-help">No recovery time target is set in KEEL, so nothing is compared against one.</p>
        <TechnicalDetails>
          <RecordField label="Samples" value={String(recoveryTime.samples)} copy={false} />
          <RecordField label="Latest (ms)" value={recoveryTime.latestMs === null ? "unmeasured" : String(recoveryTime.latestMs)} copy={false} />
          <RecordField label="Slowest (ms)" value={recoveryTime.worstMs === null ? "unmeasured" : String(recoveryTime.worstMs)} copy={false} />
          <RecordField label="Median (ms)" value={recoveryTime.medianMs === null ? "unmeasured" : String(recoveryTime.medianMs)} copy={false} />
          {recoveryTime.attempts.map((attempt) => (
            <RecordField
              key={`${attempt.source}-${attempt.ref ?? attempt.at}`}
              label={attempt.source === "restore" ? "Job ID · restore" : "Evidence sequence · recovery drill"}
              value={`${attempt.ref ?? "unknown"} · ${attempt.counts ? `counted ${attempt.elapsedMs} ms` : attempt.reason} · ${attempt.at ?? "unknown"}`}
              usage={attempt.source === "restore" ? <><code>GET /api/jobs/{attempt.ref ?? "<id>"}</code></> : <><code>GET /api/evidence</code></>}
            />
          ))}
        </TechnicalDetails>
      </Card>

      <Card id="drills" state={measuredPill(readiness.state)} title="Recovery drills">
        <p className="resilience-sentence">{readinessSentence(metrics, now)}</p>
        <p className="field-help">A drill creates, changes, restores and removes one test group. It shows KEEL can put a setting back here; it is not a whole-tenant recovery.</p>
        {readiness.cleanupFailures.length ? (
          <ul className="resilience-list">
            {readiness.cleanupFailures.map((failure) => (
              <li key={failure.at}>The drill <span title={formatTimestamp(failure.at)}>{ago(failure.at, now)}</span> left {failure.residuals.length || failure.objects.length} test object{(failure.residuals.length || failure.objects.length) === 1 ? "" : "s"} behind.</li>
            ))}
          </ul>
        ) : null}
        <TechnicalDetails>
          <RecordField label="Drill state" value={readiness.state} copy={false} />
          <RecordField label="Counted drills" value={String(readiness.countedDrills)} copy={false} />
          {readiness.notCounted.map((entry) => <RecordField copy={false} key={`${entry.at}-${entry.reason}`} label={`Not counted · ${entry.at}`} value={entry.reason} />)}
          {readiness.cleanupFailures.map((failure) => <RecordField key={failure.at} label={`Residual objects · ${failure.at}`} value={failure.objects.join(", ")} />)}
          <RecordField label="Scope" value={readiness.scope} copy={false} usage={<>run with <code>node tools/rehearsal/qualification.mjs</code></>} />
        </TechnicalDetails>
      </Card>

      <Card id="incidents" state={data.incidents.length ? { tone: "warn", label: `${data.incidents.length} open` } : { tone: "ok", label: "None open" }} title="Incidents">
        {data.incidents.length ? (
          <ul className="resilience-list">
            {data.incidents.map((summary) => (
              <li key={summary.incident.id}>
                <Link data-ref="incident" href={`/incidents?incident=${summary.incident.id}`}>{summary.incident.title}</Link>: {incidentSentence(summary, now)}
              </li>
            ))}
          </ul>
        ) : <p className="resilience-sentence">No incident is open. During one, restore from a snapshot an investigator has checked.</p>}
        {data.incidents.length ? (
          <TechnicalDetails>
            {data.incidents.map((summary) => (
              <RecordField key={summary.incident.id} label={`Incident ID · ${summary.incident.title}`} value={`${summary.incident.id}${summary.recommended ? ` · cleared snapshot ${summary.recommended.snapshotId}` : ""} · pins ${summary.pins}`} usage={<><code>/incidents?incident={summary.incident.id}</code></>} />
            ))}
          </TechnicalDetails>
        ) : null}
      </Card>

      <Card id="storage" state={data.storage.immutability === "live-qualified" ? { tone: "ok", label: "Proven" } : { tone: "warn", label: "Not proven" }} title="Where backups are kept">
        <p className="resilience-sentence">{storageSentence(data.storage)}</p>
        {data.storage.configured ? (
          <p className="field-help">Stored with {data.storage.provider === "local-disk" ? "a local disk" : data.storage.provider}{data.storage.region ? ` in ${data.storage.region}` : ""}.</p>
        ) : null}
        <TechnicalDetails>
          <RecordField label="Provider" value={data.storage.provider} copy={false} />
          <RecordField label="Immutability claim" value={data.storage.immutability} copy={false} />
          <RecordField label="Recovery manifest" value={data.storage.source} usage={<>set with <code>KEEL_RECOVERY_MANIFEST_PATH</code></>} />
          <RecordField label="Tenant reference" value={metrics.tenantRef} />
        </TechnicalDetails>
      </Card>
    </div>
  );
}
