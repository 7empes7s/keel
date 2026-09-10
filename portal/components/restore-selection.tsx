"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { postAction } from "@/lib/action-client";
import type { RestoreResource } from "@/lib/portal-data";
import type { SnapshotOption } from "@/lib/portal-jobs";
import { words } from "@/lib/presentation";
import { formatTimestamp } from "@/lib/presentation";

const PAGE_SIZE = 25;

interface AdditionReason {
  requiredBy: string;
  field: string;
}

interface Addition {
  naturalKey: string;
  resourceType: string;
  reasons: AdditionReason[];
}

interface UnresolvedReference {
  from: string;
  field: string;
  symbol: string;
}

interface GuardRefusal {
  naturalKey: string;
  reason: string;
}

interface SelectionPreview {
  selected: string[];
  closureKeys: string[];
  added: Addition[];
  unresolvedReferences: UnresolvedReference[];
  guardRefusals: GuardRefusal[];
  missingRequirements: Addition[];
}

function describeSnapshot(snapshot: SnapshotOption): string {
  const captured = formatTimestamp(snapshot.completedAt ?? snapshot.startedAt);
  return `${captured} — ${snapshot.resourceCount.toLocaleString("en-GB")} resources`;
}

function formatReasons(reasons: AdditionReason[]): string {
  return reasons
    .map((reason) => `${reason.requiredBy} at ${reason.field}`)
    .join("; ");
}

async function previewSelection(
  snapshotId: string,
  selected: string[],
): Promise<SelectionPreview> {
  const response = await fetch("/api/actions/restore/selection", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ snapshotId, selected }),
  });
  if (!response.ok) throw new Error(`preview failed (${response.status})`);
  return (await response.json()) as SelectionPreview;
}

// Restore selection (portal-design §4.1). The operator picks resources; EVERY change
// is previewed against the server, and the server-computed closure is shown — what was
// added and why. Deselecting something another selection requires is refused with the
// requiring resource and field as the reason. The submit posts the RAW selection
// (never the client-side closure) to the approval-gated restore action; the CLI
// recomputes the closure from the snapshot at execution. All of this is convenience:
// the server-side path is the control.
export function RestoreSelection({
  canRestore,
  resources,
  snapshotId,
  snapshots,
}: {
  canRestore: boolean;
  resources: RestoreResource[];
  snapshotId: string;
  snapshots: SnapshotOption[];
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [resourceType, setResourceType] = useState("all");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string[]>([]);
  const [preview, setPreview] = useState<SelectionPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [collectorConfig, setCollectorConfig] = useState("/etc/keel/tenant-target.json");
  const [targetConfig, setTargetConfig] = useState("/etc/keel/restorer-target.json");
  const [mode, setMode] = useState<"dry-run" | "enforce">("dry-run");
  const [justification, setJustification] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const resourceTypes = useMemo(
    () => [...new Set(resources.map((resource) => resource.resourceType))].sort(),
    [resources],
  );
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return resources
      .filter(
        (resource) =>
          (resourceType === "all" || resource.resourceType === resourceType)
          && (!needle || resource.naturalKey.toLowerCase().includes(needle)),
      )
      .sort((a, b) => a.naturalKey.localeCompare(b.naturalKey));
  }, [resources, query, resourceType]);

  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const pageItems = visible.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const refusedKeys = new Set((preview?.guardRefusals ?? []).map((r) => r.naturalKey));
  const closureKeys = new Set(preview?.closureKeys ?? []);
  const addedByKey = new Map((preview?.added ?? []).map((a) => [a.naturalKey, a]));

  async function applySelection(next: string[]): Promise<boolean> {
    setPreviewing(true);
    setError(null);
    try {
      const nextPreview = await previewSelection(snapshotId, next);
      setSelected(next);
      setPreview(nextPreview);
      return true;
    } catch {
      setError("The selection preview could not be computed. The selection was not changed.");
      return false;
    } finally {
      setPreviewing(false);
    }
  }

  async function toggle(key: string) {
    setRefusal(null);
    setMessage(null);
    if (!selected.includes(key)) {
      await applySelection([...selected, key]);
      return;
    }

    // §4.1: deselecting something another selection requires is refused with a
    // reason, not silently allowed. The preview of the candidate selection names
    // exactly which selected resource still requires this one.
    const candidate = selected.filter((key2) => key2 !== key);
    setPreviewing(true);
    setError(null);
    try {
      const candidatePreview = await previewSelection(snapshotId, candidate);
      const missing = candidatePreview.missingRequirements.find((m) => m.naturalKey === key);
      if (missing) {
        setRefusal(
          `Cannot deselect ${key} — required by ${formatReasons(missing.reasons)}. Deselect the requiring resource first.`,
        );
        return;
      }
      setSelected(candidate);
      setPreview(candidatePreview);
    } catch {
      setError("The selection preview could not be computed. The selection was not changed.");
    } finally {
      setPreviewing(false);
    }
  }

  async function clearSelection() {
    setRefusal(null);
    setMessage(null);
    await applySelection([]);
  }

  async function submit() {
    if (selected.length === 0) {
      setError("Select at least one resource to restore.");
      return;
    }
    if (collectorConfig.trim().length === 0 || targetConfig.trim().length === 0) {
      setError("Both the collector and restorer credential config paths are required.");
      return;
    }

    setSubmitting(true);
    setMessage(null);
    setError(null);
    try {
      const { payload } = await postAction(
        "/api/actions/restore",
        {
          snapshotId,
          selection: selected,
          collectorConfig: collectorConfig.trim(),
          targetConfig: targetConfig.trim(),
          ...(mode === "enforce" ? { mode } : {}),
          ...(justification.trim() ? { justification: justification.trim() } : {}),
        },
        idempotencyKey,
      );
      if (payload.approvalRequest) {
        setMessage(
          "Restore requested — pending approval. Nothing has been restored; a job is created only when a different principal approves.",
        );
        setIdempotencyKey(crypto.randomUUID());
        router.refresh();
      } else {
        setError("Unexpected response: the restore did not produce an approval request.");
      }
    } catch {
      setError("The restore request could not be created.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section aria-labelledby="restore-selection-heading" className="report-section">
      <div className="section-heading-row report-heading">
        <div>
          <p className="section-kicker">Dependency-closed selection</p>
          <h2 id="restore-selection-heading">Choose what to restore</h2>
        </div>
        <span aria-live="polite" className="result-count">
          {visible.length} of {resources.length}
        </span>
      </div>

      <div className="filter-bar">
        <label className="filter-field">
          <span>Snapshot</span>
          <select
            disabled={submitting}
            onChange={(event) => router.push(`/restore?snapshot=${event.target.value}`)}
            value={snapshotId}
          >
            {snapshots.map((snapshot) => (
              <option key={snapshot.id} value={snapshot.id}>
                {describeSnapshot(snapshot)}
              </option>
            ))}
          </select>
        </label>
        <label className="filter-field search-field">
          <span>Find natural key</span>
          <input
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(1);
            }}
            placeholder="Search key"
            type="search"
            value={query}
          />
        </label>
        <label className="filter-field">
          <span>Resource type</span>
          <select
            onChange={(event) => {
              setResourceType(event.target.value);
              setPage(1);
            }}
            value={resourceType}
          >
            <option value="all">All resource types</option>
            {resourceTypes.map((type) => (
              <option key={type} value={type}>{type}</option>
            ))}
          </select>
        </label>
      </div>

      {visible.length ? (
        <>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Select</th>
                  <th scope="col">Natural key</th>
                  <th scope="col">Resource type</th>
                  <th scope="col">Blast radius</th>
                  <th scope="col">Selection</th>
                </tr>
              </thead>
              <tbody>
                {pageItems.map((resource) => {
                  const isSelected = selected.includes(resource.naturalKey);
                  const isAdded = !isSelected && closureKeys.has(resource.naturalKey);
                  const addition = addedByKey.get(resource.naturalKey);
                  return (
                    <tr key={resource.naturalKey}>
                      <td data-label="Select">
                        <input
                          aria-label={`Select ${resource.naturalKey}`}
                          checked={isSelected}
                          disabled={!canRestore || previewing || submitting}
                          onChange={() => void toggle(resource.naturalKey)}
                          type="checkbox"
                        />
                      </td>
                      <th data-label="Natural key" scope="row">
                        <code className="natural-key">{resource.naturalKey}</code>
                      </th>
                      <td data-label="Resource type">
                        <span className="resource-type">{resource.resourceType}</span>
                      </td>
                      <td data-label="Blast radius">{words(resource.blastRadius)}</td>
                      <td data-label="Selection">
                        {isSelected ? "Selected" : null}
                        {isAdded && addition ? (
                          <span className="selection-scope">
                            Added — required by {formatReasons(addition.reasons)}
                          </span>
                        ) : null}
                        {refusedKeys.has(resource.naturalKey) ? (
                          <span className="action-error"> Refused — AD-synced</span>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {pageCount > 1 ? (
            <nav aria-label="Restore resource pagination" className="pagination">
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
          {resources.length
            ? "No resources match these filters."
            : "This snapshot has no restorable resources."}
        </p>
      )}

      {refusal ? <p className="action-error" role="alert">{refusal}</p> : null}

      {preview && preview.closureKeys.length > 0 ? (
        <section aria-labelledby="restore-closure-heading" className="drift-action-panel">
          <div>
            <p className="section-kicker">What will be restored</p>
            <h3 id="restore-closure-heading">
              {preview.closureKeys.length} {preview.closureKeys.length === 1 ? "resource" : "resources"} in the closure
              {" "}({preview.selected.length} selected, {preview.added.length} added)
            </h3>
          </div>

          {preview.added.length ? (
            <ul>
              {preview.added.map((addition) => (
                <li key={addition.naturalKey}>
                  <code className="natural-key">{addition.naturalKey}</code>
                  {" — required by "}
                  {formatReasons(addition.reasons)}
                </li>
              ))}
            </ul>
          ) : (
            <p>The selection is already dependency-closed; nothing was added.</p>
          )}

          {preview.unresolvedReferences.length ? (
            <div className="data-error" role="alert">
              <p className="severity-label">UNRESOLVED REFERENCES</p>
              <ul>
                {preview.unresolvedReferences.map((reference) => (
                  <li key={`${reference.from}:${reference.field}`}>
                    {reference.from} at {reference.field} → {reference.symbol} — no resource
                    in this snapshot provides it; the restore will fail unless it exists in
                    the target.
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {preview.guardRefusals.length ? (
            <div className="data-error" role="alert">
              <p className="severity-label">REFUSED AT SELECTION TIME</p>
              <ul>
                {preview.guardRefusals.map((guardRefusal) => (
                  <li key={guardRefusal.naturalKey}>
                    <code className="natural-key">{guardRefusal.naturalKey}</code>
                    {" — "}
                    {guardRefusal.reason}
                  </li>
                ))}
              </ul>
              <p>Remove the refused resources from the selection before submitting.</p>
            </div>
          ) : null}

          <div className="filter-bar">
            <label className="filter-field">
              <span>Collector credential config (read-only)</span>
              <input
                disabled={submitting}
                onChange={(event) => setCollectorConfig(event.target.value)}
                value={collectorConfig}
              />
            </label>
            <label className="filter-field">
              <span>Restorer credential config (write)</span>
              <input
                disabled={submitting}
                onChange={(event) => setTargetConfig(event.target.value)}
                value={targetConfig}
              />
            </label>
            <label className="filter-field">
              <span>Mode</span>
              <select
                disabled={submitting}
                onChange={(event) => setMode(event.target.value as "dry-run" | "enforce")}
                value={mode}
              >
                <option value="dry-run">Dry run — plan only, no writes</option>
                <option value="enforce">Enforce — writes to the target tenant</option>
              </select>
            </label>
            <label className="filter-field">
              <span>Approval justification</span>
              <input
                disabled={submitting}
                onChange={(event) => setJustification(event.target.value)}
                placeholder="Why is this restore appropriate?"
                value={justification}
              />
            </label>
          </div>

          <div className="drift-action-buttons">
            <button
              disabled={
                !canRestore
                || submitting
                || previewing
                || preview.guardRefusals.length > 0
              }
              onClick={() => void submit()}
              type="button"
            >
              Request restore
            </button>
            <button
              className="secondary-action"
              disabled={submitting || previewing}
              onClick={() => void clearSelection()}
              type="button"
            >
              Clear selection
            </button>
          </div>
          <p className="selection-scope">
            Restore requires approval: submitting creates an approval request, not a job.
            The approver sees exactly this selection; the closure is recomputed from the
            snapshot when the approved job runs.
          </p>
          {message ? <p aria-live="polite" className="action-message">{message}</p> : null}
        </section>
      ) : null}

      {error ? <p className="action-error" role="alert">{error}</p> : null}
    </section>
  );
}
