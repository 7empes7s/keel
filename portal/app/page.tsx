import Link from "next/link";
import { connection } from "next/server";

import { DataUnavailable } from "@/components/data-unavailable";
import { PageHeader } from "@/components/page-header";
import { BlastBadge } from "@/components/status-badge";
import { formatAge, formatTimestamp, words } from "@/lib/presentation";
import { getDashboardData } from "@/lib/portal-data";
import type { DashboardData } from "@/lib/types";

export default async function Home() {
  await connection();

  let data: DashboardData;
  try {
    data = await getDashboardData();
  } catch {
    return (
      <>
        <PageHeader
          description="Baseline, collection, drift, and coverage posture for the protected tenant."
          eyebrow="Overview"
          marker="Live read"
          title="Operational state"
        />
        <DataUnavailable surface="Dashboard data" />
      </>
    );
  }

  const now = new Date(data.generatedAt);
  const uncovered = data.coverage.notCovered + data.coverage.neverCollected;

  return (
    <>
      <PageHeader
        description="Baseline, collection, drift, and coverage posture for the protected tenant."
        eyebrow="Overview"
        generatedAt={data.generatedAt}
        marker="Live read"
        title="Operational state"
      />

      <section aria-labelledby="attention-heading" className="attention-section">
        <div className="section-heading-row">
          <h2 id="attention-heading">Needs attention</h2>
          <span className="section-count">{data.alerts.length}</span>
        </div>
        {data.alerts.length ? (
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
        ) : (
          <p className="healthy-line">
            <span aria-hidden="true">✓</span> No obviously wrong state detected.
          </p>
        )}
      </section>

      <section aria-labelledby="baseline-heading" className="dashboard-section">
        <div className="section-heading-row">
          <div>
            <p className="section-kicker">Recovery reference</p>
            <h2 id="baseline-heading">Active baseline</h2>
          </div>
          <Link className="text-link" href="/baselines">
            View all baselines <span aria-hidden="true">→</span>
          </Link>
        </div>
        {data.activeBaseline ? (
          <div className="baseline-summary">
            <div className="baseline-name">
              <span className="active-indicator">Active</span>
              <strong>{data.activeBaseline.label ?? "Unnamed baseline"}</strong>
              <span>{formatAge(data.activeBaseline.setAt, now)}</span>
            </div>
            <dl className="metric-line">
              <div>
                <dt>Resources</dt>
                <dd>{data.activeBaseline.resourceCount.toLocaleString("en-GB")}</dd>
              </div>
              <div>
                <dt>Set at</dt>
                <dd>{formatTimestamp(data.activeBaseline.setAt)}</dd>
              </div>
              <div>
                <dt>Set by</dt>
                <dd className="wrap-value">{data.activeBaseline.setBy}</dd>
              </div>
            </dl>
          </div>
        ) : (
          <p className="empty-state">No baseline is active.</p>
        )}
      </section>

      <div className="dashboard-columns">
        <section aria-labelledby="collection-heading" className="dashboard-section">
          <div className="section-heading-row">
            <div>
              <p className="section-kicker">Freshness</p>
              <h2 id="collection-heading">Last collection</h2>
            </div>
            <span
              className={`collection-status collection-${data.lastCollection?.status ?? "missing"}`}
            >
              {data.lastCollection?.status ?? "missing"}
            </span>
          </div>
          <dl className="stacked-facts">
            <div>
              <dt>Latest snapshot completion</dt>
              <dd>{formatTimestamp(data.lastCollection?.completedAt ?? null)}</dd>
            </div>
            <div>
              <dt>Last completed collection</dt>
              <dd>{formatTimestamp(data.lastCompletedCollectionAt)}</dd>
            </div>
            <div>
              <dt>Evidence chain</dt>
              <dd>
                {data.evidence.ok ? "Valid" : "FAILED"} · {data.evidence.chainLength.toLocaleString("en-GB")} records
              </dd>
            </div>
          </dl>
        </section>

        <section aria-labelledby="drift-heading" className="dashboard-section">
          <div className="section-heading-row">
            <div>
              <p className="section-kicker">Against active baseline</p>
              <h2 id="drift-heading">Open drift</h2>
            </div>
            <Link className="text-link" href="/drift">
              Inspect drift <span aria-hidden="true">→</span>
            </Link>
          </div>
          <p className="dominant-metric">
            <strong>{data.openDriftTotal.toLocaleString("en-GB")}</strong>
            <span>open changes</span>
          </p>
          <dl className="drift-breakdown">
            {data.openDriftByBlastRadius.map((item) => (
              <div key={item.blastRadius}>
                <dt>
                  <BlastBadge value={item.blastRadius} />
                </dt>
                <dd>{item.count.toLocaleString("en-GB")}</dd>
              </div>
            ))}
          </dl>
        </section>
      </div>

      <section aria-labelledby="coverage-heading" className="dashboard-section coverage-summary">
        <div className="section-heading-row">
          <div>
            <p className="section-kicker">Catalog honesty</p>
            <h2 id="coverage-heading">Coverage summary</h2>
          </div>
          <Link className="text-link" href="/coverage">
            Open coverage report <span aria-hidden="true">→</span>
          </Link>
        </div>
        <dl className="coverage-totals">
          <div className="total-covered">
            <dt>Covered</dt>
            <dd>{data.coverage.covered}</dd>
            <small>Non-zero last collection</small>
          </div>
          <div className="total-failed">
            <dt>Failed</dt>
            <dd>{data.coverage.failed}</dd>
            <small>Zero items returned</small>
          </div>
          <div className="total-uncovered">
            <dt>Not covered</dt>
            <dd>{uncovered}</dd>
            <small>Known catalog gaps</small>
          </div>
        </dl>
        <div
          aria-label={`${data.coverage.covered} covered, ${data.coverage.failed} failed, ${uncovered} not covered out of ${data.coverage.total} types`}
          className="coverage-bar"
          role="img"
        >
          <span
            className="bar-covered"
            style={{ width: `${(data.coverage.covered / data.coverage.total) * 100}%` }}
          />
          <span
            className="bar-failed"
            style={{ width: `${(data.coverage.failed / data.coverage.total) * 100}%` }}
          />
          <span className="bar-uncovered" />
        </div>
        <p className="coverage-caption">
          {data.coverage.total} catalog types enumerated. Coverage is collection status;
          restore fidelity is declared separately and only called verified after drill evidence.
        </p>
      </section>
    </>
  );
}
