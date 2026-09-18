"use client";

import { useMemo, useState } from "react";

import { BlastBadge, ChangeBadge } from "@/components/status-badge";
import { driftActionControls, remediationParams } from "@/lib/drift-actions";
import { BLAST_RADIUS_ORDER, formatTimestamp, words } from "@/lib/presentation";
import type { DriftRecord } from "@/lib/types";

type SortKey = "naturalKey" | "resourceType" | "changeType" | "blastRadius" | "detectedAt";
type Direction = "ascending" | "descending";

interface RemediationPreview {
  driftIds: string[];
  resources: { naturalKey: string; resourceType: string; verb: string; verbReason: string }[];
  waves: string[][];
  deletionWaves: string[][];
  patches: { naturalKey: string; field: string; symbol: string }[];
  guardRefusals: { naturalKey: string; reason: string }[];
}

const PAGE_SIZE = 25;

function compare(a: DriftRecord, b: DriftRecord, key: SortKey): number {
  if (key === "blastRadius") {
    const aRank = BLAST_RADIUS_ORDER.indexOf(a.blastRadius);
    const bRank = BLAST_RADIUS_ORDER.indexOf(b.blastRadius);
    return (aRank < 0 ? 99 : aRank) - (bRank < 0 ? 99 : bRank);
  }
  return a[key].localeCompare(b[key]);
}

function displayPayload(payload: unknown): string {
  if (payload === null) return "Not present";
  return JSON.stringify(payload, null, 2) ?? "Not captured";
}

async function actionRequest(path: string, body: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Action request failed (${response.status})`);
  return response.json();
}

export function DriftTable({
  capabilities,
  items,
}: {
  capabilities: string[];
  items: DriftRecord[];
}) {
  const [query, setQuery] = useState("");
  const [resourceType, setResourceType] = useState("all");
  const [changeType, setChangeType] = useState("all");
  const [blastRadius, setBlastRadius] = useState("all");
  const [sort, setSort] = useState<{ key: SortKey; direction: Direction }>({
    key: "detectedAt",
    direction: "descending",
  });
  const [page, setPage] = useState(1);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [resolvedIds, setResolvedIds] = useState<string[]>([]);
  const [reason, setReason] = useState("");
  const [ignoreUntil, setIgnoreUntil] = useState("");
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [preview, setPreview] = useState<RemediationPreview | null>(null);

  const { canDispose, canRemediate } = driftActionControls(capabilities);
  const canAct = canDispose || canRemediate;
  const openItems = useMemo(
    () => items.filter((item) => !resolvedIds.includes(item.id)),
    [items, resolvedIds],
  );
  const resourceTypes = useMemo(
    () => [...new Set(openItems.map((item) => item.resourceType))].sort(),
    [openItems],
  );
  const blastRadii = useMemo(
    () =>
      [...new Set(openItems.map((item) => item.blastRadius))].sort(
        (a, b) => BLAST_RADIUS_ORDER.indexOf(a) - BLAST_RADIUS_ORDER.indexOf(b),
      ),
    [openItems],
  );

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return openItems
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
  }, [openItems, query, resourceType, changeType, blastRadius, sort]);

  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const pageItems = visible.slice(
    (currentPage - 1) * PAGE_SIZE,
    currentPage * PAGE_SIZE,
  );
  const selectedItems = items.filter((item) => selectedIds.includes(item.id));
  const selectedDriftIds = selectedItems.map((item) => item.id);
  const currentPreview = preview && JSON.stringify([...preview.driftIds].sort())
    === JSON.stringify([...selectedDriftIds].sort()) ? preview : null;
  const expandedItem = pageItems.find((item) => item.id === expandedId) ?? null;
  const pageIsSelected = pageItems.length > 0 && pageItems.every((item) => selectedIds.includes(item.id));

  function resetTablePosition() {
    setPage(1);
    setExpandedId(null);
  }

  function changeSort(key: SortKey) {
    setSort((current) => ({
      key,
      direction:
        current.key === key && current.direction === "ascending"
          ? "descending"
          : "ascending",
    }));
    resetTablePosition();
  }

  function toggleSelected(id: string) {
    setPreview(null);
    setSelectedIds((current) =>
      current.includes(id)
        ? current.filter((candidate) => candidate !== id)
        : [...current, id],
    );
    setActionMessage(null);
    setActionError(null);
  }

  function togglePageSelection() {
    setPreview(null);
    setSelectedIds((current) => {
      const next = new Set(current);
      if (pageIsSelected) {
        pageItems.forEach((item) => next.delete(item.id));
      } else {
        pageItems.forEach((item) => next.add(item.id));
      }
      return [...next];
    });
    setActionMessage(null);
    setActionError(null);
  }

  function requireReason(): string | null {
    const trimmed = reason.trim();
    if (trimmed.length === 0) {
      setActionError("A reason or approval justification is required.");
      return null;
    }
    return trimmed;
  }

  async function disposeSelected(action: "accept" | "ignore") {
    const justification = requireReason();
    if (!justification) return;

    let expiresAt: string | undefined;
    if (action === "ignore") {
      const date = new Date(ignoreUntil);
      if (!ignoreUntil || Number.isNaN(date.valueOf())) {
        setActionError("An expiry is required when ignoring drift.");
        return;
      }
      expiresAt = date.toISOString();
    }

    setSubmitting(true);
    setActionError(null);
    try {
      const disposedIds = await Promise.all(
        selectedDriftIds.map(async (driftId) => {
          await actionRequest("/api/actions/dispose", {
            driftId,
            action,
            reason: justification,
            ...(expiresAt ? { expiresAt } : {}),
          });
          return driftId;
        }),
      );
      setResolvedIds((current) => [...new Set([...current, ...disposedIds])]);
      setSelectedIds((current) => current.filter((id) => !disposedIds.includes(id)));
      setActionMessage(
        `${action === "accept" ? "Accepted" : "Ignored"} ${disposedIds.length} ${disposedIds.length === 1 ? "deviation" : "deviations"}.`,
      );
    } catch {
      setActionError("The disposition could not be completed. No additional deviations were submitted.");
    } finally {
      setSubmitting(false);
    }
  }

  async function previewSelected() {
    setSubmitting(true);
    setPreview(null);
    setActionError(null);
    setActionMessage(null);
    try {
      const result = await actionRequest("/api/actions/remediate/selection", {
        driftIds: selectedDriftIds,
      }) as RemediationPreview;
      setPreview(result);
    } catch {
      setActionError("The remediation preview could not be loaded. No remediation was requested.");
    } finally {
      setSubmitting(false);
    }
  }

  async function remediateSelected() {
    if (!currentPreview || currentPreview.guardRefusals.length > 0) return;
    const justification = requireReason();
    if (!justification) return;

    setSubmitting(true);
    setActionError(null);
    try {
      await actionRequest(
        "/api/actions/remediate",
        remediationParams({
          selectedDriftIds,
          visibleDriftIds: pageItems.map((item) => item.id),
          justification,
        }),
      );
      setPreview(null);
      setActionMessage(
        `Remediation for ${selectedDriftIds.length} ${selectedDriftIds.length === 1 ? "deviation requires" : "deviations requires"} approval before a job is created.`,
      );
    } catch {
      setActionError("The remediation request could not be created.");
    } finally {
      setSubmitting(false);
    }
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
          {visible.length} of {openItems.length}
        </span>
      </div>

      <div className="filter-bar drift-filters">
        <label className="filter-field search-field">
          <span>Find natural key</span>
          <input
            onChange={(event) => {
              setQuery(event.target.value);
              resetTablePosition();
            }}
            placeholder="Search key or type"
            type="search"
            value={query}
          />
        </label>
        <label className="filter-field">
          <span>Resource type</span>
          <select
            onChange={(event) => {
              setResourceType(event.target.value);
              resetTablePosition();
            }}
            value={resourceType}
          >
            <option value="all">All resource types</option>
            {resourceTypes.map((type) => (
              <option key={type} value={type}>{type}</option>
            ))}
          </select>
        </label>
        <label className="filter-field">
          <span>Change</span>
          <select
            onChange={(event) => {
              setChangeType(event.target.value);
              resetTablePosition();
            }}
            value={changeType}
          >
            <option value="all">All changes</option>
            <option value="added">Added</option>
            <option value="modified">Modified</option>
            <option value="removed">Removed</option>
          </select>
        </label>
        <label className="filter-field">
          <span>Blast radius</span>
          <select
            onChange={(event) => {
              setBlastRadius(event.target.value);
              resetTablePosition();
            }}
            value={blastRadius}
          >
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
              resetTablePosition();
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

      {canAct && selectedItems.length > 0 ? (
        <section aria-labelledby="selected-drift-heading" className="drift-action-panel">
          <div>
            <p className="section-kicker">Selected scope</p>
            <h3 id="selected-drift-heading">
              {selectedItems.length} {selectedItems.length === 1 ? "deviation" : "deviations"} selected
            </h3>
            <p className="selection-scope">
              These actions apply only to: {selectedItems.map((item) => item.naturalKey).join(", ")}.
            </p>
          </div>
          <label className="filter-field">
            <span>Reason / approval justification</span>
            <input
              onChange={(event) => setReason(event.target.value)}
              placeholder="Why is this disposition appropriate?"
              value={reason}
            />
          </label>
          {canDispose ? (
            <label className="filter-field">
              <span>Ignore until</span>
              <input
                onChange={(event) => setIgnoreUntil(event.target.value)}
                type="datetime-local"
                value={ignoreUntil}
              />
            </label>
          ) : null}
          <div className="drift-action-buttons">
            {canDispose ? (
              <>
                <button disabled={submitting} onClick={() => void disposeSelected("accept")} type="button">
                  Accept selected
                </button>
                <button disabled={submitting} onClick={() => void disposeSelected("ignore")} type="button">
                  Ignore selected
                </button>
              </>
            ) : null}
            {canRemediate ? (
              <button className="remediate-button" disabled={submitting} onClick={() => void previewSelected()} type="button">
                Preview remediation
              </button>
            ) : null}
            <button
              className="secondary-action"
              disabled={submitting}
              onClick={() => { setSelectedIds([]); setPreview(null); }}
              type="button"
            >
              Clear selection
            </button>
          </div>
          {currentPreview ? (
            <section aria-labelledby="remediation-preview-heading" aria-live="polite">
              <h4 id="remediation-preview-heading">Remediation preview</h4>
              <p>Current live state determines these verbs. Safety checks run again at execution.</p>
              <table className="data-table">
                <thead><tr><th scope="col">Resource</th><th scope="col">Planned verb</th></tr></thead>
                <tbody>{currentPreview.resources.map((resource) => (
                  <tr key={resource.naturalKey}>
                    <th scope="row">{resource.naturalKey}</th>
                    <td>{resource.verb} — {resource.verbReason}</td>
                  </tr>
                ))}</tbody>
              </table>
              <h4>Wave ordering</h4>
              <ol>
                {currentPreview.waves.map((keys, index) => <li key={`write-${index}`}>Apply: {keys.join(", ")}</li>)}
                {currentPreview.patches.length > 0 ? <li>Deferred references: {currentPreview.patches.map((patch) => `${patch.naturalKey} at ${patch.field} → ${patch.symbol}`).join(", ")}</li> : null}
                {currentPreview.deletionWaves.map((keys, index) => <li key={`delete-${index}`}>Delete: {keys.join(", ")}</li>)}
              </ol>
              {currentPreview.guardRefusals.length > 0 ? (
                <div role="alert">
                  <h4>Guard refusals</h4>
                  <ul>{currentPreview.guardRefusals.map((refusal, index) => (
                    <li key={index}>{refusal.naturalKey}: {refusal.reason}</li>
                  ))}</ul>
                </div>
              ) : <p>No guard refusals found in this preview.</p>}
              <button disabled={submitting || currentPreview.guardRefusals.length > 0} onClick={() => void remediateSelected()} type="button">
                Confirm and request approval
              </button>
            </section>
          ) : null}
          {actionMessage ? <p aria-live="polite" className="action-message">{actionMessage}</p> : null}
          {actionError ? <p className="action-error" role="alert">{actionError}</p> : null}
        </section>
      ) : null}

      {visible.length ? (
        <>
          <div className="table-scroll">
            <table className="data-table drift-table">
              <thead>
                <tr>
                  {canAct ? (
                    <th scope="col">
                      <label className="table-checkbox-label">
                        <input
                          aria-label={`Select all ${pageItems.length} deviations on this page`}
                          checked={pageIsSelected}
                          disabled={submitting}
                          onChange={togglePageSelection}
                          type="checkbox"
                        />
                        <span>Select page</span>
                      </label>
                    </th>
                  ) : null}
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
                  <th scope="col">Difference</th>
                </tr>
              </thead>
              <tbody>
                {pageItems.map((item) => {
                  const comparisonOpen = expandedItem?.id === item.id;
                  return (
                    <tr key={item.id}>
                      {canAct ? (
                        <td data-label="Select">
                          <input
                            aria-label={`Select ${item.naturalKey}`}
                            checked={selectedIds.includes(item.id)}
                            disabled={submitting}
                            onChange={() => toggleSelected(item.id)}
                            type="checkbox"
                          />
                        </td>
                      ) : null}
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
                      <td data-label="Difference">
                        <button
                          aria-controls={`drift-diff-${item.id}`}
                          aria-expanded={comparisonOpen}
                          className="comparison-button"
                          onClick={() => setExpandedId(comparisonOpen ? null : item.id)}
                          type="button"
                        >
                          {comparisonOpen ? "Hide comparison" : "View comparison"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {expandedItem ? (
            <section aria-labelledby={`drift-diff-heading-${expandedItem.id}`} className="drift-difference" id={`drift-diff-${expandedItem.id}`}>
              <div className="difference-heading">
                <p className="section-kicker">Explicit comparison</p>
                <h3 id={`drift-diff-heading-${expandedItem.id}`}>{expandedItem.naturalKey}</h3>
              </div>
              <div className="difference-payloads">
                <section aria-label="Baseline before">
                  <h4>Baseline before</h4>
                  <pre>{displayPayload(expandedItem.before)}</pre>
                </section>
                <section aria-label="Observed after">
                  <h4>Observed after</h4>
                  <pre>{displayPayload(expandedItem.after)}</pre>
                </section>
              </div>
            </section>
          ) : null}

          {pageCount > 1 ? (
            <nav aria-label="Drift pagination" className="pagination">
              <span>Page {currentPage} of {pageCount}</span>
              <div>
                <button disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)} type="button">
                  Previous
                </button>
                <button disabled={currentPage === pageCount} onClick={() => setPage(currentPage + 1)} type="button">
                  Next
                </button>
              </div>
            </nav>
          ) : null}
        </>
      ) : (
        <p className="empty-state">
          {openItems.length
            ? "No open drift matches these filters."
            : "No open drift is recorded against this baseline."}
        </p>
      )}
    </section>
  );
}
