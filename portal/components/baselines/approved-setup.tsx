import Link from "next/link";

import { ActivateBaseline } from "@/components/activate-baseline";
import { RiskChip, SectionHead } from "@/components/baselines/parts";
import { ScoreRing } from "@/components/compliance/score-ring";
import { BaselinesStyles } from "@/components/baselines/styles";
import { ResnapshotBaseline } from "@/components/resnapshot-baseline";
import { Icon } from "@/components/shell/icons";
import { RecordField, TechnicalDetails } from "@/components/technical-details";
import {
  captureBlockedWords, coverageWords, kindsWords, notHeldWords, overallScore, putBackWords, serviceSettingsWords, serviceSummaries, setupName, versionState,
  type ServiceReadKind, type ServiceSummary,
} from "@/lib/baselines-view";
import { captureScope, changesSentence, leftOutWords, resnapshotSource, scoreTone, type ComplianceScore } from "@/lib/compliance-view";
import { ago, formatTimestamp } from "@/lib/presentation";
import type { BackupGap, BaselineRecord, DriftRecord } from "@/lib/types";

export interface CaptureSource {
  id: string;
  completedAt: string | null;
}

function compareHref(baseline: BaselineRecord, latest: CaptureSource | null): string | null {
  const from = baseline.capture?.sourceSnapshotId;
  if (!from || !latest || latest.id === from) return null;
  return `/compare?from=${encodeURIComponent(from)}&to=${encodeURIComponent(latest.id)}`;
}

function Fact({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="bl-fact">
      <dt>{label}</dt>
      <dd>{value}{note ? <small>{note}</small> : null}</dd>
    </div>
  );
}

/** The approved setup in use: what it is, how old, who approved it, and what to do next. */
function CurrentSetup({ active, backedUp, baselines, canBaseline, gap, latest, now, sources }: {
  active: BaselineRecord;
  backedUp: string[];
  baselines: BaselineRecord[];
  canBaseline: boolean;
  gap: BackupGap | null;
  latest: CaptureSource | null;
  now: string;
  sources: CaptureSource[];
}) {
  const captured = active.capture?.capturedAt ?? null;
  const compare = compareHref(active, latest);
  const source = resnapshotSource(active, sources);
  const leftOut = leftOutWords(active.capture);
  const putBack = putBackWords(active, baselines, now);
  const notHeld = notHeldWords(active, backedUp);
  const capture = captureBlockedWords({ capturedAt: captured, gap, hasSource: Boolean(source), now, sources });
  return (
    <section aria-labelledby="bl-current-heading" className="bl-card bl-current">
      <div className="bl-current-head">
        <span aria-hidden="true" className="bl-kind-icon" data-tone="fine"><Icon name="baselines" /></span>
        <div className="bl-current-name">
          <h2 id="bl-current-heading">{setupName(active)}</h2>
          <p>{active.description ?? "The setup every change is measured against."}</p>
        </div>
        <RiskChip tone="fine">In use</RiskChip>
      </div>
      <dl className="bl-facts">
        <Fact label="Approved by" note={`${ago(active.setAt, now)}, on ${formatTimestamp(active.setAt)}`} value={active.setByRef?.name ?? "an unknown account"} />
        <Fact label="Settings from" note={captureScope(active.capture)} value={captured ? ago(captured, now) : "Not recorded"} />
        <Fact label="Holds" note={serviceSettingsWords(active) ?? "Every setting it holds is checked after each backup."} value={coverageWords(active)} />
        <Fact label="Version" note={active.version && active.version > 1 ? "Earlier versions are kept below." : "The first version of this setup."} value={String(active.version ?? 1)} />
      </dl>
      {putBack ? (
        <p className="bl-help" data-part="put-back" role="note"><RiskChip tone="soon">Put back</RiskChip> {putBack}</p>
      ) : null}
      {leftOut ? (
        <p className="bl-help" role="note"><RiskChip tone="soon">Left out</RiskChip> {leftOut}</p>
      ) : null}
      {notHeld && !putBack ? (
        <p className="bl-help" data-part="not-held" role="note"><RiskChip tone="low">Not covered</RiskChip> {notHeld}</p>
      ) : null}
      <div className="bl-actions">
        {compare ? (
          <Link className="btn" href={compare}><Icon name="page" />Compare with the latest backup</Link>
        ) : null}
        <ResnapshotBaseline baselineId={active.id} disabled={!canBaseline} label={setupName(active)} snapshotId={source?.id ?? null} />
        <Link className="btn" href="/baselines/new"><Icon name="plus" />New approved setup</Link>
      </div>
      <p className="bl-help" data-part="capture-reason">
        {!source ? <RiskChip tone="soon">Not available yet</RiskChip> : null}
        {!source ? " " : null}
        {capture}
        {gap && !source ? <> <Link href="/protect">What&apos;s protected</Link> shows each kind&apos;s last read.</> : null}
      </p>
    </section>
  );
}

// The three counts on a service card. A service read the approved setup does not hold
// yet is measured against its own setup, taken from Keel's first read, so a kind it
// could not read is "not read" rather than "not covered".
const STAT_WORDS: Record<ServiceSummary["basis"], { inLine: string; notCovered: string }> = {
  "approved-setup": { inLine: "In line", notCovered: "Not covered" },
  "previous-backup": { inLine: "In line", notCovered: "Not read" },
};

function serviceNote(summary: ServiceSummary) {
  if (summary.changed) {
    return <>{summary.changed === 1 ? "1 change" : `${summary.changed} changes`} to {kindsWords(summary.changedKinds)}.<span className="bl-go">Review {summary.changed === 1 ? "it" : "them"}<Icon name="chevron" /></span></>;
  }
  if (summary.basis === "previous-backup") {
    return summary.inLine.length
      ? `Matches its approved setup: ${kindsWords(summary.inLine)}.`
      : `The latest backup could not read ${kindsWords(summary.notCovered)}.`;
  }
  if (summary.inLine.length) return `Matches the approved setup: ${kindsWords(summary.inLine)}.`;
  const notRead = summary.notRead ?? [];
  const missing = summary.notCovered.filter((type) => !notRead.includes(type));
  return missing.length
    ? `Not in the approved setup yet: ${kindsWords(missing)}.`
    : `The latest backup could not read ${kindsWords(notRead)}.`;
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString("en-GB")} ${count === 1 ? one : many}`;
}

/** "1,180 of 1,204 settings match" */
function matchSentence(score: ComplianceScore): string {
  if (score.percent === null) return "No settings to compare yet";
  return `${score.passed.toLocaleString("en-GB")} of ${plural(score.evaluated, "setting")} match`;
}

/** The overall match: one big ring, how many settings match, and what is left out. */
function MatchScore({ score, summaries }: { score: ComplianceScore; summaries: ServiceSummary[] }) {
  const differ = score.evaluated - score.passed;
  const unscored = summaries.filter((summary) => !summary.score).map((summary) => summary.service.name);
  const tone = scoreTone(score);
  return (
    <div className="bl-card bl-score" data-tone={tone}>
      <ScoreRing label="Overall" score={score} sentence={matchSentence(score)} size="lg" unit="match" />
      <div className="bl-score-words">
        <h3>{score.percent === null ? "Nothing to compare yet" : `${score.percent}% of settings match the approved setup`}</h3>
        <p>
          <b>{matchSentence(score)}</b>
          {differ > 0 ? <> · <RiskChip tone={tone === "urgent" || tone === "soon" ? tone : "low"}>{plural(differ, "setting differs", "settings differ")}</RiskChip></> : null}
        </p>
        <p className="bl-help">
          Every setting Keel compares counts once. A setting that was changed, removed or added since counts as not matching.
          {" "}Kinds not covered or not read are left out.
          {unscored.length ? ` No percentage yet for ${unscored.join(", ")}: Keel has no count of the settings it compares there.` : ""}
        </p>
      </div>
    </div>
  );
}

function ServiceCard({ summary }: { summary: ServiceSummary }) {
  const total = summary.inLine.length + summary.changedKinds.length + summary.notCovered.length || 1;
  const words = STAT_WORDS[summary.basis];
  const body = (
    <>
      <div className="bl-service-head">
        <Icon name={summary.service.icon} />
        <span className="bl-service-name"><b>{summary.service.name}</b><small>{summary.service.about}</small></span>
        {summary.score ? <ScoreRing label={summary.service.name} score={summary.score} sentence={matchSentence(summary.score)} size="sm" unit="match" /> : null}
      </div>
      <div aria-hidden="true" className="bl-bar">
        <span data-part="changed" data-tone={summary.tone} style={{ flexGrow: summary.changedKinds.length / total }} />
        <span data-part="in-line" style={{ flexGrow: summary.inLine.length / total }} />
        <span data-part="not-covered" style={{ flexGrow: summary.notCovered.length / total }} />
      </div>
      <dl className="bl-service-stats">
        <div data-part="changed" data-tone={summary.changed ? summary.tone : undefined}>
          <dt>Changed</dt>
          <dd>{summary.changedKinds.length}<small>{summary.changedKinds.length === 1 ? "kind" : "kinds"}</small></dd>
        </div>
        <div data-part="in-line">
          <dt>{words.inLine}</dt>
          <dd>{summary.inLine.length}<small>{summary.inLine.length === 1 ? "kind" : "kinds"}</small></dd>
        </div>
        <div data-part="not-covered">
          <dt>{words.notCovered}</dt>
          <dd>{summary.notCovered.length}<small>{summary.notCovered.length === 1 ? "kind" : "kinds"}</small></dd>
        </div>
      </dl>
      <p className="bl-service-note">{serviceNote(summary)}</p>
    </>
  );
  return summary.changed ? (
    <li><Link className="bl-card bl-service bl-link" data-basis={summary.basis} data-tone={summary.tone} href={`/drift?service=${encodeURIComponent(summary.service.code)}`}>{body}</Link></li>
  ) : (
    <li><div className="bl-card bl-service" data-basis={summary.basis} data-tone={summary.notCovered.length && !summary.inLine.length ? undefined : "fine"}>{body}</div></li>
  );
}

/** "41 changes since" in one short line; the split by kind is in Technical details. */
function versionChanges(baseline: BaselineRecord): string {
  const changes = baseline.changesSinceCapture;
  // Every version is compared with the same newest complete backup, so the reason there
  // is none is said once, above the list and beside "Capture new version".
  if (changes?.state === "no-collection") return "Not compared yet";
  if (!changes || changes.state !== "compared") return changesSentence(changes, { short: true });
  return changes.total === 0 ? "Matches the tenant since" : `${changes.total.toLocaleString("en-GB")} ${changes.total === 1 ? "change" : "changes"} since`;
}

function OtherVersions({ baselines, canBaseline, now }: { baselines: BaselineRecord[]; canBaseline: boolean; now: string }) {
  if (!baselines.length) return null;
  const notCompared = baselines.some((baseline) => baseline.changesSinceCapture?.state === "no-collection");
  // Newest approved first. A version put back from an earlier one is approved later than
  // the version it copies, though its settings are older: each row says both.
  const ordered = [...baselines].sort((a, b) => Date.parse(b.setAt) - Date.parse(a.setAt) || (b.version ?? 1) - (a.version ?? 1));
  const about = `Setups you approved before, newest approved first. Using one again needs someone else's approval.${notCompared
    ? " Keel compares each one with the newest complete backup; until a backup reads every kind in full, they show Not compared yet."
    : ""}`;
  return (
    <section aria-labelledby="bl-versions-heading" className="bl-section">
      <SectionHead about={about} id="bl-versions-heading" title="Other approved setups" />
      <ul className="bl-versions">
        {ordered.map((baseline) => {
          const state = versionState(baseline);
          const replaced = Boolean(baseline.supersededById || baseline.supersededAt);
          const captured = baseline.capture?.capturedAt ?? null;
          return (
            <li className="bl-card bl-version" key={baseline.id}>
              <span aria-hidden="true" className="bl-kind-icon"><Icon name="baselines" /></span>
              <div className="bl-version-name">
                <b>{setupName(baseline)}</b>
                <small>Version {baseline.version ?? 1}{baseline.reinstatedFrom ? `, a copy of version ${baseline.reinstatedFrom.version}` : ""} · {coverageWords(baseline)}</small>
              </div>
              <div className="bl-version-when">
                <time dateTime={baseline.setAt} title={formatTimestamp(baseline.setAt)}>Approved {ago(baseline.setAt, now)}</time>
                <small>
                  <time dateTime={captured ?? undefined} title={formatTimestamp(captured)}>{captured ? `Settings from ${ago(captured, now)}` : "Settings date not recorded"}</time>
                  {" · "}{versionChanges(baseline)}
                </small>
              </div>
              <RiskChip tone={state.tone}>{state.label}</RiskChip>
              {replaced ? <span className="bl-version-actions" /> : (
                <span className="bl-version-actions">
                  <ActivateBaseline baselineId={baseline.id} disabled={!canBaseline} />
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Every id the page shows, in one record at its foot. */
function Record({ baselines }: { baselines: BaselineRecord[] }) {
  return (
    <TechnicalDetails summary="Technical details: approved setups">
      {baselines.flatMap((baseline) => {
        const capture = baseline.capture;
        const changes = baseline.changesSinceCapture;
        const name = setupName(baseline);
        return [
          <RecordField key={`${baseline.id}-id`} label={`Baseline ID · ${name}`} usage={<>use with <code>POST /api/actions/baseline/activate</code></>} value={baseline.id} />,
          <RecordField copy={false} key={`${baseline.id}-set`} label={`Set at · ${name}`} value={baseline.setAt} />,
          <RecordField key={`${baseline.id}-by`} label={`Set by (principal ID) · ${name}`} value={baseline.setBy} />,
          baseline.supersedesId ? <RecordField key={`${baseline.id}-sup`} label={`Supersedes baseline ID · ${name}`} value={baseline.supersedesId} /> : null,
          baseline.supersededById ? <RecordField key={`${baseline.id}-supby`} label={`Superseded by baseline ID · ${name}`} value={baseline.supersededById} /> : null,
          <RecordField copy={false} key={`${baseline.id}-basis`} label={`Capture basis · ${name}`} value={capture?.basis ?? "unknown"} />,
          capture?.sourceSnapshotId ? <RecordField key={`${baseline.id}-src`} label={`Source snapshot ID · ${name}`} usage={<>use with <code>keel-baseline-create --snapshot-id</code></>} value={capture.sourceSnapshotId} /> : null,
          <RecordField copy={false} key={`${baseline.id}-types`} label={`Types captured · ${name}`} value={capture?.types.length ? capture.types.join(", ") : null} />,
          <RecordField copy={false} key={`${baseline.id}-services`} label={`Service reads captured · ${name}`} value={capture?.services?.length ? capture.services.map((service) => `${service.workload} (${service.settings}, read ${service.collectedAt ?? "unknown"})`).join(", ") : null} />,
          <RecordField copy={false} key={`${baseline.id}-cmp`} label={`Comparison · ${name}`} value={changes ? `${changes.state} · added ${changes.added} · modified ${changes.modified} · removed ${changes.removed}${changes.reason ? ` · ${changes.reason}` : ""}${changes.comparedSnapshotId ? ` · snapshot ${changes.comparedSnapshotId}` : ""}` : null} />,
        ];
      })}
    </TechnicalDetails>
  );
}

/** The Approved setup page body (handoff/redesign/CHOICE.md, "Baselines"): the setup in
 * use, a summary per Microsoft service, the other versions, and the record. */
export function ApprovedSetup({
  baselines,
  items,
  serviceChanges = [],
  serviceReads = [],
  backedUp,
  canBaseline,
  gap = null,
  held = null,
  now,
  sources,
}: {
  baselines: BaselineRecord[];
  // Open changes against the setup in use; null when they could not be read.
  items: Pick<DriftRecord, "resourceType" | "blastRadius" | "changeType">[] | null;
  // Open changes to Exchange, SharePoint and OneDrive, Teams, Purview and Power Platform
  // settings, each compared with the approved setup (lib/service-changes.ts).
  serviceChanges?: Pick<DriftRecord, "resourceType" | "blastRadius" | "serviceRead" | "changeType">[];
  // Those services' kinds on What's protected, and whether the latest backup read them.
  serviceReads?: ServiceReadKind[];
  // Kinds of setting Keel backs up today, to show what the setup does not cover.
  backedUp: string[];
  canBaseline: boolean;
  // The newest finished backup when it cannot be the source of a new version, and why.
  gap?: BackupGap | null;
  // Settings the setup in use holds, per kind; null when they could not be counted, and
  // then no score shows. A score also needs the open changes.
  held?: Record<string, number> | null;
  now: string;
  // Complete backups, newest first: the source for a new version.
  sources: CaptureSource[];
}) {
  const active = baselines.find((baseline) => baseline.active) ?? null;
  const others = baselines.filter((baseline) => baseline !== active);
  const summaries = active ? serviceSummaries(active, [...(items ?? []), ...serviceChanges], backedUp, serviceReads, items === null ? null : held) : [];
  const overall = overallScore(summaries);
  const anyRead = summaries.some((summary) => summary.basis === "previous-backup");
  return (
    <div className="bl-page">
      <BaselinesStyles />
      {active ? (
        <CurrentSetup active={active} backedUp={backedUp} baselines={baselines} canBaseline={canBaseline} gap={gap} latest={sources[0] ?? null} now={now} sources={sources} />
      ) : (
        <section className="bl-card bl-empty">
          <span aria-hidden="true" className="bl-kind-icon" data-tone="urgent"><Icon name="baselines" /></span>
          <div>
            <h2>No approved setup yet</h2>
            <p>An approved setup is a copy of how the tenant should look. Keel compares the tenant with it after every backup and lists what changed.</p>
          </div>
          <Link className="btn" href="/baselines/new"><Icon name="plus" />Create an approved setup</Link>
        </section>
      )}
      {active ? (
        <section aria-labelledby="bl-services-heading" className="bl-section">
          <SectionHead
            about={items === null
              ? "Open changes could not be read just now, so every service shows as in line."
              : anyRead
                ? "Each Microsoft service against the approved setup. Some service settings are not in this version yet, so they are measured against Keel's first read of them; capture a new version to add them. Services that need a look come first."
                : "Each Microsoft service against the approved setup. Services that need a look come first."}
            id="bl-services-heading"
            title="By service"
          />
          {overall ? <MatchScore score={overall} summaries={summaries} /> : null}
          <ul className="bl-services">
            {summaries.map((summary) => <ServiceCard key={summary.service.code} summary={summary} />)}
          </ul>
          <dl className="bl-legend">
            <div><dt data-part="changed">Changed</dt><dd>Kinds of setting that differ from the approved setup. The colour shows the worst risk among them.</dd></div>
            <div><dt data-part="in-line">In line</dt><dd>Matches the approved setup, including Exchange, SharePoint, Teams, Purview and Power Platform settings. Accept keeps it up to date.</dd></div>
            <div><dt data-part="not-covered">Not covered</dt><dd>Keel backs it up, but the approved setup does not hold it yet, or the latest read of it failed. Capture a new version to add it.</dd></div>
            {anyRead ? (
              <>
                <div><dt data-part="not-covered">Not read</dt><dd>The latest backup could not read it, or has not read it yet. <Link href="/protect">What&apos;s protected</Link> says why.</dd></div>
              </>
            ) : null}
          </dl>
        </section>
      ) : null}
      <OtherVersions baselines={others} canBaseline={canBaseline} now={now} />
      {baselines.length ? <Record baselines={baselines} /> : null}
    </div>
  );
}
