import Link from "next/link";

import { ActivateBaseline } from "@/components/activate-baseline";
import { RiskChip, SectionHead } from "@/components/baselines/parts";
import { BaselinesStyles } from "@/components/baselines/styles";
import { ResnapshotBaseline } from "@/components/resnapshot-baseline";
import { Icon } from "@/components/shell/icons";
import { RecordField, TechnicalDetails } from "@/components/technical-details";
import {
  coverageWords, kindsWords, serviceSummaries, setupName, versionState, type ServiceReadKind, type ServiceSummary,
} from "@/lib/baselines-view";
import { captureScope, changesSentence, resnapshotSource } from "@/lib/compliance-view";
import { ago, formatTimestamp } from "@/lib/presentation";
import type { BaselineRecord, DriftRecord } from "@/lib/types";

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
function CurrentSetup({ active, canBaseline, latest, now, sources }: {
  active: BaselineRecord;
  canBaseline: boolean;
  latest: CaptureSource | null;
  now: string;
  sources: CaptureSource[];
}) {
  const captured = active.capture?.capturedAt ?? null;
  const compare = compareHref(active, latest);
  const source = resnapshotSource(active, sources);
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
        <Fact label="Captured" note={captureScope(active.capture)} value={captured ? ago(captured, now) : "Not recorded"} />
        <Fact label="Holds" note="Every setting it holds is checked after each backup." value={coverageWords(active)} />
        <Fact label="Approved by" note={`On ${formatTimestamp(active.setAt)}`} value={active.setByRef?.name ?? "an unknown account"} />
        <Fact label="Version" note={active.version && active.version > 1 ? "Earlier versions are kept below." : "The first version of this setup."} value={String(active.version ?? 1)} />
      </dl>
      <div className="bl-actions">
        {compare ? (
          <Link className="btn" href={compare}><Icon name="page" />Compare with the latest backup</Link>
        ) : null}
        <ResnapshotBaseline baselineId={active.id} disabled={!canBaseline} label={setupName(active)} snapshotId={source?.id ?? null} />
        <Link className="btn" href="/baselines/new"><Icon name="plus" />New approved setup</Link>
      </div>
      <p className="bl-help">
        {source
          ? "Capture new version: takes the setup from the newest complete backup. This version is kept, and you can go back to it."
          : "There is no newer complete backup to capture a new version from yet."}
      </p>
    </section>
  );
}

// The three counts on a service card. A service read has no approved setup, so its
// kinds are unchanged since the previous backup, or not read, rather than in line or
// not covered.
const STAT_WORDS: Record<ServiceSummary["basis"], { inLine: string; notCovered: string }> = {
  "approved-setup": { inLine: "In line", notCovered: "Not covered" },
  "previous-backup": { inLine: "Unchanged", notCovered: "Not read" },
};

function serviceNote(summary: ServiceSummary) {
  if (summary.changed) {
    return <>{summary.changed === 1 ? "1 change" : `${summary.changed} changes`} to {kindsWords(summary.changedKinds)}.<span className="bl-go">Review {summary.changed === 1 ? "it" : "them"}<Icon name="chevron" /></span></>;
  }
  if (summary.basis === "previous-backup") {
    return summary.inLine.length
      ? `No change since the previous backup: ${kindsWords(summary.inLine)}.`
      : `The latest backup could not read ${kindsWords(summary.notCovered)}.`;
  }
  return summary.inLine.length
    ? `Matches the approved setup: ${kindsWords(summary.inLine)}.`
    : `Not in the approved setup yet: ${kindsWords(summary.notCovered)}.`;
}

function ServiceCard({ summary }: { summary: ServiceSummary }) {
  const total = summary.inLine.length + summary.changedKinds.length + summary.notCovered.length || 1;
  const words = STAT_WORDS[summary.basis];
  const body = (
    <>
      <div className="bl-service-head">
        <Icon name={summary.service.icon} />
        <span className="bl-service-name"><b>{summary.service.name}</b><small>{summary.service.about}</small></span>
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
  if (!changes || changes.state !== "compared") return changesSentence(changes, { short: true });
  return changes.total === 0 ? "Matches the tenant since" : `${changes.total.toLocaleString("en-GB")} ${changes.total === 1 ? "change" : "changes"} since`;
}

function OtherVersions({ baselines, canBaseline, now }: { baselines: BaselineRecord[]; canBaseline: boolean; now: string }) {
  if (!baselines.length) return null;
  return (
    <section aria-labelledby="bl-versions-heading" className="bl-section">
      <SectionHead about="Setups you approved before, newest first. Using one again needs someone else's approval." id="bl-versions-heading" title="Other approved setups" />
      <ul className="bl-versions">
        {baselines.map((baseline) => {
          const state = versionState(baseline);
          const replaced = Boolean(baseline.supersededById || baseline.supersededAt);
          const captured = baseline.capture?.capturedAt ?? null;
          return (
            <li className="bl-card bl-version" key={baseline.id}>
              <span aria-hidden="true" className="bl-kind-icon"><Icon name="baselines" /></span>
              <div className="bl-version-name">
                <b>{setupName(baseline)}</b>
                <small>Version {baseline.version ?? 1} · {coverageWords(baseline)}</small>
              </div>
              <div className="bl-version-when">
                <time dateTime={captured ?? undefined} title={formatTimestamp(captured)}>{captured ? `Captured ${ago(captured, now)}` : "Capture not recorded"}</time>
                <small>{versionChanges(baseline)}</small>
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
  now,
  sources,
}: {
  baselines: BaselineRecord[];
  // Open changes against the setup in use; null when they could not be read.
  items: Pick<DriftRecord, "resourceType" | "blastRadius">[] | null;
  // Open changes to Exchange, SharePoint and OneDrive, Teams, Purview and Power Platform
  // settings, each compared with the previous backup (lib/service-changes.ts).
  serviceChanges?: Pick<DriftRecord, "resourceType" | "blastRadius" | "serviceRead">[];
  // Those services' kinds on What's protected, and whether the latest backup read them.
  serviceReads?: ServiceReadKind[];
  // Kinds of setting Keel backs up today, to show what the setup does not cover.
  backedUp: string[];
  canBaseline: boolean;
  now: string;
  // Complete backups, newest first: the source for a new version.
  sources: CaptureSource[];
}) {
  const active = baselines.find((baseline) => baseline.active) ?? null;
  const others = baselines.filter((baseline) => baseline !== active);
  const summaries = active ? serviceSummaries(active, [...(items ?? []), ...serviceChanges], backedUp, serviceReads) : [];
  const anyRead = summaries.some((summary) => summary.basis === "previous-backup");
  return (
    <div className="bl-page">
      <BaselinesStyles />
      {active ? (
        <CurrentSetup active={active} canBaseline={canBaseline} latest={sources[0] ?? null} now={now} sources={sources} />
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
                ? "Entra ID and Intune against the approved setup; the other services against the previous backup, since an approved setup cannot hold their settings yet. Services that need a look come first."
                : "Each Microsoft service against the approved setup. Services that need a look come first."}
            id="bl-services-heading"
            title="By service"
          />
          <ul className="bl-services">
            {summaries.map((summary) => <ServiceCard key={summary.service.code} summary={summary} />)}
          </ul>
          <dl className="bl-legend">
            <div><dt data-part="changed">Changed</dt><dd>Kinds of setting that differ from the approved setup. The colour shows the worst risk among them.</dd></div>
            <div><dt data-part="in-line">In line</dt><dd>Matches the approved setup.</dd></div>
            <div><dt data-part="not-covered">Not covered</dt><dd>Keel backs it up, but the approved setup does not hold it yet. Capture a new version to add it.</dd></div>
            {anyRead ? (
              <>
                <div><dt data-part="in-line">Unchanged</dt><dd>Read in the latest backup, with no change since the one before.</dd></div>
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
