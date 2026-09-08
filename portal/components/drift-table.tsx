"use client";

import { useMemo, useState } from "react";

import { BlastBadge, ChangeBadge } from "@/components/status-badge";
import { BLAST_RADIUS_ORDER, formatTimestamp, words } from "@/lib/presentation";
import type { DriftRecord } from "@/lib/types";

type SortKey = "naturalKey" | "resourceType" | "changeType" | "blastRadius" | "detectedAt";
type Direction = "ascending" | "descending";

function compare(a: DriftRecord, b: DriftRecord, key: SortKey): number {
  if (key === "blastRadius") {
    const aRank = BLAST_RADIUS_ORDER.indexOf(a.blastRadius);
    const bRank = BLAST_RADIUS_ORDER.indexOf(b.blastRadius);
    return (aRank < 0 ? 99 : aRank) - (bRank < 0 ? 99 : bRank);
  }
  return a[key].localeCompare(b[key]);
}

export function DriftTable({ items }: { items: DriftRecord[] }) {
  const [query, setQuery] = useState("");
  const [resourceType, setResourceType] = useState("all");
  const [changeType, setChangeType] = useState("all");
  const [blastRadius, setBlastRadius] = useState("all");
  const [sort, setSort] = useState<{ key: SortKey; direction: Direction }>({
    key: "detectedAt",
    direction: "descending",
  });

  const resourceTypes = useMemo(
    () => [...new Set(items.map((item) => item.resourceType))].sort(),
    [items],
  );
  const blastRadii = useMemo(
    () =>
      [...new Set(items.map((item) => item.blastRadius))].sort(
        (a, b) => BLAST_RADIUS_ORDER.indexOf(a) - BLAST_RADIUS_ORDER.indexOf(b),
      ),
    [items],
  );

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return items
      .filter(
        (item) =>
          (resourceType === "all" || item.resourceType === resourceType) &&
          (changeType === "all" || item.changeType === changeType) &&
          (blastRadius === "all" || item.blastRadius === blastRadius) &&
          (!needle ||
            item.naturalKey.toLowerCase().includes(needle) ||
            item.resourceType.toLowerCase().includes(needle)),
      )
      .sort((a, b) => {
        const result = compare(a, b, sort.key);
        return sort.direction === "ascending" ? result : -result;
      });
  }, [items, query, resourceType, changeType, blastRadius, sort]);

  function changeSort(key: SortKey) {
    setSort((current) => ({
      key,
      direction:
        current.key === key && current.direction === "ascending"
          ? "descending"
          : "ascending",
    }));
  }

  function heading(label: string, key: SortKey) {
    const active = sort.key === key;
    return (
      <button className="sort-button" onClick={() => changeSort(key)} type="button">
        {label}
        <span aria-hidden="true" className={active ? "sort-active" : "sort-idle"}>
          {active ? (sort.direction === "ascending" ? "↑" : "↓") : "↕"}
        </span>
      </button>
    );
  }

  return (
    <section aria-labelledby="open-drift-heading" className="report-section">
      <div className="section-heading-row report-heading">
        <div>
          <p className="section-kicker">Unresolved change</p>
          <h2 id="open-drift-heading">Open drift</h2>
        </div>
        <span aria-live="polite" className="result-count">
          {visible.length} of {items.length}
        </span>
      </div>

      <div className="filter-bar drift-filters">
        <label className="filter-field search-field">
          <span>Find natural key</span>
          <input
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search key or type"
            type="search"
            value={query}
          />
        </label>
        <label className="filter-field">
          <span>Resource type</span>
          <select onChange={(event) => setResourceType(event.target.value)} value={resourceType}>
            <option value="all">All resource types</option>
            {resourceTypes.map((type) => (
              <option key={type} value={type}>{type}</option>
            ))}
          </select>
        </label>
        <label className="filter-field">
          <span>Change</span>
          <select onChange={(event) => setChangeType(event.target.value)} value={changeType}>
            <option value="all">All changes</option>
            <option value="added">Added</option>
            <option value="modified">Modified</option>
            <option value="removed">Removed</option>
          </select>
        </label>
        <label className="filter-field">
          <span>Blast radius</span>
          <select onChange={(event) => setBlastRadius(event.target.value)} value={blastRadius}>
            <option value="all">All blast radii</option>
            {blastRadii.map((radius) => (
              <option key={radius} value={radius}>{words(radius)}</option>
            ))}
          </select>
        </label>
        <label className="filter-field mobile-sort-field">
          <span>Sort</span>
          <select
            onChange={(event) => {
              const [key, direction] = event.target.value.split(":") as [SortKey, Direction];
              setSort({ key, direction });
            }}
            value={`${sort.key}:${sort.direction}`}
          >
            <option value="detectedAt:descending">Detected · newest</option>
            <option value="detectedAt:ascending">Detected · oldest</option>
            <option value="blastRadius:ascending">Blast radius · highest first</option>
            <option value="naturalKey:ascending">Natural key · A–Z</option>
            <option value="resourceType:ascending">Resource type · A–Z</option>
            <option value="changeType:ascending">Change type · A–Z</option>
          </select>
        </label>
      </div>

      {visible.length ? (
        <div className="table-scroll">
          <table className="data-table drift-table">
            <thead>
              <tr>
                <th aria-sort={sort.key === "naturalKey" ? sort.direction : "none"} scope="col">
                  {heading("Natural key", "naturalKey")}
                </th>
                <th aria-sort={sort.key === "resourceType" ? sort.direction : "none"} scope="col">
                  {heading("Resource type", "resourceType")}
                </th>
                <th aria-sort={sort.key === "changeType" ? sort.direction : "none"} scope="col">
                  {heading("Change", "changeType")}
                </th>
                <th aria-sort={sort.key === "blastRadius" ? sort.direction : "none"} scope="col">
                  {heading("Blast radius", "blastRadius")}
                </th>
                <th aria-sort={sort.key === "detectedAt" ? sort.direction : "none"} scope="col">
                  {heading("Detected", "detectedAt")}
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((item) => (
                <tr key={item.id}>
                  <th data-label="Natural key" scope="row">
                    <code className="natural-key">{item.naturalKey}</code>
                  </th>
                  <td data-label="Resource type">
                    <span className="resource-type">{item.resourceType}</span>
                  </td>
                  <td data-label="Change"><ChangeBadge value={item.changeType} /></td>
                  <td data-label="Blast radius"><BlastBadge value={item.blastRadius} /></td>
                  <td data-label="Detected">
                    <time dateTime={item.detectedAt}>{formatTimestamp(item.detectedAt)}</time>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="empty-state">
          {items.length
            ? "No open drift matches these filters."
            : "No open drift is recorded against this baseline."}
        </p>
      )}
    </section>
  );
}
