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
            <th scope="col">Last collection</th>
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
                  <small className="cell-note">Descriptor exists; never collected</small>
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
              <td data-label="Last collection">
                <time dateTime={item.lastCollectedAt ?? undefined}>
                  {formatTimestamp(item.lastCollectedAt)}
                </time>
              </td>
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
