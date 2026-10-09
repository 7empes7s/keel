"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { postAction } from "@/lib/action-client";
import { RecoveryMechanismTable, type RecoveryMechanism } from "@/components/recovery-mechanism";
import { ContentEffectsPanel, type ContentEffect } from "@/components/content-effects";
import { IncidentQualificationSummary, type IncidentRecoveryView } from "@/components/incident-recovery";
import { PendingSteps, type PendingStep } from "@/components/pending-steps";
import { RecordField, TechnicalDetails } from "@/components/technical-details";
import { Verdict, type VerdictTone } from "@/components/verdict";
import { toast } from "@/lib/toast";
import { refusalSentence, resourceName } from "@/lib/changes-view";
import type { RestoreResource } from "@/lib/portal-data";
import type { SnapshotOption } from "@/lib/portal-jobs";
import { displayEnum, formatTimestamp, resourceLabel } from "@/lib/presentation";
import { typeName } from "@/lib/protect-view";

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
  // Roadmap task-152: steps the restore cannot finish itself (a policy left report-only).
  pendingSteps?: PendingStep[];
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
  // Roadmap task-71: the incident recovery context the dry run was planned under.
  incidentRecovery?: Parameters<typeof IncidentQualificationSummary>[0]["context"] | null;
  incidentRecoveryView?: IncidentRecoveryView | null;
}

const EDGE_RESULT_PREFIX = "edge:";

function describeSnapshot(snapshot: SnapshotOption): string {
  const captured = formatTimestamp(snapshot.completedAt ?? snapshot.startedAt);
  return `${captured} — ${snapshot.resourceCount.toLocaleString("en-GB")} resources`;
}

// The raw reasons (requiring key and field path), for the record layer.
function formatReasons(reasons: AdditionReason[]): string {
  return reasons
    .map((reason) => `${reason.requiredBy} at ${reason.field}`)
    .join("; ");
}

/** "Block legacy auth (Conditional Access policy)", the resources that need this one. */
function requiredByWords(reasons: AdditionReason[]): string {
  return [...new Set(reasons.map((reason) => resourceLabel(reason.requiredBy)))].join(", ");
}

/** "Block legacy auth and Require MFA for admins". */
function namesList(keys: string[]): string {
  const names = keys.map((key) => resourceLabel(key));
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
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

// Roadmap task-131: the current step's title is the page's verdict sentence.
export function restoreStepVerdict(step: RestoreStep, failed: boolean): { text: string; tone: VerdictTone } {
  switch (step) {
    case "select": return { text: "Step 1 of 5: choose what to put back.", tone: "good" };
    case "dry-run": return { text: "Step 2 of 5: KEEL is working out what would change. Nothing is written.", tone: "good" };
    case "review": return failed
      ? { text: "Step 3 of 5: the dry run found problems, so nothing can be restored from it.", tone: "critical" }
      : { text: "Step 3 of 5: review what will change.", tone: "good" };
    case "confirm": return { text: "Step 4 of 5: review what will change, then confirm.", tone: "attention" };
    case "track": return { text: "Step 5 of 5: sent to approvers. Nothing changes until one of them approves.", tone: "good" };
  }
}

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
  incident = null,
}: {
  canRestore: boolean;
  canApprove?: boolean;
  resources: RestoreResource[];
  snapshotId: string;
  snapshots: SnapshotOption[];
  // Roadmap task-71: plan this restore as a recovery point of an incident.
  incident?: { id: string; title: string } | null;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [resourceType, setResourceType] = useState("all");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string[]>([]);
  const [preview, setPreview] = useState<SelectionPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
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
      setError("KEEL could not work out what this selection depends on. The selection was not changed.");
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
          `${resourceLabel(key)} stays selected because ${requiredByWords(missing.reasons)} ${missing.reasons.length === 1 ? "depends" : "depend"} on it. Deselect ${missing.reasons.length === 1 ? "that" : "those"} first.`,
        );
        return;
      }
      setSelected(candidate);
      setPreview(candidatePreview);
      resetDryRun();
    } catch {
      setError("KEEL could not work out what this selection depends on. The selection was not changed.");
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
          setError("The dry run did not finish. Adjust the selection and try again.");
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
          ...(incident ? { incidentId: incident.id } : {}),
        },
        idempotencyKey,
      );
      const job = payload.job as { id: string };
      const artifactId = payload.artifactId as string;
      if (!job || typeof job.id !== "string" || typeof artifactId !== "string") {
        setError("KEEL could not start the dry run. Try again in a minute.");
        return;
      }
      setIdempotencyKey(crypto.randomUUID());
      setDryRunJobId(job.id);
      setDryRunArtifactId(artifactId);
      setDryRunStatus("running");
      pollDryRun(job.id, artifactId);
    } catch {
      setError("KEEL could not start the dry run. Try again in a minute.");
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
        setMessage("Sent to approvers. Nothing changes until one of them approves.");
        setIdempotencyKey(crypto.randomUUID());
        resetDryRun();
        toast({ tone: "info", title: "Sent to approvers", detail: "Nothing changes until one of them approves.", href: "/approvals", hrefLabel: "Open approvals" });
        router.refresh();
      } else {
        setError("KEEL could not send the restore for approval. Try again in a minute.");
      }
    } catch {
      setError("KEEL could not send the restore for approval. Try again in a minute.");
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
  const reviewFailed = artifact !== null && artifact.status !== "completed";
  const verdict = restoreStepVerdict(step, reviewFailed);
  const objectResults = (entries: DryRunResourceResult[]) => entries.filter((entry) => !entry.naturalKey.startsWith(EDGE_RESULT_PREFIX));

  return (
    <section aria-labelledby="restore-selection-heading" className="report-section restore-wizard">
      <Verdict text={verdict.text} tone={verdict.tone} />
      <div data-layer="explanation">
      <div className="section-heading-row report-heading">
        <div>
          <p className="section-kicker">From a snapshot</p>
          <h2 id="restore-selection-heading">Plan a restore</h2>
        </div>
        <span aria-live="polite" className="result-count">
          {closureSize ? `${closureSize} to restore` : `${resources.length} available`}
        </span>
      </div>

      <RestoreStepper current={step} failed={reviewFailed} />

      {step === "track" ? (
        <section aria-labelledby="restore-track-heading" className="wizard-panel wizard-track">
          <h3 id="restore-track-heading">Sent to approvers</h3>
          <p aria-live="polite">{message}</p>
          <ol className="track-timeline">
            <li className="track-done">Dry run finished</li>
            <li className="track-done">Approval requested</li>
            <li className="track-current">Another person reviews this same plan</li>
            <li>KEEL checks the tenant again, then restores; the job appears below</li>
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
            <p className="section-kicker">What you chose</p>
            <p>
              {preview ? namesList(preview.selected) : `${closureSize} resources`}
              {preview && preview.added.length ? " and everything it depends on" : null}
              {currentSnapshot ? `, from the snapshot of ${formatTimestamp(currentSnapshot.completedAt ?? currentSnapshot.startedAt)}` : null}
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

      {incident ? (
        <p className="incident-restore-banner" role="note">
          Restoring for the incident <strong>{incident.title}</strong>. KEEL refuses unless an investigator cleared this
          snapshot or approved an override, and checks afterwards that the malicious items are gone.
        </p>
      ) : null}

      {step === "select" ? (
        <div className="wizard-panel">
          <div className="filter-bar">
            <label className="filter-field">
              <span>Snapshot</span>
              <select
                disabled={submitting}
                onChange={(event) => router.push(`/restore?snapshot=${event.target.value}${incident ? `&incident=${incident.id}` : ""}`)}
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
              <span>Find a resource</span>
              <input
                onChange={(event) => {
                  setQuery(event.target.value);
                  setPage(1);
                }}
                placeholder="Name"
                type="search"
                value={query}
              />
            </label>
            <label className="filter-field">
              <span>Type</span>
              <select
                onChange={(event) => {
                  setResourceType(event.target.value);
                  setPage(1);
                }}
                value={resourceType}
              >
                <option value="all">All types</option>
                {resourceTypes.map((type) => (
                  <option key={type} value={type}>{typeName(type)}</option>
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
                      <th scope="col">Resource</th>
                      <th scope="col">Type</th>
                      <th scope="col">Impact</th>
                      <th scope="col">Status</th>
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
                              aria-label={`Select ${resourceLabel(resource.naturalKey)}`}
                              checked={isSelected}
                              disabled={!canRestore || previewing || submitting}
                              onChange={() => void toggle(resource.naturalKey)}
                              type="checkbox"
                            />
                          </td>
                          <th data-label="Resource" scope="row">
                            <span className="resource-name">{resourceName(resource.naturalKey)}</span>
                          </th>
                          <td data-label="Type">
                            <span className="resource-type">{typeName(resource.resourceType)}</span>
                          </td>
                          <td data-label="Impact">{displayEnum("blastRadius", resource.blastRadius)}</td>
                          <td data-label="Status">
                            {isSelected ? <span className="selection-chip chip-selected">Selected</span> : null}
                            {isAdded && addition ? (
                              <span className="selection-chip chip-added">
                                Added: {requiredByWords(addition.reasons)} {addition.reasons.length === 1 ? "depends" : "depend"} on it
                              </span>
                            ) : null}
                            {isRefused ? (
                              <span className="selection-chip chip-refused">Refused: synced from on-premises</span>
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
                : "This snapshot has nothing KEEL can restore."}
            </p>
          )}

          {refusal ? <p className="action-error" role="alert">{refusal}</p> : null}

          {preview && preview.closureKeys.length > 0 ? (
            <section aria-labelledby="restore-closure-heading" className="drift-action-panel wizard-closure">
              <div>
                <p className="section-kicker">What will be restored</p>
                <h3 id="restore-closure-heading">
                  {namesList(preview.selected)}{preview.added.length ? " and everything it depends on" : ""}
                </h3>
              </div>

              {preview.added.length ? (
                <ul className="closure-list">
                  {preview.added.map((addition) => (
                    <li key={addition.naturalKey}>
                      <strong>{resourceLabel(addition.naturalKey)}</strong>
                      {", because "}
                      {requiredByWords(addition.reasons)} {addition.reasons.length === 1 ? "depends" : "depend"} on it
                    </li>
                  ))}
                </ul>
              ) : (
                <p>Nothing else is needed: what you chose depends on nothing outside it.</p>
              )}

              {preview.unresolvedReferences.length ? (
                <div className="data-error" role="alert">
                  <p className="severity-label">Missing from this snapshot</p>
                  <ul>
                    {preview.unresolvedReferences.map((reference) => (
                      <li key={`${reference.from}:${reference.field}`}>
                        {resourceLabel(reference.from)} refers to something this snapshot does not hold; the restore
                        fails unless it already exists in the tenant.
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {preview.guardRefusals.length ? (
                <div className="data-error" role="alert">
                  <p className="severity-label">Cannot restore</p>
                  <ul>
                    {preview.guardRefusals.map((guardRefusal) => (
                      <li key={guardRefusal.naturalKey}>{refusalSentence(guardRefusal)}</li>
                    ))}
                  </ul>
                  <p>Remove these from the selection before you continue.</p>
                </div>
              ) : null}

              <TechnicalDetails>
                <RecordField copy={false} label="Selected keys" value={preview.selected.join(", ")} />
                <RecordField copy={false} label="Closure keys" value={preview.closureKeys.join(", ")} />
                {preview.added.map((addition) => (
                  <RecordField copy={false} key={addition.naturalKey} label={`Added · ${addition.naturalKey}`} value={`required by ${formatReasons(addition.reasons)}`} />
                ))}
                {preview.unresolvedReferences.map((reference) => (
                  <RecordField copy={false} key={`${reference.from}:${reference.field}`} label={`Unresolved · ${reference.from}`} value={`${reference.field} → ${reference.symbol}`} />
                ))}
                {preview.guardRefusals.map((guardRefusal) => (
                  <RecordField copy={false} key={guardRefusal.naturalKey} label={`Guard refusal · ${guardRefusal.naturalKey}`} value={guardRefusal.reason} />
                ))}
                <RecordField label="Snapshot ID" value={snapshotId} />
              </TechnicalDetails>

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
                The dry run works out exactly what would change. Nothing is written until someone else approves.
              </p>
            </section>
          ) : (
            <p className="wizard-hint">
              Select the resources to restore. Anything they depend on is added for you and
              shown here before you continue.
            </p>
          )}
        </div>
      ) : null}

      {step === "dry-run" ? (
        <section aria-live="polite" className="wizard-panel wizard-running">
          <h3>Working out what would change</h3>
          <div aria-hidden="true" className="progress-indeterminate"><span /></div>
          <p>This only reads your tenant; nothing is written. It usually takes under a minute.</p>
          {dryRunJobId ? (
            <TechnicalDetails>
              <RecordField label="Job ID" value={dryRunJobId} usage={<code>GET /api/jobs/{dryRunJobId}</code>} />
              {dryRunArtifactId ? <RecordField label="Dry run ID" value={dryRunArtifactId} usage={<code>GET /api/actions/restore/dry-run/{dryRunArtifactId}</code>} /> : null}
              <RecordField copy={false} label="Polling" value={`every ${DRY_RUN_POLL_MS / 1000}s`} />
            </TechnicalDetails>
          ) : null}
        </section>
      ) : null}

      {artifact ? (
        <section aria-labelledby="restore-dry-run-heading" className={`wizard-panel wizard-review review-${artifact.status}`}>
          <div>
            <h3 id="restore-dry-run-heading">
              {artifact.status === "completed"
                ? "Ready to confirm"
                : artifact.status === "refused"
                  ? "KEEL refused this plan; it cannot be restored"
                  : "The dry run failed; it cannot be restored"}
            </h3>
          </div>

          <dl className="stat-strip review-stats">
            <div><dt>Would restore</dt><dd>{objectResults(artifact.results.applied).length}</dd></div>
            <div className={artifact.results.skipped.length ? "stat-warn" : undefined}><dt>Refused</dt><dd>{artifact.results.skipped.length}</dd></div>
            <div className={artifact.results.failed.length ? "stat-bad" : undefined}><dt>Would fail</dt><dd>{artifact.results.failed.length}</dd></div>
            <div className={artifact.results.notRemediable.length ? "stat-warn" : undefined}><dt>Needs doing by hand</dt><dd>{artifact.results.notRemediable.length}</dd></div>
          </dl>

          {artifact.incidentRecovery ? <IncidentQualificationSummary context={artifact.incidentRecovery} view={artifact.incidentRecoveryView ?? null} /> : null}

          {/* Content effects gate the restore, so they lead the review. */}
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

          {objectResults(artifact.results.applied).length ? (
            <div>
              <p className="severity-label">What will change</p>
              <ul className="closure-list">
                {objectResults(artifact.results.applied).map((entry) => (
                  <li key={entry.naturalKey}>
                    <strong>{resourceLabel(entry.naturalKey)}</strong>
                    {entry.reason ? `: ${entry.reason}` : ": will be restored"}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <PendingSteps steps={artifact.results.pendingSteps} />

          {artifact.recoveryMechanisms?.length ? (
            <RecoveryMechanismTable mechanisms={artifact.recoveryMechanisms} />
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
                    <strong>{operation.targetNaturalKey ? resourceLabel(operation.targetNaturalKey) : "an object this restore creates"}</strong>
                    {` as ${operation.family} of `}
                    <strong>{resourceLabel(operation.parentNaturalKey)}</strong>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {artifact.guardRefusals.length ? (
            <div className="data-error" role="alert">
              <p className="severity-label">Cannot restore</p>
              <ul>
                {artifact.guardRefusals.map((guardRefusal) => (
                  <li key={guardRefusal.naturalKey}>{refusalSentence(guardRefusal)}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {artifact.results.failed.length ? (
            <div className="data-error" role="alert">
              <p className="severity-label">Would fail</p>
              <ul>
                {artifact.results.failed.map((entry) => (
                  <li key={entry.naturalKey}>
                    <strong>{resourceLabel(entry.naturalKey)}</strong> would fail; the error is in Technical details.
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <TechnicalDetails>
            <RecordField label="Dry run ID" value={artifact.id} usage={<code>GET /api/actions/restore/dry-run/{artifact.id}</code>} />
            {dryRunJobId ? <RecordField label="Dry run job ID" value={dryRunJobId} usage={<code>GET /api/jobs/{dryRunJobId}</code>} /> : null}
            <RecordField copy={false} label="Status" value={artifact.status} />
            <RecordField copy={false} label="Closure keys" value={artifact.closureKeys.join(", ")} />
            {artifact.effectsDigest ? <RecordField label="Effects digest" value={artifact.effectsDigest} /> : null}
            {artifact.results.applied.map((entry) => (
              <RecordField copy={false} key={`applied-${entry.naturalKey}`} label={`Would apply · ${entry.naturalKey}`} value={entry.reason ?? "would apply"} />
            ))}
            {artifact.results.skipped.map((entry) => (
              <RecordField copy={false} key={`skipped-${entry.naturalKey}`} label={`Refused · ${entry.naturalKey}`} value={entry.reason ?? entry.error ?? "refused"} />
            ))}
            {artifact.results.failed.map((entry) => (
              <RecordField copy={false} key={`failed-${entry.naturalKey}`} label={`Would fail · ${entry.naturalKey}`} value={entry.error ?? entry.reason ?? "failed"} />
            ))}
            {artifact.results.notRemediable.map((entry) => (
              <RecordField copy={false} key={`manual-${entry.naturalKey}`} label={`Not remediable · ${entry.naturalKey}`} value={entry.reason ?? entry.error ?? "not remediable"} />
            ))}
            {artifact.guardRefusals.map((guardRefusal) => (
              <RecordField copy={false} key={`guard-${guardRefusal.naturalKey}`} label={`Guard refusal · ${guardRefusal.naturalKey}`} value={guardRefusal.reason} />
            ))}
            {(artifact.relationshipOperations ?? []).map((operation) => (
              <RecordField copy={false} key={`edge-${operation.parentNaturalKey}|${operation.action}|${operation.targetNaturalKey ?? operation.targetId}`}
                label={`Edge · ${operation.parentNaturalKey}`} value={`${operation.action} ${operation.family} ${operation.targetNaturalKey ?? operation.targetId ?? "created object"}`} />
            ))}
          </TechnicalDetails>

          {artifact.status === "completed" ? (
            <div className="wizard-confirm">
              <div className="filter-bar">
                <label className="filter-field">
                  <span>Why</span>
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
                This goes to approvers next. Someone other than you approves exactly this plan, and KEEL
                checks the tenant again before it writes.
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
      </div>
    </section>
  );
}
