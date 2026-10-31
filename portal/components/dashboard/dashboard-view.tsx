import Link from "next/link";

import { ScoreRing } from "@/components/compliance/score-ring";
import { OverviewCharts } from "@/components/dashboard/overview-charts";
import { PageHeader } from "@/components/page-header";
import { Icon } from "@/components/shell/icons";
import { RecordField, RecordGroup, TechnicalDetails } from "@/components/technical-details";
import { Badge } from "@/components/ui/badge";
import { Verdict } from "@/components/verdict";
import {
  attentionRows,
  backupLine,
  overviewStatus,
  overviewTiles,
  overviewVerdict,
  plainWords,
  setupLine,
  TONE_WORDS,
  verdictAction,
  verdictRisk,
} from "@/lib/overview-view";
import { countsFromSummary, scoreFromSummary, scoreSentence } from "@/lib/compliance-view";
import { formatTimestamp } from "@/lib/presentation";
import { setupName } from "@/lib/baselines-view";
import type { ComplianceSummary, DashboardData } from "@/lib/types";

export const OVERVIEW_DESCRIPTION = "Is this tenant protected right now, and what needs you?";

// The Overview (portal audit, one design): title with a status pill, the verdict with
// its one amber action, four count tiles that each open the list behind the number, the
// two chart cards (every legend row a link, each chart opens full screen), then "Needs
// attention" as linked rows that never repeat the verdict, beside the approved setup and
// the last backup. Technical details last and closed. The same view renders for the live
// page and for fixtures; pendingApprovals is null when the viewer cannot approve.
export function DashboardView({ data, pendingApprovals }: { data: DashboardData; pendingApprovals: number | null }) {
  const verdict = overviewVerdict(data.headline, data.alerts);
  const tiles = overviewTiles(data, pendingApprovals);
  const rows = attentionRows(data, pendingApprovals);
  const backup = backupLine(data);

  return (
    <>
      <PageHeader
        description={OVERVIEW_DESCRIPTION}
        generatedAt={data.generatedAt}
        section="Dashboards"
        status={overviewStatus(verdict.tone)}
        title="Overview"
      />

      <div className="ov-page">
        <Verdict action={verdictAction(data.headline)} headline={verdict.headline} text={plainWords(verdict.sentence)} tone={verdictRisk(verdict.tone)} />

        <div className="ov-body" data-layer="explanation">
          <section aria-label="At a glance" className="ov-tiles" style={{ ["--ov-tiles" as string]: tiles.length }}>
            {tiles.map((tile) => (
              <Link className="ov-tile" data-tile={tile.key} data-tone={tile.tone} href={tile.href} key={tile.key}>
                <span className="ov-tile-label"><Icon name={tile.icon} />{tile.label}</span>
                <b className="ov-tile-count">{tile.value}</b>
                <small>{tile.detail}</small>
                {tile.meter ? (
                  <span aria-hidden="true" className="ov-meter">
                    {tile.meter.filter((part) => part.share > 0).map((part, index) => <i data-tone={part.tone} key={index} style={{ width: `${Math.min(100, part.share * 100)}%` }} />)}
                  </span>
                ) : null}
              </Link>
            ))}
          </section>

          <OverviewCharts data={data} />

          <div className="ov-low">
            <section aria-labelledby="ov-attention-heading" className="ov-attention">
              <h2 id="ov-attention-heading">Needs attention</h2>
              {rows.length ? (
                <ul className="ov-rows">
                  {rows.map((row) => (
                    <li key={row.key}>
                      <Link className="ov-row" data-tone={row.tone} href={row.href}>
                        <span aria-hidden="true" className="ov-kind" data-tone={row.tone}><Icon name={row.icon} /></span>
                        <span className="ov-row-name"><b>{row.title}</b><small>{row.detail}</small></span>
                        <Badge tone={row.tone}>{TONE_WORDS[row.tone]}</Badge>
                        <Icon name="chevron" />
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="ov-calm"><Icon name="check-circle" />Nothing else needs you right now.</p>
              )}
            </section>

            <div className="ov-side">
              <Link className="ov-side-card" href="/baselines">
                <span className="ov-tile-label"><Icon name="baselines" />Approved setup</span>
                {data.activeBaseline ? (
                  <>
                    <b className="ov-side-title">{setupName(data.activeBaseline)}</b>
                    <small>{setupLine(data.activeBaseline, data.generatedAt)}</small>
                  </>
                ) : (
                  <>
                    <b className="ov-side-title">None yet</b>
                    <small>Approve a setup so Keel can tell what changed.</small>
                  </>
                )}
              </Link>
              {data.compliance ? <ComplianceCard summary={data.compliance} /> : null}
              <Link className="ov-side-card" href="/protect">
                <span className="ov-tile-label"><Icon name="clock" />Last backup</span>
                <b className="ov-side-title">
                  {data.lastCompletedCollectionAt
                    ? <time dateTime={data.lastCompletedCollectionAt} title={formatTimestamp(data.lastCompletedCollectionAt)}>{backup.when}</time>
                    : backup.when}
                </b>
                <small>{backup.state ? <Badge tone={backup.state.tone}>{backup.state.label}</Badge> : "No backup has run yet."}</small>
              </Link>
            </div>
          </div>
        </div>
      </div>

      <TechnicalDetails summary="Technical details">
        <RecordGroup title="What this overview reads">
          <RecordField copy={false} label="Checked" value="active baseline, latest collection, coverage report per catalog type, evidence chain integrity, fidelity-drill evidence" />
          <RecordField copy={false} label="Not checked" value="live restorability of types without fidelity-drill evidence; content (KEEL backs up configuration only)" />
          <RecordField copy={false} label="Read at" value={data.generatedAt} />
        </RecordGroup>
        <RecordGroup note={data.headline.state} title="Headline">
          <RecordField copy={false} label="State" value={data.headline.state} />
          <RecordField copy={false} label="Backed up" value={data.headline.counts.backedUp} />
          <RecordField copy={false} label="Restorable" value={data.headline.counts.restorable} />
          <RecordField copy={false} label="Failing" usage="failed + stale + never collected" value={data.headline.counts.failing} />
          <RecordField copy={false} label="Failed" value={data.headline.counts.failed} />
          <RecordField copy={false} label="Stale" value={data.headline.counts.stale} />
          <RecordField copy={false} label="Never collected" value={data.headline.counts.neverCollected} />
          <RecordField copy={false} label="Last fidelity drill" value={data.headline.lastProvenRestoreAt} />
          <RecordField copy={false} label="Engine sentence" value={data.headline.sentence} />
        </RecordGroup>
        <RecordGroup title="Snapshots">
          <RecordField copy={false} label="Latest snapshot status" value={data.lastCollection?.status ?? "missing"} />
          <RecordField copy={false} label="Latest snapshot completed" value={data.lastCollection?.completedAt ?? "never"} />
          <RecordField copy={false} label="Last completed snapshot" value={data.lastCompletedCollectionAt} />
        </RecordGroup>
        {data.activeBaseline ? (
          <RecordGroup note="approved setup" title={data.activeBaseline.label ?? "Active baseline"}>
            <RecordField label="Active baseline ID" usage={<>use with <code>GET /api/baselines</code></>} value={data.activeBaseline.id} />
            <RecordField copy={false} label="Set at" value={data.activeBaseline.setAt} />
            <RecordField label="Set by (account ID)" usage={data.activeBaseline.setByRef?.name ?? undefined} value={data.activeBaseline.setBy} />
            <RecordField copy={false} label="Settings captured" value={data.activeBaseline.resourceCount} />
          </RecordGroup>
        ) : null}
        <RecordGroup title="Open changes">
          <RecordField copy={false} label="Open changes" value={data.openDriftTotal} />
          {data.openDriftByBlastRadius.map((row) => <RecordField copy={false} key={row.blastRadius} label={`Reach: ${row.blastRadius}`} value={row.count} />)}
        </RecordGroup>
        <RecordGroup title="Coverage">
          <RecordField copy={false} label="Covered" value={data.coverage.covered} />
          <RecordField copy={false} label="Failed" value={data.coverage.failed} />
          <RecordField copy={false} label="Stale" value={data.coverage.stale} />
          <RecordField copy={false} label="Not covered" value={data.coverage.notCovered} />
          <RecordField copy={false} label="Never collected" value={data.coverage.neverCollected} />
          <RecordField copy={false} label="Unavailable" value={data.coverage.unavailable} />
          <RecordField copy={false} label="Total types" usage="sum of the six buckets above" value={data.coverage.total} />
        </RecordGroup>
        <RecordGroup title="Audit record">
          <RecordField copy={false} label="Evidence chain" value={data.evidence.ok ? "valid" : "FAILED"} />
          <RecordField copy={false} label="Records in the chain" value={data.evidence.chainLength} />
        </RecordGroup>
      </TechnicalDetails>
    </>
  );
}

/** The compliance score beside the approved setup: a ring, "3 of 4 pass", and what
 * needs a hand first (fails, then settings not set up yet). Opens Compliance. */
function ComplianceCard({ summary }: { summary: ComplianceSummary }) {
  const score = scoreFromSummary(summary);
  const counts = countsFromSummary(summary);
  const todo = counts.failing
    ? <Badge tone="urgent">{counts.failing} failing</Badge>
    : counts["not-set-up"]
      ? <Badge tone="soon">{counts["not-set-up"]} not set up yet</Badge>
      : null;
  const href = counts.failing ? "/benchmarks?result=failing" : counts["not-set-up"] ? "/benchmarks?result=not-set-up" : "/benchmarks";
  return (
    <Link className="ov-side-card ov-score-card" href={href}>
      <span className="ov-tile-label"><Icon name="check-circle" />Compliance score</span>
      <span className="ov-score">
        <ScoreRing label="Compliance" score={score} size="md" />
        <span>
          <b className="ov-side-title">{score.percent === null ? "Not checked yet" : `${score.percent}% pass`}</b>
          <small>{score.percent === null ? "Keel checks after each backup." : scoreSentence(score)}</small>
          {todo}
        </span>
      </span>
    </Link>
  );
}
