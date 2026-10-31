import Link from "next/link";
import type { ReactNode } from "react";

import { Icon, type IconName } from "@/components/shell/icons";
import { RecordField, RecordGroup, TechnicalDetails } from "@/components/technical-details";
import { AlertList } from "@/components/ui/alert-list";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { StatTiles } from "@/components/ui/stat-tiles";
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
  resilienceAlerts,
  resilienceTiles,
  serviceCounts,
  serviceGroups,
  storageSentence,
  type DependencyRef,
  type ResilienceAlert,
  type ResilienceData,
  type ResilienceTone,
  type ServiceGroup,
} from "@/lib/resilience-view";

// The Resilience page (redesign): what needs the reader comes first, as alerts that
// each say what to do; then four tiles, every backup by service in one table, and the
// measurements last. "Not measured" is its own state, never zero, and the planned
// timetable is labelled as a plan, never as a result. Words live in lib/resilience-view.

const REPORT_CLI = "node cli/keel-recovery-metrics.mjs report";

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

function badgeTone(tone: ResilienceTone): BadgeTone {
  return tone;
}

function Tiles({ data, groups }: { data: ResilienceData; groups: ServiceGroup[] }) {
  return <StatTiles tiles={resilienceTiles(data, groups)} />;
}

function Alerts({ alerts }: { alerts: ResilienceAlert[] }) {
  const urgent = alerts.filter((alert) => alert.tone === "urgent").length;
  return (
    <section aria-labelledby="rs-attention-heading" className="rs-attention" id="rs-attention">
      <div className="rs-section-head">
        <h2 id="rs-attention-heading"><Icon name="alert" />Needs your attention</h2>
        {alerts.length ? <Badge tone={urgent ? "urgent" : "soon"}>{`${alerts.length} item${alerts.length === 1 ? "" : "s"}`}</Badge> : null}
      </div>
      <AlertList items={alerts} />
    </section>
  );
}

function Services({ data, groups }: { data: ResilienceData; groups: ServiceGroup[] }) {
  const counts = serviceCounts(groups);
  return (
    <section aria-labelledby="rs-services-heading" className="rs-services" id="rs-services">
      <div className="rs-section-head">
        <div>
          <h2 id="rs-services-heading"><Icon name="backup" />Backups by service</h2>
          <p className="rs-sub">Nightly: content at 01:00 UTC, settings at 02:00 UTC.</p>
        </div>
        <Badge tone={badgeTone(counts.worst)}>{counts.on ? `${counts.good} of ${counts.on} working` : "None running"}</Badge>
      </div>
      <div className="rs-table-wrap">
        <table className="rs-table">
          <thead>
            <tr><th scope="col">What is backed up</th><th scope="col">State</th><th scope="col">Last good copy</th><th scope="col">Holds</th></tr>
          </thead>
          {groups.map((group) => (
            <tbody key={group.key}>
              <tr className="rs-group"><th colSpan={4} scope="colgroup"><span><Icon name={group.icon as IconName} />{group.name}</span></th></tr>
              {group.rows.map((row) => (
                <tr data-row={row.key} data-tone={row.tone} key={row.key}>
                  <th scope="row"><span className="rs-row-name">{row.name}</span><small>{row.what}</small></th>
                  <td data-label="State"><Badge tone={badgeTone(row.tone)}>{row.status}</Badge></td>
                  <td data-label="Last good copy">{row.last}</td>
                  <td data-empty={row.holds ? undefined : ""} data-label="Holds">{row.holds || "—"}</td>
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </div>
      <ServicesRecord data={data} />
    </section>
  );
}

function DetailCard({ id, icon, title, tone, chip, value, children }: {
  id: string; icon: IconName; title: string; tone: ResilienceTone; chip: string; value: string; children: ReactNode;
}) {
  return (
    <section aria-labelledby={`rs-${id}-heading`} className={`rs-card resilience-${id}`} data-tone={tone} id={`rs-${id}`}>
      <div className="rs-card-head">
        <h3 id={`rs-${id}-heading`}><Icon name={icon} />{title}</h3>
        <Badge tone={badgeTone(tone)}>{chip}</Badge>
      </div>
      <p className="rs-card-value">{value}</p>
      {children}
    </section>
  );
}

function measured(state: string): { tone: ResilienceTone; chip: string } {
  if (state === "measured" || state === "drilled") return { tone: "fine", chip: "Measured" };
  if (state === "attention") return { tone: "urgent", chip: "Needs attention" };
  return { tone: "soon", chip: "Not measured" };
}

function TimeBars({ data }: { data: ResilienceData }) {
  const now = data.generatedAt;
  const attempts = data.metrics.recoveryTime.attempts.slice(-6).reverse();
  if (!attempts.length) return null;
  const longest = Math.max(1, ...attempts.map((attempt) => attempt.elapsedMs ?? 0));
  return (
    <ul aria-label="Recent restores and drills" className="rs-bars">
      {attempts.map((attempt) => (
        <li data-counts={attempt.counts} key={`${attempt.source}-${attempt.ref ?? attempt.at}`}>
          <span className="rs-bar-name">
            {attempt.source === "restore" && attempt.ref
              ? <Link href={`/jobs/${attempt.ref}`}>{attemptName(attempt)}</Link>
              : attemptName(attempt)}
            {" "}<span title={formatTimestamp(attempt.at)}>{ago(attempt.at, now)}</span>
          </span>
          {attempt.counts && attempt.elapsedMs !== null
            ? <span className="rs-bar"><i style={{ width: `${Math.max(4, Math.round((attempt.elapsedMs / longest) * 100))}%` }} /><b>{formatDuration(attempt.elapsedMs)}</b></span>
            : <span className="rs-bar rs-bar-none"><Badge tone={attempt.reason === "awaiting-verification" ? "low" : "urgent"}>{`Does not count: ${attemptReason(attempt)}`}</Badge></span>}
        </li>
      ))}
    </ul>
  );
}

function Details({ data }: { data: ResilienceData }) {
  const { metrics, generatedAt: now } = data;
  const { freshness, recoverablePoint, recoveryTime, readiness, configured } = metrics;
  const storageTone: ResilienceTone = data.storage.immutability === "live-qualified" ? "fine" : "soon";
  return (
    <section aria-labelledby="rs-details-heading" className="rs-details">
      <div className="rs-section-head">
        <div>
          <h2 id="rs-details-heading"><Icon name="info" />The numbers in detail</h2>
          <p className="rs-sub">Only finished, checked work counts.</p>
        </div>
      </div>
      <div className="rs-cards">
        <DetailCard
          chip={measured(recoverablePoint.state).chip} icon="cloud" id="point" title="Safe copy off this server" tone={measured(recoverablePoint.state).tone}
          value={recoverablePoint.state === "measured" && recoverablePoint.point ? `Settings as of ${ago(recoverablePoint.point, now)}` : "Not measured"}
        >
          <p className="rs-sentence resilience-sentence">{recoverablePointSentence(metrics, now)}</p>
          <p className="rs-help">Covers Entra ID and Intune settings for now. <Link href="/activity?what=copy">Off-site copies</Link></p>
          <PointRecord data={data} />
        </DetailCard>

        <DetailCard
          chip={measured(recoveryTime.state).chip} icon="restore" id="time" title="How long a recovery takes" tone={measured(recoveryTime.state).tone}
          value={recoveryTime.state === "measured" ? formatDuration(recoveryTime.latestMs) : "Not measured"}
        >
          <p className="rs-sentence resilience-sentence">{recoveryTimeSentence(metrics)}</p>
          <TimeBars data={data} />
          <p className="rs-help">
            {recoveryTime.state === "measured" ? `Usually ${formatDuration(recoveryTime.medianMs)}. ` : ""}No target time is set.
          </p>
          <TimeRecord data={data} />
        </DetailCard>

        <DetailCard
          chip={measured(freshness.state).chip} icon="clock" id="freshness" title="Age of the oldest backup" tone={freshness.state === "gaps" ? "urgent" : measured(freshness.state).tone}
          value={freshness.state === "measured" ? formatDuration(freshness.achievedRpoMs) : "Not measured"}
        >
          <p className="rs-sentence resilience-sentence">{freshnessSentence(metrics)}</p>
          {notUsedSentence(metrics) ? (
            <div className="resilience-not-used">
              <p className="rs-help">{notUsedSentence(metrics)}</p>
              <ul className="rs-rows">
                {(freshness.notUsed ?? []).map((entry) => <li key={entry.key}><Badge tone="neutral">Not used</Badge> <span>{dependencyName(entry)}</span></li>)}
              </ul>
            </div>
          ) : null}
          <h4 className="rs-mini-head">Planned timetable</h4>
          {configured.cadence.length ? (
            <ul className="rs-rows rs-plan">
              {configured.cadence.map((entry) => <li key={entry.id}><Icon name="calendar" /><span>{cadenceSentence(entry)}</span></li>)}
            </ul>
          ) : <p className="rs-help">No backup timetable is set.</p>}
          <p className="rs-help">The plan, not a result. <Link href="/schedules">Change it</Link></p>
          <FreshnessRecord data={data} />
        </DetailCard>

        <DetailCard
          chip={measured(readiness.state).chip} icon="play" id="drills" title="Recovery drills" tone={measured(readiness.state).tone}
          value={readiness.state === "attention" ? "Test objects left" : readiness.lastCountedDrill ? `Passed ${ago(readiness.lastCountedDrill.at, now)}` : "Not measured"}
        >
          <p className="rs-sentence resilience-sentence">{readinessSentence(metrics, now)}</p>
          {readiness.cleanupFailures.length ? (
            <ul className="rs-rows">
              {readiness.cleanupFailures.map((failure) => (
                <li key={failure.at}><Icon name="alert" /><span>The drill <span title={formatTimestamp(failure.at)}>{ago(failure.at, now)}</span> left {failure.residuals.length || failure.objects.length} test object{(failure.residuals.length || failure.objects.length) === 1 ? "" : "s"} behind.</span></li>
              ))}
            </ul>
          ) : null}
          <p className="rs-help">A drill restores one test group. It is not a full-tenant recovery.</p>
          <DrillsRecord data={data} />
        </DetailCard>

        <DetailCard
          chip={data.incidents.length ? `${data.incidents.length} open` : "None open"} icon="alert" id="incidents" title="Incidents" tone={data.incidents.length ? "urgent" : "fine"}
          value={data.incidents.length ? `${data.incidents.length} open` : "None open"}
        >
          {data.incidents.length ? (
            <ul className="rs-rows">
              {data.incidents.map((summary) => (
                <li key={summary.incident.id}>
                  <Icon name="alert" />
                  <span><Link data-ref="incident" href={`/incidents?incident=${summary.incident.id}`}>{summary.incident.title}</Link>: {incidentSentence(summary, now)}</span>
                </li>
              ))}
            </ul>
          ) : <p className="rs-sentence resilience-sentence">No incident is open.</p>}
          <IncidentsRecord data={data} />
        </DetailCard>

        <DetailCard
          chip={storageTone === "fine" ? "Proven" : "Not proven"} icon="backup" id="storage" title="Where backups are kept" tone={storageTone}
          value={!data.storage.configured ? "Unknown" : data.storage.immutability === "live-qualified" ? "Locked" : data.storage.immutability === "unsupported" ? "Can be deleted" : "Not proven"}
        >
          <p className="rs-sentence resilience-sentence">{storageSentence(data.storage)}</p>
          {data.storage.configured ? (
            <p className="rs-help">On {data.storage.provider === "local-disk" ? "a local disk" : data.storage.provider}{data.storage.region ? ` in ${data.storage.region}` : ""}.</p>
          ) : null}
          <StorageRecord data={data} />
        </DetailCard>
      </div>
    </section>
  );
}

export function ResilienceView({ data }: { data: ResilienceData }) {
  const groups = serviceGroups(data.metrics, data.kinds, data.generatedAt);
  const alerts = resilienceAlerts(data);
  return (
    <div className="rs-page">
      <Alerts alerts={alerts} />
      <Tiles data={data} groups={groups} />
      <Services data={data} groups={groups} />
      <Details data={data} />
    </div>
  );
}

// --- Technical details: ids, raw values and where they are accepted ----------------

function FreshnessRecord({ data }: { data: ResilienceData }) {
  const { metrics } = data;
  const { freshness, configured } = metrics;
  return (
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
        <RecordGroup key={`gap:${gap.key}`} note="no good backup yet" title={gap.key}>
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
  );
}

function ServicesRecord({ data }: { data: ResilienceData }) {
  const { metrics } = data;
  return (
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
  );
}

function PointRecord({ data }: { data: ResilienceData }) {
  const { recoverablePoint } = data.metrics;
  return (
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
  );
}

function TimeRecord({ data }: { data: ResilienceData }) {
  const { recoveryTime } = data.metrics;
  return (
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
  );
}

function DrillsRecord({ data }: { data: ResilienceData }) {
  const { readiness } = data.metrics;
  return (
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
  );
}

function IncidentsRecord({ data }: { data: ResilienceData }) {
  if (!data.incidents.length) return null;
  return (
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
  );
}

function StorageRecord({ data }: { data: ResilienceData }) {
  const { metrics } = data;
  return (
    <TechnicalDetails>
      <RecordField label="Provider" value={data.storage.provider} copy={false} />
      <RecordField label="Region" value={data.storage.region} copy={false} />
      <RecordField label="Boundary" value={data.storage.boundary} copy={false} />
      <RecordField label="Immutability claim" value={data.storage.immutability} copy={false} />
      <RecordField label="Manifest generated" value={data.storage.generatedAt} copy={false} />
      <RecordField label="Recovery manifest" value={data.storage.source} usage={<>set with <code>KEEL_RECOVERY_MANIFEST_PATH</code></>} />
      <RecordField label="Tenant reference" value={metrics.tenantRef} />
    </TechnicalDetails>
  );
}
