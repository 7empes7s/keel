"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { postAction } from "@/lib/action-client";
import { RecoveryMechanismTable, type RecoveryMechanism } from "@/components/recovery-mechanism";
import { ContentEffectsPanel, type ContentEffect } from "@/components/content-effects";
import { toast } from "@/lib/toast";
import type { RestoreResource } from "@/lib/portal-data";
import type { SnapshotOption } from "@/lib/portal-jobs";
import { words } from "@/lib/presentation";
import { formatTimestamp } from "@/lib/presentation";

const PAGE_SIZE = 25;
const DRY_RUN_POLL_MS = 3000;

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

interface DryRunResourceResult {
  naturalKey: string;
  reason?: string;
  error?: string;
}

interface DryRunResults {
  applied: DryRunResourceResult[];
  skipped: DryRunResourceResult[];
  failed: DryRunResourceResult[];
  notRemediable: DryRunResourceResult[];
}

// Roadmap task-61: a group member/owner edge change the dry run planned, written
// only through qualified $ref operations. Null on artifacts persisted before edge
// restore existed, or when no restored group had observed edges.
interface RelationshipOperation {
  parentNaturalKey: string;
  family: "member" | "owner";
  action: "add" | "remove";
  targetNaturalKey: string | null;
  targetId: string | null;
}

interface DryRunArtifact {
  id: string;
  status: "completed" | "refused" | "failed";
  closureKeys: string[];
  guardRefusals: GuardRefusal[];
  results: DryRunResults;
  relationshipOperations?: RelationshipOperation[] | null;
  // Roadmap task-64: null on artifacts persisted before mechanisms were recorded.
  recoveryMechanisms?: RecoveryMechanism[] | null;
  // Roadmap task-66: content effects, the digest an approver binds to, and the
  // separate high-impact approvals already recorded for exactly these effects.
  contentEffects?: ContentEffect[] | null;
  effectsDigest?: string | null;
  contentEffectApprovals?: { approvedBy: string; approvedAt: string | null }[];
}

const EDGE_RESULT_PREFIX = "edge:";

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

async function fetchJobStatus(jobId: string): Promise<string | null> {
  const response = await fetch(`/api/jobs/${jobId}`, { cache: "no-store" });
  if (!response.ok) return null;
  const { job } = (await response.json()) as { job: { status: string } };
  return job.status;
}

async function fetchDryRunArtifact(artifactId: string): Promise<DryRunArtifact | null> {
  const response = await fetch(`/api/actions/restore/dry-run/${artifactId}`, { cache: "no-store" });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`dry-run fetch failed (${response.status})`);
  const { artifact } = (await response.json()) as { artifact: DryRunArtifact };
  return artifact;
}

type RestoreStep = "select" | "dry-run" | "review" | "confirm" | "track";

const STEPS: { id: RestoreStep; label: string }[] = [
  { id: "select", label: "Select" },
  { id: "dry-run", label: "Dry run" },
  { id: "review", label: "Review" },
  { id: "confirm", label: "Confirm" },
  { id: "track", label: "Track" },
];

export function RestoreStepper({ current, failed = false }: { current: RestoreStep; failed?: boolean }) {
  // Confirm is reached only through a completed review, so it marks Review done too.
  const index = STEPS.findIndex((step) => step.id === current);
  return (
    <ol aria-label="Restore steps" className="wizard-steps">
      {STEPS.map((step, position) => {
        const state = position < index ? "done" : position === index ? (failed ? "failed" : "current") : "upcoming";
        return (
          <li aria-current={position === index ? "step" : undefined} className={`wizard-step step-${state}`} key={step.id}>
            <span aria-hidden="true" className="wizard-step-marker">{state === "done" ? "✓" : state === "failed" ? "!" : position + 1}</span>
            <span className="wizard-step-label">{step.label}</span>
          </li>
        );
      })}
    </ol>
  );
}

// Restore selection (portal-design §4.1, plan task 8). The operator picks resources;
// EVERY change is previewed against the server, and the server-computed closure is
// shown — what was added and why. Promotion is a structural flow, not a mode switch:
// a raw selection may only start a dry run (POST .../restore/dry-run); once the
// worker computes it, its ACTUAL planned changes and refusals are rendered here from
// the persisted, immutable artifact; only THAT completed artifact can be confirmed
// (POST .../restore, {artifactId}) — there is no field in this component that can
// request enforce directly. The server-side path is the control throughout: the
// dry-run route strips everything but the validated scope fields, the confirm route
// re-validates the artifact before creating an approval request, and cli/keel-restore.mjs
// re-validates it again — against a fresh read of the target — before it ever writes.
export function RestoreSelection({
  canRestore,
  canApprove = false,
  resources,
  snapshotId,
  snapshots,
}: {
  canRestore: boolean;
  canApprove?: boolean;
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
  const [justification, setJustification] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The dry run in flight: set once .../restore/dry-run enqueues a job, cleared once
  // its artifact is fetched (success) or it fails outright.
  const [dryRunJobId, setDryRunJobId] = useState<string | null>(null);
  const [dryRunArtifactId, setDryRunArtifactId] = useState<string | null>(null);
  const [dryRunStatus, setDryRunStatus] = useState<"running" | "failed" | null>(null);
  const [artifact, setArtifact] = useState<DryRunArtifact | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  useEffect(() => () => {
    if (pollTimer.current) clearTimeout(pollTimer.current);
  }, []);

  function resetDryRun() {
    if (pollTimer.current) clearTimeout(pollTimer.current);
    setDryRunJobId(null);
    setDryRunArtifactId(null);
    setDryRunStatus(null);
    setArtifact(null);
  }

  async function applySelection(next: string[]): Promise<boolean> {
    setPreviewing(true);
    setError(null);
    try {
      const nextPreview = await previewSelection(snapshotId, next);
      setSelected(next);
      setPreview(nextPreview);
      resetDryRun();
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
      resetDryRun();
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

  function pollDryRun(jobId: string, artifactId: string) {
    pollTimer.current = setTimeout(async () => {
      try {
        const status = await fetchJobStatus(jobId);
        if (status === "failed" || status === "cancelled") {
          setDryRunStatus("failed");
          setError("The dry run failed to complete. Adjust the selection or credential configs and try again.");
          return;
        }
        if (status === "succeeded") {
          const found = await fetchDryRunArtifact(artifactId);
          if (found) {
            setArtifact(found);
            setDryRunStatus(null);
            return;
          }
        }
        pollDryRun(jobId, artifactId);
      } catch {
        pollDryRun(jobId, artifactId);
      }
    }, DRY_RUN_POLL_MS);
  }

  async function startDryRun() {
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
    resetDryRun();
    try {
      const { payload } = await postAction(
        "/api/actions/restore/dry-run",
        {
          snapshotId,
          selection: selected,
          collectorConfig: collectorConfig.trim(),
          targetConfig: targetConfig.trim(),
        },
        idempotencyKey,
      );
      const job = payload.job as { id: string };
      const artifactId = payload.artifactId as string;
      if (!job || typeof job.id !== "string" || typeof artifactId !== "string") {
        setError("Unexpected response: the dry run did not produce a job.");
        return;
      }
      setIdempotencyKey(crypto.randomUUID());
      setDryRunJobId(job.id);
      setDryRunArtifactId(artifactId);
      setDryRunStatus("running");
      pollDryRun(job.id, artifactId);
    } catch {
      setError("The dry run could not be started.");
    } finally {
      setSubmitting(false);
    }
  }

  async function confirm() {
    if (!dryRunArtifactId || !artifact || artifact.status !== "completed") return;

    setSubmitting(true);
    setMessage(null);
    setError(null);
    try {
      const { payload } = await postAction(
        "/api/actions/restore",
        {
          artifactId: dryRunArtifactId,
          ...(justification.trim() ? { justification: justification.trim() } : {}),
        },
        idempotencyKey,
      );
      if (payload.approvalRequest) {
        setMessage(
          "Restore requested — pending approval. Nothing has been restored; a job is created only when a different principal approves the exact dry run reviewed above.",
        );
        setIdempotencyKey(crypto.randomUUID());
        resetDryRun();
        toast({ tone: "info", title: "Restore sent for approval", detail: "Nothing is restored until a different approver signs off.", href: "/approvals", hrefLabel: "Open approvals" });
        router.refresh();
      } else {
        setError("Unexpected response: the confirmation did not produce an approval request.");
      }
    } catch {
      setError("The restore confirmation could not be created.");
    } finally {
      setSubmitting(false);
    }
  }

  // The wizard step is derived from the existing promotion state, never stored on its
  // own, so it cannot disagree with what the server has actually been asked to do.
  const step: RestoreStep = message
    ? "track"
    : artifact
      ? (artifact.status === "completed" ? "confirm" : "review")
      : dryRunStatus === "running"
        ? "dry-run"
        : "select";
  const selectionLocked = step !== "select";
  const closureSize = preview?.closureKeys.length ?? 0;
  const currentSnapshot = snapshots.find((snapshot) => snapshot.id === snapshotId) ?? null;

  return (
    <section aria-labelledby="restore-selection-heading" className="report-section restore-wizard">
      <div className="section-heading-row report-heading">
        <div>
          <p className="section-kicker">Dependency-closed restore</p>
          <h2 id="restore-selection-heading">Plan a restore</h2>
        </div>
        <span aria-live="polite" className="result-count">
          {closureSize ? `${closureSize} in closure` : `${resources.length} restorable`}
        </span>
      </div>

      <RestoreStepper current={step} failed={artifact !== null && artifact.status !== "completed"} />

      {step === "track" ? (
        <section aria-labelledby="restore-track-heading" className="wizard-panel wizard-track">
          <p className="section-kicker">Step 5 · Track</p>
          <h3 id="restore-track-heading">Restore requested, pending approval</h3>
          <p aria-live="polite">{message}</p>
          <ol className="track-timeline">
            <li className="track-done">Dry run computed and persisted</li>
            <li className="track-done">Approval request created</li>
            <li className="track-current">A different approver reviews the same dry run</li>
            <li>The CLI re-checks the target, then writes; the job appears below</li>
          </ol>
          <div className="form-actions">
            <a className="btn btn-secondary" href="#restore-jobs-heading">View restore jobs</a>
            <button
              className="btn btn-ghost"
              disabled={submitting || previewing}
              onClick={() => void clearSelection()}
              type="button"
            >
              Plan another restore
            </button>
          </div>
        </section>
      ) : null}

      {selectionLocked && step !== "track" ? (
        <div className="wizard-summary">
          <div>
            <p className="section-kicker">Step 1 · Selection</p>
            <p>
              <strong>{closureSize}</strong> {closureSize === 1 ? "resource" : "resources"}
              {currentSnapshot ? ` from ${describeSnapshot(currentSnapshot)}` : null}
              {preview ? ` (${preview.selected.length} selected, ${preview.added.length} added)` : null}
            </p>
          </div>
          <button
            className="btn btn-ghost btn-sm"
            disabled={submitting || dryRunStatus === "running"}
            onClick={() => resetDryRun()}
            type="button"
          >
            Edit selection
          </button>
        </div>
      ) : null}

      {step === "select" ? (
        <div className="wizard-panel">
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
                <table className="data-table restore-table" aria-busy={previewing || undefined}>
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
                      const isRefused = refusedKeys.has(resource.naturalKey);
                      return (
                        <tr
                          className={isRefused ? "row-refused" : isSelected ? "row-selected" : isAdded ? "row-added" : undefined}
                          key={resource.naturalKey}
                        >
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
                            {isSelected ? <span className="selection-chip chip-selected">Selected</span> : null}
                            {isAdded && addition ? (
                              <span className="selection-chip chip-added" title={`Required by ${formatReasons(addition.reasons)}`}>
                                Added — required by {formatReasons(addition.reasons)}
                              </span>
                            ) : null}
                            {isRefused ? (
                              <span className="selection-chip chip-refused"> Refused — AD-synced</span>
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
            <section aria-labelledby="restore-closure-heading" className="drift-action-panel wizard-closure">
              <div>
                <p className="section-kicker">What will be restored</p>
                <h3 id="restore-closure-heading">
                  {preview.closureKeys.length} {preview.closureKeys.length === 1 ? "resource" : "resources"} in the closure
                  {" "}({preview.selected.length} selected, {preview.added.length} added)
                </h3>
              </div>

              {preview.added.length ? (
                <ul className="closure-list">
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
                    disabled={submitting || dryRunStatus === "running"}
                    onChange={(event) => setCollectorConfig(event.target.value)}
                    value={collectorConfig}
                  />
                </label>
                <label className="filter-field">
                  <span>Restorer credential config (write)</span>
                  <input
                    disabled={submitting || dryRunStatus === "running"}
                    onChange={(event) => setTargetConfig(event.target.value)}
                    value={targetConfig}
                  />
                </label>
              </div>

              <div className="drift-action-buttons">
                <button
                  aria-busy={submitting || undefined}
                  className="primary-action"
                  disabled={
                    !canRestore
                    || submitting
                    || previewing
                    || preview.guardRefusals.length > 0
                  }
                  onClick={() => void startDryRun()}
                  type="button"
                >
                  Next: start dry run
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
                Restore is a two-step promotion: a dry run computes and persists the exact
                plan — every resource result and guard outcome — then a DIFFERENT approver
                confirms that same immutable plan. There is no way to request enforcement
                directly from a selection.
              </p>
            </section>
          ) : (
            <p className="wizard-hint">
              Select the resources to restore. Anything they reference is added automatically and
              shown here before you continue.
            </p>
          )}
        </div>
      ) : null}

      {step === "dry-run" ? (
        <section aria-live="polite" className="wizard-panel wizard-running">
          <p className="section-kicker">Step 2 · Dry run</p>
          <h3>Running the dry run against the target tenant</h3>
          <div aria-hidden="true" className="progress-indeterminate"><span /></div>
          <p>This only reads; nothing is written. The plan is persisted when it completes, usually within a minute.</p>
          {dryRunJobId ? (
            <p className="selection-scope">Job <code>{dryRunJobId}</code> · checking every {DRY_RUN_POLL_MS / 1000}s</p>
          ) : null}
        </section>
      ) : null}

      {artifact ? (
        <section aria-labelledby="restore-dry-run-heading" className={`wizard-panel wizard-review review-${artifact.status}`}>
          <div>
            <p className="section-kicker">
              {artifact.status === "completed" ? "Step 3 · Review the plan" : "Step 3 · Review"}
            </p>
            <h3 id="restore-dry-run-heading">
              {artifact.status === "completed"
                ? "Ready to confirm"
                : artifact.status === "refused"
                  ? "Refused — cannot be promoted"
                  : "Failed — cannot be promoted"}
            </h3>
          </div>

          <dl className="stat-strip review-stats">
            <div><dt>Would apply</dt><dd>{artifact.results.applied.length}</dd></div>
            <div className={artifact.results.skipped.length ? "stat-warn" : undefined}><dt>Refused by guard</dt><dd>{artifact.results.skipped.length}</dd></div>
            <div className={artifact.results.failed.length ? "stat-bad" : undefined}><dt>Would fail</dt><dd>{artifact.results.failed.length}</dd></div>
            <div className={artifact.results.notRemediable.length ? "stat-warn" : undefined}><dt>Not remediable</dt><dd>{artifact.results.notRemediable.length}</dd></div>
          </dl>

          {artifact.results.applied.some((entry) => !entry.naturalKey.startsWith(EDGE_RESULT_PREFIX)) ? (
            <div>
              <p className="severity-label">PLANNED CHANGES</p>
              <ul className="closure-list">
                {artifact.results.applied.filter((entry) => !entry.naturalKey.startsWith(EDGE_RESULT_PREFIX)).map((entry) => (
                  <li key={entry.naturalKey}>
                    <code className="natural-key">{entry.naturalKey}</code>
                    {entry.reason ? ` — ${entry.reason}` : " — would apply"}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {artifact.recoveryMechanisms?.length ? (
            <RecoveryMechanismTable mechanisms={artifact.recoveryMechanisms} />
          ) : null}

          {artifact.contentEffects?.length && dryRunArtifactId ? (
            <ContentEffectsPanel
              approvals={artifact.contentEffectApprovals ?? []}
              artifactId={dryRunArtifactId}
              canApprove={canApprove}
              effects={artifact.contentEffects}
              effectsDigest={artifact.effectsDigest ?? null}
              onApproved={() => {
                void fetchDryRunArtifact(dryRunArtifactId).then((found) => { if (found) setArtifact(found); });
              }}
            />
          ) : null}

          {artifact.relationshipOperations?.length ? (
            <div>
              <p className="severity-label">MEMBERSHIP CHANGES</p>
              <ul className="closure-list edge-list">
                {artifact.relationshipOperations.map((operation) => (
                  <li
                    className={`edge-op edge-${operation.action}`}
                    key={`${operation.parentNaturalKey}|${operation.family}|${operation.action}|${operation.targetNaturalKey ?? operation.targetId}`}
                  >
                    <span className="edge-action">{operation.action === "add" ? "+ Add" : "− Remove"}</span>
                    {" "}
                    <code className="natural-key">{operation.targetNaturalKey ?? operation.targetId ?? "object created by this restore"}</code>
                    {` as ${operation.family} of `}
                    <code className="natural-key">{operation.parentNaturalKey}</code>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {artifact.guardRefusals.length ? (
            <div className="data-error" role="alert">
              <p className="severity-label">GUARD REFUSALS</p>
              <ul>
                {artifact.guardRefusals.map((guardRefusal) => (
                  <li key={guardRefusal.naturalKey}>
                    <code className="natural-key">{guardRefusal.naturalKey}</code>
                    {" — "}
                    {guardRefusal.reason}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {artifact.results.failed.length ? (
            <div className="data-error" role="alert">
              <p className="severity-label">WOULD FAIL</p>
              <ul>
                {artifact.results.failed.map((entry) => (
                  <li key={entry.naturalKey}>
                    <code className="natural-key">{entry.naturalKey}</code>
                    {entry.error ? ` — ${entry.error}` : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {artifact.status === "completed" ? (
            <div className="wizard-confirm">
              <p className="section-kicker">Step 4 · Confirm</p>
              <div className="filter-bar">
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
                  aria-busy={submitting || undefined}
                  className="danger-action"
                  disabled={!canRestore || submitting}
                  onClick={() => void confirm()}
                  type="button"
                >
                  Confirm restore
                </button>
                <button
                  className="secondary-action"
                  disabled={submitting}
                  onClick={() => resetDryRun()}
                  type="button"
                >
                  Discard
                </button>
              </div>
              <p className="selection-scope">
                Confirming creates an approval request referencing exactly this dry run,
                never a job. A different approver must approve it, and the CLI recomputes
                this plan and the target&apos;s current state once more before it writes.
              </p>
            </div>
          ) : (
            <div className="drift-action-buttons">
              <button
                className="secondary-action"
                disabled={submitting}
                onClick={() => resetDryRun()}
                type="button"
              >
                Start a new dry run
              </button>
            </div>
          )}
        </section>
      ) : null}

      {error ? <p className="action-error" role="alert">{error}</p> : null}
    </section>
  );
}
