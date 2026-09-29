"use client";

import { useMemo, useState } from "react";

import { BlastBadge, ProtectionBadge, StateBadge } from "@/components/status-badge";
import {
  PROTECTION_STATE_LABEL,
  PROTECTION_STATE_ORDER,
  adapterSurface,
  formatTimestamp,
  words,
} from "@/lib/presentation";
import type { CoverageData, CoverageType, ProtectionState } from "@/lib/types";

function fidelityDetail(item: CoverageType) {
  if (!item.fidelity.declared) {
    return (
      <span className="muted-value">No collecting descriptor</span>
    );
  }

  return (
    <span className="fidelity-detail">
      <strong>Declared {words(item.fidelity.declared).toLowerCase()}</strong>
      {item.fidelity.measured ? (
        <small>
          Drill measured {words(item.fidelity.measured).toLowerCase()} ·{" "}
          {formatTimestamp(item.fidelity.verifiedAt)}
        </small>
      ) : (
        <small className="unverified-copy">Not drill-verified</small>
      )}
    </span>
  );
}

// Roadmap task-54: a per-type expandable capability matrix. A native
// <details> disclosure keeps the main table scannable while still rendering
// every required evidence dimension — endpoint/version, pagination, the
// prerequisite diagnosis, operation-specific write status, the honestly-
// unknown relationship completeness, irrecoverable fields and the linked
// observation — so a "full" fidelity badge in the row above is never the
// only thing a reader sees. <details>/<summary> is native keyboard- and
// narrow-screen-accessible without any additional script.
function observationQuery(item: CoverageType) {
  const observation = item.observation;
  return new URLSearchParams({
    observationId: observation?.observationId ?? "",
    resourceType: item.type,
    startedAt: observation?.window?.startedAt ?? "",
    endedAt: observation?.window?.endedAt ?? "",
  }).toString();
}

function capabilityMatrix(item: CoverageType) {
  const irrecoverable = item.irrecoverableFields ?? null;
  const summaryLabel = irrecoverable && irrecoverable.length > 0
    ? `${irrecoverable.length} field${irrecoverable.length === 1 ? "" : "s"} not write-recoverable`
    : "Capability & evidence";

  return (
    <details className="capability-matrix">
      <summary>{summaryLabel} · Relationships {item.relationshipCompleteness ?? "unknown"}</summary>
      <dl className="capability-detail-list">
        <div className="capability-row">
          <dt>Endpoint</dt>
          <dd>
            {item.declaredEndpoint ? (
              <span className="endpoint-detail">
                <code>{item.declaredEndpoint.path}</code>
                <small>{item.declaredEndpoint.apiVersion} · declared</small>
              </span>
            ) : (
              <span className="muted-value">Unknown</span>
            )}
            {item.detail?.endpoint ? (
              <span className="endpoint-detail">
                <code>{item.detail.endpoint}</code>
                <small>
                  {item.detail.apiVersion ?? "unknown version"} · measured
                </small>
              </span>
            ) : null}
          </dd>
        </div>

        <div className="capability-row">
          <dt>Pagination evidence</dt>
          <dd>
            {item.detail?.pagesCompleted === null || item.detail?.pagesCompleted === undefined ? (
              <span className="muted-value">Unknown</span>
            ) : (
              <span>
                {item.detail.pagesCompleted.toLocaleString("en-GB")} page
                {item.detail.pagesCompleted === 1 ? "" : "s"} completed
              </span>
            )}
          </dd>
        </div>

        <div className="capability-row">
          <dt>Prerequisite diagnosis</dt>
          <dd>
            {item.diagnosis ? (
              <span className={`diagnosis-badge diagnosis-${item.diagnosis.diagnosis}`}>
                {words(item.diagnosis.diagnosis)}
              </span>
            ) : (
              <span className="muted-value">Not diagnosed</span>
            )}
          </dd>
        </div>

        <div className="capability-row">
          <dt>Relationship completeness</dt>
          <dd>
            <span className="muted-value">{words(item.relationshipCompleteness ?? "unknown")}</span>
            <small className="cell-note">No relationship/edge collection exists yet</small>
          </dd>
        </div>

        <div className="capability-row">
          <dt>Irrecoverable fields</dt>
          <dd>
            {irrecoverable === null ? (
              <span className="muted-value">Unknown</span>
            ) : irrecoverable.length === 0 ? (
              <span className="muted-value">None declared</span>
            ) : (
              <span className="field-list">
                {irrecoverable.map((field) => (
                  <code key={field}>{field}</code>
                ))}
              </span>
            )}
          </dd>
        </div>

        <div className="capability-row">
          <dt>Write capability by operation</dt>
          <dd>
            {item.writeCapability ? (
              <ul className="operation-claims">
                {Object.entries(item.writeCapability.operations).map(([operation, capability]) => (
                  <li key={operation}>
                    <strong>{words(operation)}</strong>
                    <span className={`claim-badge claim-${capability.claim}`}>
                      {words(capability.claim)}
                    </span>
                    <small>Projection review: {capability.projection}</small>
                    <small>Proof: <code>{capability.proofRef ?? "Unknown"}</code></small>
                    <small>Credential mode: {capability.credentialMode ?? "Unknown"}</small>
                  </li>
                ))}
              </ul>
            ) : (
              <span className="muted-value">Unknown</span>
            )}
          </dd>
        </div>

        <div className="capability-row">
          <dt>Observation</dt>
          <dd>
            {item.observation ? (
              <span className="observation-detail">
                <code>{item.observation.observationId}</code>
                {item.observation.window ? (
                  <small>
                    {formatTimestamp(item.observation.window.startedAt)} –{" "}
                    {formatTimestamp(item.observation.window.endedAt)}
                  </small>
                ) : (
                  <small className="unverified-copy">Window unknown</small>
                )}
                <small>Completeness: {item.observation.completeness} · Evidence: {item.observation.evidenceLevel}</small>
                <small>Benchmark comparison unavailable until a benchmark view records a matching observation.</small>
                <nav aria-label={`Linked views for ${item.type}`} className="observation-links">
                  <a href={`/backups?${observationQuery(item)}`}>Backups</a>
                  <a href={`/drift?${observationQuery(item)}`}>Drift</a>
                </nav>
              </span>
            ) : (
              <span className="muted-value">No observation recorded</span>
            )}
          </dd>
        </div>
      </dl>
    </details>
  );
}

function CoverageTable({ items }: { items: CoverageType[] }) {
  return (
    <div className="table-scroll">
      <table className="data-table coverage-table">
        <thead>
          <tr>
            <th scope="col">Resource type</th>
            <th scope="col">Protection state</th>
            <th scope="col">Fidelity evidence</th>
            <th scope="col">Serving adapter</th>
            <th scope="col">Criticality</th>
            <th scope="col">Blast radius</th>
            <th scope="col">Remappable</th>
            <th className="number-column" scope="col">Items</th>
            <th scope="col">Collection freshness</th>
            <th scope="col">Last collection</th>
            <th scope="col">Capability & evidence</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.type}>
              <th data-label="Resource type" scope="row">
                <span className="resource-type">{item.type}</span>
              </th>
              <td data-label="Protection state">
                <ProtectionBadge item={item} />
                {item.reportStatus === "never-collected" ? (
                  <small className="cell-note">
                    {item.outcome === "not-requested"
                      ? "Not requested in the latest run"
                      : "Descriptor exists; never collected"}
                  </small>
                ) : null}
                {item.outcome === "partial" ? (
                  <small className="cell-note">
                    Partial read{item.detail?.graphCode ? ` · ${item.detail.graphCode}` : ""}
                    {item.itemCount !== null ? ` · ${item.itemCount.toLocaleString("en-GB")} items seen` : ""}
                    {" — completeness failed"}
                  </small>
                ) : null}
              </td>
              <td data-label="Fidelity evidence">{fidelityDetail(item)}</td>
              <td data-label="Serving adapter">
                {item.adapter ? (
                  <span className="adapter-detail">
                    <strong>{adapterSurface(item.adapter)}</strong>
                    <code>{item.adapter}</code>
                  </span>
                ) : (
                  <span className="muted-value">None registered</span>
                )}
              </td>
              <td data-label="Criticality">
                {item.criticality ? (
                  <span className={`tier-label ${item.criticality}`}>
                    {words(item.criticality)}
                  </span>
                ) : (
                  <span className="muted-value">Unknown</span>
                )}
              </td>
              <td data-label="Blast radius">
                {item.blastRadius ? (
                  <BlastBadge value={item.blastRadius} />
                ) : (
                  <span className="muted-value">Unknown</span>
                )}
              </td>
              <td data-label="Remappable">
                <span className={`boolean-value value-${String(item.remappable)}`}>
                  {item.remappable === null ? "Unknown" : item.remappable ? "Yes" : "No"}
                </span>
              </td>
              <td className="number-column" data-label="Items">
                {item.itemCount === null ? "—" : item.itemCount.toLocaleString("en-GB")}
              </td>
              <td data-label="Collection freshness">
                {item.stale ? (
                  <span className="staleness-detail">
                    <span className="stale-badge">Stale</span>
                    <small>Last collected {formatTimestamp(item.lastCollectedAt)}</small>
                  </span>
                ) : (
                  <span className="freshness-detail">Fresh</span>
                )}
              </td>
              <td data-label="Last collection">
                <time dateTime={item.lastCollectedAt ?? undefined}>
                  {formatTimestamp(item.lastCollectedAt)}
                </time>
              </td>
              <td data-label="Capability & evidence">{capabilityMatrix(item)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function CoverageReport({ data }: { data: CoverageData }) {
  const [query, setQuery] = useState("");
  const [state, setState] = useState<ProtectionState | "all">("all");
  const [tier, setTier] = useState("all");

  const stateCounts = useMemo(
    () =>
      Object.fromEntries(
        PROTECTION_STATE_ORDER.map((candidate) => [
          candidate,
          data.types.filter((item) => item.protectionState === candidate).length,
        ]),
      ) as Record<ProtectionState, number>,
    [data.types],
  );

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return data.types.filter(
      (item) =>
        (state === "all" || item.protectionState === state) &&
        (tier === "all" || item.criticality === tier) &&
        (!needle ||
          item.type.toLowerCase().includes(needle) ||
          item.adapter?.toLowerCase().includes(needle)),
    );
  }, [data.types, query, state, tier]);

  const grouped = PROTECTION_STATE_ORDER.map((candidate) => ({
    state: candidate,
    items: filtered
      .filter((item) => item.protectionState === candidate)
      .sort((a, b) => {
        const tierComparison = (a.criticality ?? "tier9").localeCompare(
          b.criticality ?? "tier9",
        );
        return tierComparison || a.type.localeCompare(b.type);
      }),
  })).filter((group) => group.items.length > 0);

  return (
    <>
      {new Set(data.types.flatMap((item) => item.observation?.window
        ? [`${item.observation.window.startedAt}/${item.observation.window.endedAt}`] : [])).size > 1 ? (
        <aside className="honesty-note" aria-label="Observation mismatch">
          <strong>Observation windows differ.</strong>
          <p>These observations are not simultaneous. Compare the observation IDs and windows before linking evidence across views.</p>
        </aside>
      ) : null}
      <section aria-labelledby="posture-heading" className="posture-section">
        <div className="section-heading-row">
          <div>
            <p className="section-kicker">Protection shape</p>
            <h2 id="posture-heading">All catalog states</h2>
          </div>
          <span className="result-count">{data.summary.total} types</span>
        </div>
        <div className="state-selector" aria-label="Filter by protection state">
          {PROTECTION_STATE_ORDER.map((candidate) => (
            <button
              aria-pressed={state === candidate}
              className="state-count"
              key={candidate}
              onClick={() => setState(state === candidate ? "all" : candidate)}
              type="button"
            >
              <StateBadge state={candidate} />
              <strong>{stateCounts[candidate]}</strong>
            </button>
          ))}
        </div>
      </section>

      <section aria-labelledby="coverage-report-heading" className="report-section">
        <div className="section-heading-row report-heading">
          <div>
            <p className="section-kicker">Per resource type</p>
            <h2 id="coverage-report-heading">Coverage report</h2>
          </div>
          <span className="result-count">
            {filtered.length} of {data.types.length}
          </span>
        </div>

        <div className="filter-bar">
          <label className="filter-field search-field">
            <span>Find type or adapter</span>
            <input
              onChange={(event) => setQuery(event.target.value)}
              placeholder="e.g. conditionalAccessPolicy"
              type="search"
              value={query}
            />
          </label>
          <label className="filter-field">
            <span>Protection state</span>
            <select
              onChange={(event) => setState(event.target.value as ProtectionState | "all")}
              value={state}
            >
              <option value="all">All states</option>
              {PROTECTION_STATE_ORDER.map((candidate) => (
                <option key={candidate} value={candidate}>
                  {PROTECTION_STATE_LABEL[candidate]}
                </option>
              ))}
            </select>
          </label>
          <label className="filter-field">
            <span>Criticality</span>
            <select onChange={(event) => setTier(event.target.value)} value={tier}>
              <option value="all">All tiers</option>
              <option value="tier1">Tier 1</option>
              <option value="tier2">Tier 2</option>
              <option value="tier3">Tier 3</option>
            </select>
          </label>
        </div>

        {grouped.length ? (
          <div className="coverage-groups">
            {grouped.map((group) => (
              <section
                aria-labelledby={`coverage-${group.state}`}
                className={`coverage-group group-${group.state}`}
                key={group.state}
              >
                <header className="group-header">
                  <h3 id={`coverage-${group.state}`}>
                    <StateBadge state={group.state} />
                  </h3>
                  <span>{group.items.length} types</span>
                </header>
                <CoverageTable items={group.items} />
              </section>
            ))}
          </div>
        ) : (
          <p className="empty-state">No catalog types match these filters.</p>
        )}
      </section>
    </>
  );
}
