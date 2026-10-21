import Link from "next/link";

import { BlastBar } from "@/components/dashboard/blast-bar";
import { CoverageRing } from "@/components/dashboard/coverage-ring";
import { Sparkline } from "@/components/dashboard/sparkline";
import { OverviewVerdict } from "@/components/dashboard/status-hero";
import { PageHeader } from "@/components/page-header";
import { RecordField, RecordGroup, TechnicalDetails } from "@/components/technical-details";
import { ago, displayEnum, formatTimestamp } from "@/lib/presentation";
import type { DashboardData, DashboardWaiting } from "@/lib/types";

export const WAITING_CARDS: { key: keyof DashboardWaiting; href: string; title: string; one: string; many: string; note: string; link: string }[] = [
  { key: "openAlerts", href: "/alerts", title: "Alerts", one: "alert not acknowledged", many: "alerts not acknowledged", note: "Each one needs an owner to acknowledge it.", link: "Open alerts" },
  { key: "openIncidents", href: "/incidents", title: "Incidents", one: "incident open", many: "incidents open", note: "Recovery from each one is still in progress.", link: "Open incidents" },
  { key: "restoreFollowUps", href: "/restore#follow-up", title: "Restore follow-up", one: "step still open", many: "steps still open", note: "Restores left work KEEL cannot do itself, such as new secrets or a service check.", link: "Finish follow-up" },
];

// The Overview's markup, separate from its data loading so the same view renders for
// the live page and for fixtures. pendingApprovals is null when the viewer cannot
// approve (the card is omitted), a number otherwise. Built to the portal experience
// contract: verdict (the memorable number) → explanation (named facts) → record.
export function DashboardView({ data, pendingApprovals }: { data: DashboardData; pendingApprovals: number | null }) {
  const lastBackup = data.lastCompletedCollectionAt;
  const backupState = data.lastCollection?.status === "complete" ? "finished"
    : data.lastCollection ? (data.lastCollection.status === "running" ? "still running" : "did not finish") : null;

  return (
    <>
      <PageHeader
        description="Is this tenant protected right now, and what needs you?"
        generatedAt={data.generatedAt}
        section="Dashboards"
        title="Overview"
      />

      <OverviewVerdict alerts={data.alerts} headline={data.headline} />

      <div data-layer="explanation">
        {data.alerts.length ? (
          <section aria-labelledby="attention-heading" className="attention-section">
            <div className="section-heading-row">
              <h2 id="attention-heading">Needs attention</h2>
              <span className="section-count">{data.alerts.length}</span>
            </div>
            <div className="alert-list">
              {data.alerts.map((alert) => (
                <article className={`alert alert-${alert.severity}`} key={alert.title}>
                  <span className="alert-severity">{displayEnum("severity", alert.severity)}</span>
                  <div>
                    <h3>{alert.title}</h3>
                    <p>{alert.detail}</p>
                  </div>
                </article>
              ))}
            </div>
          </section>
        ) : null}

        <section aria-label="What is behind this" className="dashboard-grid">
          <Link className="dash-card" href="/baselines">
            <header>
              <p className="section-kicker">How the tenant should look</p>
              <h2>Baseline</h2>
            </header>
            {data.activeBaseline ? (
              <>
                <p className="dash-card-title">{data.activeBaseline.label ?? "Unnamed baseline"}</p>
                <p className="dash-card-note">
                  {data.activeBaseline.resourceCount.toLocaleString("en-GB")} resources · set{" "}
                  <time dateTime={data.activeBaseline.setAt ?? undefined} title={formatTimestamp(data.activeBaseline.setAt)}>{ago(data.activeBaseline.setAt, data.generatedAt)}</time>
                  {data.activeBaseline.setByRef?.name ? <> by <span className="wrap-value">{data.activeBaseline.setByRef.name}</span></> : null}
                </p>
              </>
            ) : (
              <p className="dash-card-empty">No baseline is set, so KEEL cannot tell what changed.</p>
            )}
            <span className="dash-card-link">View baselines <span aria-hidden="true">→</span></span>
          </Link>

          <Link className="dash-card" href="/protect">
            <header>
              <p className="section-kicker">Freshness</p>
              <h2>Last backup</h2>
            </header>
            <p className="dash-card-title">
              {lastBackup
                ? <time dateTime={lastBackup} title={formatTimestamp(lastBackup)}>{ago(lastBackup, data.generatedAt).replace(/^./, (c) => c.toUpperCase())}</time>
                : "Never"}
            </p>
            <p className="dash-card-note">
              {backupState ? `The most recent backup ${backupState}.` : "No backup has run yet."}
            </p>
            <span className="dash-card-link">View backups <span aria-hidden="true">→</span></span>
          </Link>

          <Link className="dash-card dash-card-span" href="/drift">
            <header>
              <p className="section-kicker">Since the baseline</p>
              <h2>Open changes</h2>
            </header>
            <div className="dash-drift">
              <p className="dash-metric">
                <strong>{data.openDriftTotal.toLocaleString("en-GB")}</strong>
                <span>{data.openDriftTotal === 1 ? "open change" : "open changes"}</span>
              </p>
              <Sparkline label="Changes found per day" points={data.driftTrend} />
            </div>
            <BlastBar items={data.openDriftByBlastRadius} />
            <span className="dash-card-link">Review changes <span aria-hidden="true">→</span></span>
          </Link>

          <Link className="dash-card" href="/protect">
            <header>
              <p className="section-kicker">What KEEL backs up</p>
              <h2>Configuration types</h2>
            </header>
            <CoverageRing coverage={data.coverage} />
            <p className="dash-card-note">
              {data.coverage.total} configuration types known. A restore counts as proven only after a test restore on this tenant.
            </p>
            <span className="dash-card-link">See every type <span aria-hidden="true">→</span></span>
          </Link>

          {pendingApprovals !== null ? (
            <Link className={`dash-card${pendingApprovals ? " dash-card-attention" : ""}`} href="/approvals">
              <header>
                <p className="section-kicker">Waiting on you</p>
                <h2>Approvals</h2>
              </header>
              <p className="dash-metric">
                <strong>{pendingApprovals}</strong>
                <span>{pendingApprovals === 1 ? "request waiting" : "requests waiting"}</span>
              </p>
              <p className="dash-card-note">
                {pendingApprovals
                  ? "Restores, roll-backs and baseline changes wait for a second person."
                  : "Nothing is waiting for a decision."}
              </p>
              <span className="dash-card-link">Open approvals <span aria-hidden="true">→</span></span>
            </Link>
          ) : null}

          {/* Work outside the approvals inbox that waits on a person; shown only while something waits. */}
          {WAITING_CARDS.filter((card) => (data.waiting?.[card.key] ?? 0) > 0).map((card) => {
            const count = data.waiting![card.key];
            return (
              <Link className="dash-card dash-card-attention" href={card.href} key={card.key}>
                <header>
                  <p className="section-kicker">Waiting on you</p>
                  <h2>{card.title}</h2>
                </header>
                <p className="dash-metric">
                  <strong>{count}</strong>
                  <span>{count === 1 ? card.one : card.many}</span>
                </p>
                <p className="dash-card-note">{card.note}</p>
                <span className="dash-card-link">{card.link} <span aria-hidden="true">→</span></span>
              </Link>
            );
          })}
        </section>
      </div>

      <TechnicalDetails summary="Technical details for this overview">
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
          <RecordField copy={false} label="Total types" value={data.coverage.total} />
        </RecordGroup>
        <RecordGroup title="Audit record">
          <RecordField copy={false} label="Evidence chain" value={data.evidence.ok ? "valid" : "FAILED"} />
          <RecordField copy={false} label="Records in the chain" value={data.evidence.chainLength} />
        </RecordGroup>
      </TechnicalDetails>
    </>
  );
}
