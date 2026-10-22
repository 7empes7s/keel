import Link from "next/link";
import type { ReactNode } from "react";

import { RecordField, RecordGroup, TechnicalDetails } from "@/components/technical-details";
import { ago, formatTimestamp } from "@/lib/presentation";
import {
  attemptName,
  attemptReason,
  cadenceSentence,
  dependencyName,
  formatDuration,
  freshnessSentence,
  notUsedSentence,
  incidentSentence,
  offsiteReason,
  readinessSentence,
  recoverablePointSentence,
  recoveryTimeSentence,
  serviceBackupSentence,
  servicesSentence,
  storageSentence,
  type DependencyRef,
  type ResilienceData,
  type ServiceBackup,
} from "@/lib/resilience-view";

// Roadmap task-73: the Resilience page's explanation and record layers. Each card
// says what was measured, in words; "Not measured" is shown as its own state, never
// as zero, and the configured timetable is labelled as a plan, never as a result.

type Tone = "ok" | "warn" | "bad" | "neutral";

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

/** What one required item is: its key, kind and type (or parent type and relationship). */
function DependencyFields({ dependency }: { dependency: DependencyRef }) {
  return (
    <>
      <RecordField label="Key" value={dependency.key} />
      <RecordField copy={false} label="Kind" value={dependency.kind} />
      {dependency.type ? <RecordField copy={false} label="Type" value={dependency.type} /> : null}
      {dependency.parentType ? <RecordField copy={false} label="Parent type" value={dependency.parentType} /> : null}
      {dependency.family ? <RecordField copy={false} label="Relationship" value={dependency.family} /> : null}
      {dependency.workload ? <RecordField copy={false} label="Workload" value={dependency.workload} /> : null}
    </>
  );
}

const REPORT_CLI = "node cli/keel-recovery-metrics.mjs report";

function ServiceList({ title, entries, now }: { title: string; entries: ServiceBackup[]; now: string }) {
  if (entries.length === 0) return null;
  return (
    <>
      <h3>{title}</h3>
      <ul className="resilience-list">
        {entries.map((entry) => (
          <li key={`${entry.kind}:${entry.workload}`}><strong>{entry.name}</strong>: {serviceBackupSentence(entry, now)}</li>
        ))}
      </ul>
    </>
  );
}

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
        {notUsedSentence(metrics) ? (
          <div className="resilience-not-used">
            <p className="field-help">{notUsedSentence(metrics)}</p>
            <ul className="resilience-list">
              {(freshness.notUsed ?? []).map((entry) => (
                <li key={entry.key}><StatePill label="Not used" tone="neutral" /> {dependencyName(entry)}</li>
              ))}
            </ul>
          </div>
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
          <RecordField label="Achieved recovery point age (ms)" value={freshness.achievedRpoMs ?? "unmeasured"} usage={<>from <code>{REPORT_CLI}</code></>} />
          <RecordField label="Freshness state" value={freshness.state} copy={false} />
          <RecordField label="Required items" value={freshness.required} copy={false} />
          <RecordField copy={false} label="Report version" value={metrics.version} />
          <RecordField copy={false} label="Report generated" value={metrics.generatedAt} />
          {freshness.oldestDependency ? (
            <RecordGroup note="oldest required item" title={freshness.oldestDependency.key}>
              <DependencyFields dependency={freshness.oldestDependency} />
              <RecordField copy={false} label="Backed up since" value={freshness.oldestDependency.since} />
              <RecordField copy={false} label="Age (ms)" value={freshness.oldestDependency.ageMs} />
            </RecordGroup>
          ) : null}
          {freshness.gaps.map((gap) => (
            <RecordGroup key={`gap:${gap.key}`} note="never backed up" title={gap.key}>
              <DependencyFields dependency={gap} />
              <RecordField copy={false} label="Last attempt" value={gap.lastAttempt?.at} />
              <RecordField copy={false} label="Last attempt outcome" value={gap.lastAttempt?.outcome} />
            </RecordGroup>
          ))}
          {freshness.latestFailures.map((failure) => (
            <RecordGroup key={`failure:${failure.key}`} note="latest failure" title={failure.key}>
              <DependencyFields dependency={failure} />
              <RecordField copy={false} label="Outcome" value={failure.outcome} />
              <RecordField copy={false} label="Failed at" value={failure.failedAt} />
              <RecordField copy={false} label="Last success" value={failure.lastSuccessAt} />
            </RecordGroup>
          ))}
          {configured.cadence.map((entry) => (
            <RecordGroup key={entry.id} note={entry.enabled ? "enabled" : "disabled"} title={`Schedule: ${entry.jobKind}${entry.tier ? ` ${entry.tier}` : ""}`}>
              <RecordField label="Schedule ID" usage={<><code>GET /api/schedules</code></>} value={entry.id} />
              <RecordField copy={false} label="Job kind" value={entry.jobKind} />
              <RecordField copy={false} label="Tier" value={entry.tier} />
              <RecordField copy={false} label="Cron" value={entry.cron} />
              <RecordField copy={false} label="Cadence" value={entry.cadence} />
              <RecordField copy={false} label="Enabled" value={entry.enabled} />
            </RecordGroup>
          ))}
          <RecordField label="Recovery objectives" value="not set (KEEL stores no recovery objective)" copy={false} />
        </TechnicalDetails>
      </Card>

      <Card
        id="services"
        state={(() => {
          const all = [...(metrics.services?.settings ?? []), ...(metrics.services?.content ?? [])].filter((entry) => entry.switchedOn);
          if (all.length === 0) return { tone: "warn" as Tone, label: "Not measured" };
          return all.every((entry) => entry.lastGood && entry.latest?.id === entry.lastGood.id) ? { tone: "ok" as Tone, label: "All good" } : { tone: "warn" as Tone, label: "Needs attention" };
        })()}
        title="Every service"
      >
        <p className="resilience-sentence">{servicesSentence(metrics)}</p>
        <ServiceList entries={metrics.services?.settings ?? []} now={now} title="Service settings (nightly at 02:00 UTC)" />
        <ServiceList entries={metrics.services?.content ?? []} now={now} title="Content (nightly at 01:00 UTC)" />
        <p className="field-help">Entra ID and Intune settings are counted in the card above, type by type.</p>
        <TechnicalDetails>
          {[...(metrics.services?.settings ?? []), ...(metrics.services?.content ?? [])].map((entry) => (
            <RecordGroup key={`${entry.kind}:${entry.workload}`} note={entry.kind} title={entry.workload}>
              <RecordField copy={false} label="Switched on" value={entry.switchedOn} />
              <RecordField label="Latest run" value={entry.latest?.id} />
              <RecordField copy={false} label="Latest outcome" value={entry.latest?.outcome} />
              <RecordField copy={false} label="Latest at" value={entry.latest?.at} />
              <RecordField label="Last good run" value={entry.lastGood?.id} />
              <RecordField copy={false} label="Last good at" value={entry.lastGood?.at} />
              {entry.stored ? <RecordField copy={false} label="Stored" value={`${entry.stored.items} items, ${entry.stored.versions} versions, ${entry.stored.containers} containers, ${entry.stored.bytes} bytes`} /> : null}
            </RecordGroup>
          ))}
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
        <p className="field-help">An off-site copy is checked for the Entra ID and Intune settings backup. Service settings and content are not part of that check yet.</p>
        <p className="field-help"><Link href="/activity">See off-site copies in Activity</Link></p>
        <TechnicalDetails>
          <RecordField label="Recoverable point" value={recoverablePoint.point ?? "unmeasured"} copy={false} />
          <RecordField copy={false} label="State" value={recoverablePoint.state} />
          <RecordField label="Recoverable point age (ms)" value={recoverablePoint.ageMs ?? "unmeasured"} copy={false} usage={<>from <code>{REPORT_CLI}</code></>} />
          <RecordField label="Counted from evidence sequence" value={recoverablePoint.fromCopy?.seq} />
          <RecordField label="Newest copy evidence sequence" value={recoverablePoint.latestCopy?.seq} />
          {recoverablePoint.copies.map((copy, index) => (
            <RecordGroup key={copy.seq ?? copy.recordedAt ?? index} note={copy.counts ? "counted" : "not counted"} title={`Off-site copy, evidence sequence ${copy.seq ?? "unknown"}`}>
              <RecordField label="Evidence sequence" usage={<>record with <code>node cli/keel-recovery-metrics.mjs record-offsite</code>; read with <code>GET /api/evidence</code></>} value={copy.seq} />
              <RecordField copy={false} label="Counts" value={copy.counts} />
              <RecordField copy={false} label="Reason" value={copy.reason} />
              <RecordField copy={false} label="Recovery point" value={copy.point} />
              <RecordField copy={false} label="Shipped" value={copy.shippedAt} />
              <RecordField copy={false} label="Recorded" value={copy.recordedAt} />
              <RecordField copy={false} label="Manifest generated" value={copy.manifestGeneratedAt} />
              <RecordField label="Dump SHA-256" value={copy.dumpSha256} />
              {copy.missing.length ? <RecordField label="Missing" value={copy.missing} /> : null}
            </RecordGroup>
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
          <RecordField copy={false} label="State" value={recoveryTime.state} />
          <RecordField label="Samples" value={recoveryTime.samples} copy={false} />
          <RecordField label="Latest (ms)" value={recoveryTime.latestMs ?? "unmeasured"} copy={false} />
          <RecordField copy={false} label="Latest at" value={recoveryTime.latestAt} />
          <RecordField label="Slowest (ms)" value={recoveryTime.worstMs ?? "unmeasured"} copy={false} />
          <RecordField label="Median (ms)" value={recoveryTime.medianMs ?? "unmeasured"} copy={false} />
          {recoveryTime.attempts.map((attempt, index) => (
            <RecordGroup key={`${attempt.source}-${attempt.ref ?? attempt.at ?? index}`} note={attempt.counts ? "counted" : "not counted"} title={attempt.source === "restore" ? "Restore" : "Recovery drill"}>
              <RecordField
                label={attempt.source === "restore" ? "Job ID" : "Evidence sequence"}
                usage={attempt.source === "restore" ? <><code>GET /api/jobs/{attempt.ref ?? "<id>"}</code></> : <><code>GET /api/evidence</code></>}
                value={attempt.ref}
              />
              <RecordField copy={false} label="At" value={attempt.at} />
              <RecordField copy={false} label="Outcome" value={attempt.outcome} />
              <RecordField copy={false} label="Counts" value={attempt.counts} />
              <RecordField copy={false} label="Elapsed (ms)" value={attempt.elapsedMs} />
              <RecordField copy={false} label="Reason" value={attempt.reason} />
            </RecordGroup>
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
          <RecordField label="Counted drills" value={readiness.countedDrills} copy={false} />
          {readiness.lastCountedDrill ? (
            <RecordGroup note="counted" title="Newest counted drill">
              <RecordField copy={false} label="At" value={readiness.lastCountedDrill.at} />
              <RecordField copy={false} label="Elapsed (ms)" value={readiness.lastCountedDrill.elapsedMs} />
              <RecordField label="Objects" value={readiness.lastCountedDrill.objects} />
            </RecordGroup>
          ) : null}
          {readiness.notCounted.map((entry) => (
            <RecordGroup key={`${entry.at}-${entry.reason}`} note="not counted" title="Drill">
              <RecordField copy={false} label="At" value={entry.at} />
              <RecordField copy={false} label="Reason" value={entry.reason} />
            </RecordGroup>
          ))}
          {readiness.cleanupFailures.map((failure) => (
            <RecordGroup key={failure.at} note="clean-up left objects behind" title="Drill clean-up">
              <RecordField copy={false} label="At" value={failure.at} />
              <RecordField label="Residual objects" value={failure.objects} />
              {failure.residuals.length ? <RecordField label="Residual details" value={failure.residuals} /> : null}
            </RecordGroup>
          ))}
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
              <RecordGroup key={summary.incident.id} note={summary.incident.status} title={summary.incident.title}>
                <RecordField label="Incident ID" usage={<><code>/incidents?incident={summary.incident.id}</code></>} value={summary.incident.id} />
                <RecordField copy={false} label="Opened" value={summary.incident.openedAt} />
                <RecordField label="Cleared snapshot ID" usage={summary.recommended?.collectedAt ? `collected ${summary.recommended.collectedAt}` : undefined} value={summary.recommended?.snapshotId} />
                <RecordField copy={false} label="Retention pins" value={summary.pins} />
              </RecordGroup>
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
          <RecordField label="Region" value={data.storage.region} copy={false} />
          <RecordField label="Boundary" value={data.storage.boundary} copy={false} />
          <RecordField label="Immutability claim" value={data.storage.immutability} copy={false} />
          <RecordField label="Manifest generated" value={data.storage.generatedAt} copy={false} />
          <RecordField label="Recovery manifest" value={data.storage.source} usage={<>set with <code>KEEL_RECOVERY_MANIFEST_PATH</code></>} />
          <RecordField label="Tenant reference" value={metrics.tenantRef} />
        </TechnicalDetails>
      </Card>
    </div>
  );
}
