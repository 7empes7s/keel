"use client";

import { Fragment, useMemo, useState } from "react";

import { BlastBadge, ChangeBadge } from "@/components/status-badge";
import { ChangeAttributionPanel } from "@/components/change-attribution";
import { ChangeEvidencePanel, DecisionWorkbook } from "@/components/decision-workbook";
import { DriftDiff } from "@/components/drift-diff";
import { SemanticDiff } from "@/components/semantic-diff";
import { RecordField, TechnicalDetails } from "@/components/technical-details";
import { plannedActionWords, refusalSentence, resourceName } from "@/lib/changes-view";
import { typeName } from "@/lib/protect-view";
import { driftActionControls, remediationParams } from "@/lib/drift-actions";
import { toast } from "@/lib/toast";
import { BLAST_RADIUS_ORDER, ago, displayEnum, formatTimestamp, resourceLabel } from "@/lib/presentation";
import type { DriftRecord, SemanticSummary } from "@/lib/types";

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
  now,
  summary,
}: {
  capabilities: string[];
  items: DriftRecord[];
  now?: string;
  // Task 98: the server's counts over `items`; the decision summary shows when present.
  summary?: SemanticSummary;
}) {
  const at = now ?? new Date().toISOString();
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
  const blastCounts = blastRadii.map((radius) => ({
    value: radius,
    count: openItems.filter((item) => item.blastRadius === radius).length,
  }));
  const changeCounts = (["added", "modified", "removed"] as const).map((change) => ({
    value: change,
    count: openItems.filter((item) => item.changeType === change).length,
  }));

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
      setActionError("Say why: a reason is required.");
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
        setActionError("Choose until when to ignore these changes.");
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
        `${action === "accept" ? "Accepted" : "Ignored"} ${disposedIds.length} ${disposedIds.length === 1 ? "change" : "changes"}.`,
      );
      toast({ title: `${action === "accept" ? "Accepted" : "Ignored"} ${disposedIds.length} ${disposedIds.length === 1 ? "change" : "changes"}` });
    } catch {
      setActionError("KEEL could not save the decision. No further changes were sent.");
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
      setActionError("KEEL could not prepare the roll-back preview. Nothing was requested.");
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
      toast({ tone: "info", title: "Sent to approvers", detail: "Nothing changes until one of them approves.", href: "/approvals", hrefLabel: "Open approvals" });
      setActionMessage("Sent to approvers. Nothing changes until one of them approves.");
    } catch {
      setActionError("KEEL could not send the roll-back for approval. Try again in a minute.");
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
    <>
    {summary ? <DecisionWorkbook summary={summary} /> : null}
    <section aria-labelledby="open-drift-heading" className="report-section">
      <div className="section-heading-row report-heading">
        <div>
          <p className="section-kicker">Since the baseline</p>
          <h2 id="open-drift-heading">Open changes</h2>
        </div>
        <span aria-live="polite" className="result-count">
          {visible.length} of {openItems.length}
        </span>
      </div>

      {openItems.length ? (
        <div aria-label="Quick filters" className="quick-filters" role="group">
          {blastCounts.map((entry) => (
            <button
              aria-pressed={blastRadius === entry.value}
              className={`quick-filter blast-chip-${entry.value}`}
              key={entry.value}
              onClick={() => {
                setBlastRadius(blastRadius === entry.value ? "all" : entry.value);
                resetTablePosition();
              }}
              type="button"
            >
              <span aria-hidden="true" className={`legend-swatch blast-fill-${entry.value}`} />
              {displayEnum("blastRadius", entry.value)} <strong>{entry.count}</strong>
            </button>
          ))}
          <span aria-hidden="true" className="quick-filter-divider" />
          {changeCounts.map((entry) => (
            <button
              aria-pressed={changeType === entry.value}
              className="quick-filter"
              disabled={entry.count === 0}
              key={entry.value}
              onClick={() => {
                setChangeType(changeType === entry.value ? "all" : entry.value);
                resetTablePosition();
              }}
              type="button"
            >
              {displayEnum("changeType", entry.value)} <strong>{entry.count}</strong>
            </button>
          ))}
        </div>
      ) : null}

      <div className="filter-bar drift-filters drift-toolbar">
        <label className="filter-field search-field">
          <span>Find a resource</span>
          <input
            onChange={(event) => {
              setQuery(event.target.value);
              resetTablePosition();
            }}
            placeholder="Name or type"
            type="search"
            value={query}
          />
        </label>
        <label className="filter-field">
          <span>Type</span>
          <select
            onChange={(event) => {
              setResourceType(event.target.value);
              resetTablePosition();
            }}
            value={resourceType}
          >
            <option value="all">All types</option>
            {resourceTypes.map((type) => (
              <option key={type} value={type}>{typeName(type)}</option>
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
            <option value="modified">Changed</option>
            <option value="removed">Removed</option>
          </select>
        </label>
        <label className="filter-field">
          <span>Impact</span>
          <select
            onChange={(event) => {
              setBlastRadius(event.target.value);
              resetTablePosition();
            }}
            value={blastRadius}
          >
            <option value="all">Any impact</option>
            {blastRadii.map((radius) => (
              <option key={radius} value={radius}>{displayEnum("blastRadius", radius)}</option>
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
            <option value="detectedAt:descending">Found · newest</option>
            <option value="detectedAt:ascending">Found · oldest</option>
            <option value="blastRadius:ascending">Impact · highest first</option>
            <option value="naturalKey:ascending">Name · A–Z</option>
            <option value="resourceType:ascending">Type · A–Z</option>
            <option value="changeType:ascending">Change · A–Z</option>
          </select>
        </label>
      </div>

      {canAct && selectedItems.length > 0 ? (
        <section aria-labelledby="selected-drift-heading" className="drift-action-panel">
          <div>
            <p className="section-kicker">Your decision</p>
            <h3 id="selected-drift-heading">
              {selectedItems.length} {selectedItems.length === 1 ? "change" : "changes"} selected
            </h3>
            <p className="selection-scope">
              This applies only to: {selectedItems.map((item) => resourceLabel(item.naturalKey)).join(", ")}.
            </p>
          </div>
          <label className="filter-field">
            <span>Why</span>
            <input
              onChange={(event) => setReason(event.target.value)}
              placeholder="Why is this decision right?"
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
                  Accept
                </button>
                <button disabled={submitting} onClick={() => void disposeSelected("ignore")} type="button">
                  Ignore
                </button>
              </>
            ) : null}
            {canRemediate ? (
              <button className="remediate-button" disabled={submitting} onClick={() => void previewSelected()} type="button">
                Preview roll back
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
            <section aria-labelledby="remediation-preview-heading" aria-live="polite" className="remediation-preview">
              <div>
                <p className="section-kicker">Roll back</p>
                <h4 id="remediation-preview-heading">What rolling back would do</h4>
                <p className="field-help">Worked out from the tenant as it is now. KEEL checks again before it changes anything.</p>
              </div>
              <table className="data-table">
                <thead><tr><th scope="col">Resource</th><th scope="col">What KEEL would do</th></tr></thead>
                <tbody>{currentPreview.resources.map((resource) => (
                  <tr key={resource.naturalKey}>
                    <th scope="row">{resourceLabel(resource.naturalKey)}</th>
                    <td>{plannedActionWords(resource.verb)}</td>
                  </tr>
                ))}</tbody>
              </table>
              {currentPreview.guardRefusals.length > 0 ? (
                <div className="data-error" role="alert">
                  <p className="severity-label">Cannot roll back</p>
                  <ul>{currentPreview.guardRefusals.map((refusal, index) => (
                    <li key={index}>{refusalSentence(refusal)}</li>
                  ))}</ul>
                </div>
              ) : <p className="action-message">KEEL found nothing it would refuse to change.</p>}
              <TechnicalDetails>
                {currentPreview.resources.map((resource) => (
                  <RecordField copy={false} key={resource.naturalKey} label={`Planned verb · ${resource.naturalKey}`} value={`${resource.verb} · ${resource.verbReason}`} />
                ))}
                {currentPreview.waves.map((keys, index) => (
                  <RecordField copy={false} key={`write-${index}`} label={`Write wave ${index + 1}`} value={keys.join(", ")} />
                ))}
                {currentPreview.patches.length > 0 ? (
                  <RecordField copy={false} label="Deferred references" value={currentPreview.patches.map((patch) => `${patch.naturalKey} at ${patch.field} → ${patch.symbol}`).join(", ")} />
                ) : null}
                {currentPreview.deletionWaves.map((keys, index) => (
                  <RecordField copy={false} key={`delete-${index}`} label={`Delete wave ${index + 1}`} value={keys.join(", ")} />
                ))}
                {currentPreview.guardRefusals.map((refusal, index) => (
                  <RecordField copy={false} key={`refusal-${index}`} label={`Guard refusal · ${refusal.naturalKey}`} value={refusal.reason} />
                ))}
                <RecordField copy={false} label="Drift IDs" value={currentPreview.driftIds.join(", ")} />
              </TechnicalDetails>
              <button className="danger-action" disabled={submitting || currentPreview.guardRefusals.length > 0} onClick={() => void remediateSelected()} type="button">
                Confirm and request approval
              </button>
            </section>
          ) : null}
          {actionMessage ? <p aria-live="polite" className="action-message">{actionMessage}</p> : null}
          {actionError ? <p className="action-error" role="alert">{actionError}</p> : null}
        </section>
      ) : null}

      {canAct && selectedItems.length > 0 ? (
        <div aria-label="Selection" className="selection-dock" role="region">
          <span><strong>{selectedItems.length}</strong> selected</span>
          <a className="btn btn-primary btn-sm" href="#selected-drift-heading">Review actions</a>
          <button
            className="btn btn-ghost btn-sm"
            disabled={submitting}
            onClick={() => { setSelectedIds([]); setPreview(null); }}
            type="button"
          >
            Deselect all
          </button>
        </div>
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
                          aria-label={`Select all ${pageItems.length} changes on this page`}
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
                    {heading("Resource", "naturalKey")}
                  </th>
                  <th aria-sort={sort.key === "resourceType" ? sort.direction : "none"} scope="col">
                    {heading("Type", "resourceType")}
                  </th>
                  <th aria-sort={sort.key === "changeType" ? sort.direction : "none"} scope="col">
                    {heading("Change", "changeType")}
                  </th>
                  <th aria-sort={sort.key === "blastRadius" ? sort.direction : "none"} scope="col">
                    {heading("Impact", "blastRadius")}
                  </th>
                  <th aria-sort={sort.key === "detectedAt" ? sort.direction : "none"} scope="col">
                    {heading("Found", "detectedAt")}
                  </th>
                  <th scope="col">What changed</th>
                </tr>
              </thead>
              <tbody>
                {pageItems.map((item) => {
                  const comparisonOpen = expandedItem?.id === item.id;
                  return (
                    <Fragment key={item.id}>
                    <tr className={`drift-row blast-row-${item.blastRadius}${comparisonOpen ? " drift-row-open" : ""}${selectedIds.includes(item.id) ? " drift-row-selected" : ""}`}>
                      {canAct ? (
                        <td data-label="Select">
                          <input
                            aria-label={`Select ${resourceLabel(item.naturalKey)}`}
                            checked={selectedIds.includes(item.id)}
                            disabled={submitting}
                            onChange={() => toggleSelected(item.id)}
                            type="checkbox"
                          />
                        </td>
                      ) : null}
                      <th data-label="Resource" scope="row">
                        <span className="resource-name">{resourceName(item.naturalKey)}</span>
                      </th>
                      <td data-label="Type">
                        <span className="resource-type">{typeName(item.resourceType)}</span>
                      </td>
                      <td data-label="Change"><ChangeBadge value={item.changeType} /></td>
                      <td data-label="Impact"><BlastBadge value={item.blastRadius} /></td>
                      <td data-label="Found">
                        <time dateTime={item.detectedAt} title={formatTimestamp(item.detectedAt)}>{ago(item.detectedAt, at)}</time>
                      </td>
                      <td data-label="What changed">
                        <button
                          aria-controls={`drift-diff-${item.id}`}
                          aria-expanded={comparisonOpen}
                          className="comparison-button"
                          onClick={() => setExpandedId(comparisonOpen ? null : item.id)}
                          type="button"
                        >
                          {comparisonOpen ? "Hide what changed" : "Show what changed"}
                        </button>
                        {comparisonOpen ? null : (
                          <TechnicalDetails>
                            <RecordField label="Natural key" value={item.naturalKey} />
                            <RecordField label="Drift ID" value={item.id} />
                            <RecordField copy={false} label="Detected at" value={item.detectedAt} />
                          </TechnicalDetails>
                        )}
                      </td>
                    </tr>
                    {comparisonOpen ? (
                      <tr className="diff-row">
                        <td colSpan={canAct ? 7 : 6}>
                          {item.semantic ? <SemanticDiff change={item.semantic} item={item} /> : <DriftDiff item={item} />}
                          {item.evidence !== undefined ? <ChangeEvidencePanel attribution={item.attribution} evidence={item.evidence} now={at} /> : null}
                          {item.attribution !== undefined ? <ChangeAttributionPanel attribution={item.attribution} now={at} /> : null}
                        </td>
                      </tr>
                    ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>

          {pageCount > 1 ? (
            <nav aria-label="Changes pagination" className="pagination">
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
            ? "No open change matches these filters."
            : "Nothing has changed since this baseline was set."}
        </p>
      )}
    </section>
    </>
  );
}
