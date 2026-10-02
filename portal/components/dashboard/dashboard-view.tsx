import Link from "next/link";

import { BlastBar } from "@/components/dashboard/blast-bar";
import { CoverageRing } from "@/components/dashboard/coverage-ring";
import { Sparkline } from "@/components/dashboard/sparkline";
import { StatusHero } from "@/components/dashboard/status-hero";
import { PageHeader } from "@/components/page-header";
import { formatAge, formatTimestamp } from "@/lib/presentation";
import type { DashboardData } from "@/lib/types";

// The dashboard's markup, separate from its data loading so the same view renders for
// the live page and for fixtures. pendingApprovals is null when the viewer cannot
// approve (the card is omitted), a number otherwise.
export function DashboardView({ data, pendingApprovals }: { data: DashboardData; pendingApprovals: number | null }) {
  const now = new Date(data.generatedAt);
  const collectionAge = data.lastCompletedCollectionAt
    ? formatAge(data.lastCompletedCollectionAt, now).replace(" old", " ago")
    : "Never";

  return (
    <>
      <PageHeader
        description="Baseline, collection, drift, and coverage posture for the protected tenant."
        eyebrow="Overview"
        generatedAt={data.generatedAt}
        marker="Live read"
        title="Operational state"
      />

      <StatusHero
        alerts={data.alerts}
        facts={[
          { label: "Last collection", value: collectionAge },
          {
            label: "Evidence chain",
            value: data.evidence.ok ? `Valid · ${data.evidence.chainLength.toLocaleString("en-GB")}` : "FAILED",
            tone: data.evidence.ok ? "good" : "bad",
          },
          { label: "Open drift", value: data.openDriftTotal.toLocaleString("en-GB") },
        ]}
      />

      {data.alerts.length ? (
        <section aria-labelledby="attention-heading" className="attention-section">
          <div className="section-heading-row">
            <h2 id="attention-heading">Needs attention</h2>
            <span className="section-count">{data.alerts.length}</span>
          </div>
          <div className="alert-list">
            {data.alerts.map((alert) => (
              <article className={`alert alert-${alert.severity}`} key={alert.title}>
                <span className="alert-severity">{alert.severity}</span>
                <div>
                  <h3>{alert.title}</h3>
                  <p>{alert.detail}</p>
                </div>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      <section aria-label="Posture detail" className="dashboard-grid">
        <Link className="dash-card" href="/baselines">
          <header>
            <p className="section-kicker">Recovery reference</p>
            <h2>Active baseline</h2>
          </header>
          {data.activeBaseline ? (
            <>
              <p className="dash-card-title">{data.activeBaseline.label ?? "Unnamed baseline"}</p>
              <dl className="dash-card-facts">
                <div><dt>Resources</dt><dd>{data.activeBaseline.resourceCount.toLocaleString("en-GB")}</dd></div>
                <div><dt>Set</dt><dd>{formatAge(data.activeBaseline.setAt, now).replace(" old", " ago")}</dd></div>
                <div className="dash-card-wide"><dt>Set by</dt><dd className="wrap-value">{data.activeBaseline.setBy}</dd></div>
              </dl>
            </>
          ) : (
            <p className="dash-card-empty">No baseline is active. Drift cannot be evaluated.</p>
          )}
          <span className="dash-card-link">View baselines <span aria-hidden="true">→</span></span>
        </Link>

        <Link className="dash-card" href="/jobs">
          <header>
            <p className="section-kicker">Freshness</p>
            <h2>Last collection</h2>
          </header>
          <p className="dash-card-title">
            <span className={`collection-status collection-${data.lastCollection?.status ?? "missing"}`}>
              {data.lastCollection?.status ?? "missing"}
            </span>
          </p>
          <dl className="dash-card-facts">
            <div className="dash-card-wide"><dt>Latest snapshot</dt><dd>{formatTimestamp(data.lastCollection?.completedAt ?? null)}</dd></div>
            <div className="dash-card-wide"><dt>Last completed</dt><dd>{formatTimestamp(data.lastCompletedCollectionAt)}</dd></div>
          </dl>
          <span className="dash-card-link">View jobs <span aria-hidden="true">→</span></span>
        </Link>

        <Link className="dash-card dash-card-span" href="/drift">
          <header>
            <p className="section-kicker">Against active baseline</p>
            <h2>Open drift</h2>
          </header>
          <div className="dash-drift">
            <p className="dash-metric">
              <strong>{data.openDriftTotal.toLocaleString("en-GB")}</strong>
              <span>open changes</span>
            </p>
            <Sparkline label="Drift detected per day" points={data.driftTrend} />
          </div>
          <BlastBar items={data.openDriftByBlastRadius} />
          <span className="dash-card-link">Inspect drift <span aria-hidden="true">→</span></span>
        </Link>

        <Link className="dash-card" href="/coverage">
          <header>
            <p className="section-kicker">Catalog honesty</p>
            <h2>Coverage</h2>
          </header>
          <CoverageRing coverage={data.coverage} />
          <p className="dash-card-note">
            {data.coverage.total} catalog types. Coverage is collection status; restore fidelity is
            only called verified after drill evidence.
          </p>
          <span className="dash-card-link">Open coverage report <span aria-hidden="true">→</span></span>
        </Link>

        {pendingApprovals !== null ? (
          <Link className={`dash-card${pendingApprovals ? " dash-card-attention" : ""}`} href="/approvals">
            <header>
              <p className="section-kicker">Waiting on you</p>
              <h2>Approvals</h2>
            </header>
            <p className="dash-metric">
              <strong>{pendingApprovals}</strong>
              <span>{pendingApprovals === 1 ? "pending request" : "pending requests"}</span>
            </p>
            <p className="dash-card-note">
              {pendingApprovals
                ? "Restores, remediations and baseline changes wait for a second operator."
                : "Nothing is waiting for a decision."}
            </p>
            <span className="dash-card-link">Open inbox <span aria-hidden="true">→</span></span>
          </Link>
        ) : null}
      </section>
    </>
  );
}
