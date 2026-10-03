"use client";

import { useEffect, useState } from "react";

import { type ContentEffect, ContentEffectsPanel } from "@/components/content-effects";
import { toast } from "@/lib/toast";

// Roadmap task-70: undo a restore. The plan is computed by the worker from the
// restore's own write journal and a fresh read of the tenant, and persisted as an
// immutable compensation dry run. Only writes that landed are undone; an object
// changed again since the restore wrote it is left alone and listed; what cannot
// be undone is listed too. Executing the undo needs the same confirmation and
// approval as any restore — this panel only requests it.
export interface CompensationPlan {
  compensates: string;
  atomic: false;
  statement: string;
  operations: { naturalKey: string; resourceType: string; verb: "update" | "delete"; undoes: string; revertedFields?: string[] }[];
  conflicts: { naturalKey: string; reason: string }[];
  notApplied: { naturalKey: string; reason: string }[];
  manual: { naturalKey: string; reason: string }[];
  irrecoverable: { naturalKey: string; effect: string; field: string; reason: string }[];
}

interface CompensationArtifact {
  id: string;
  status: "completed" | "refused" | "failed";
  compensation: CompensationPlan | null;
  guardRefusals?: { naturalKey: string; reason: string }[];
  contentEffects?: ContentEffect[] | null;
  effectsDigest?: string | null;
  contentEffectApprovals?: { approvedBy: string; approvedAt: string | null }[];
}

const STATUS_TONES: Record<CompensationArtifact["status"], string> = { completed: "ok", refused: "warn", failed: "bad" };
const STATUS_LABELS: Record<CompensationArtifact["status"], string> = {
  completed: "Ready for approval",
  refused: "Refused by a guard",
  failed: "Planning failed",
};

function operationLabel(op: CompensationPlan["operations"][number]): string {
  if (op.verb === "delete") return op.undoes === "restore-soft-deleted" ? "Delete again (return to deleted items)" : "Delete the object this restore created";
  return `Revert ${(op.revertedFields ?? []).join(", ") || "changed fields"}`;
}

function Section({ title, tone, items }: { title: string; tone: string; items: { naturalKey: string; text: string }[] }) {
  if (items.length === 0) return null;
  return (
    <section className="compensation-section">
      <p className="severity-label">{title}</p>
      <ul className="compensation-list">
        {items.map((item, index) => (
          <li className={`compensation-item compensation-${tone}`} key={`${item.naturalKey}-${index}`}>
            <code className="natural-key">{item.naturalKey}</code>
            <span className="compensation-text">{item.text}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function CompensationPlanView({ plan }: { plan: CompensationPlan }) {
  return (
    <div className="compensation-plan">
      <p className="compensation-statement">{plan.statement}</p>
      <Section items={plan.operations.map((op) => ({ naturalKey: op.naturalKey, text: operationLabel(op) }))} title="WILL BE UNDONE" tone="ok" />
      <Section items={plan.conflicts.map((item) => ({ naturalKey: item.naturalKey, text: item.reason }))} title="CHANGED SINCE · NOT OVERWRITTEN" tone="warn" />
      <Section items={plan.irrecoverable.map((item) => ({ naturalKey: item.naturalKey, text: item.reason }))} title="CANNOT BE UNDONE" tone="bad" />
      <Section items={plan.manual.map((item) => ({ naturalKey: item.naturalKey, text: item.reason }))} title="NEEDS MANUAL REVIEW" tone="warn" />
      <Section items={plan.notApplied.map((item) => ({ naturalKey: item.naturalKey, text: item.reason }))} title="NOTHING TO UNDO" tone="neutral" />
    </div>
  );
}

interface PanelProps {
  restoreArtifactId: string;
  compensationArtifactId?: string | null;
  failed: boolean;
  canRestore: boolean;
  canApprove: boolean;
}

export function CompensationPanel({ restoreArtifactId, compensationArtifactId = null, failed, canRestore, canApprove }: PanelProps) {
  const [artifactId, setArtifactId] = useState<string | null>(compensationArtifactId);
  const [artifact, setArtifact] = useState<CompensationArtifact | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [justification, setJustification] = useState("");
  const [requested, setRequested] = useState(false);

  async function load(id: string): Promise<boolean> {
    const response = await fetch(`/api/actions/restore/dry-run/${encodeURIComponent(id)}`, { cache: "no-store" });
    if (response.status === 404) return false; // the worker has not persisted it yet
    if (!response.ok) throw new Error(String(response.status));
    setArtifact(((await response.json()) as { artifact: CompensationArtifact }).artifact);
    return true;
  }

  useEffect(() => {
    if (!artifactId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async (attempt: number) => {
      try {
        if (await load(artifactId) || cancelled) return;
        if (attempt >= 60) throw new Error("timeout");
        timer = setTimeout(() => void poll(attempt + 1), 2000);
      } catch {
        if (!cancelled) setError(true);
      }
    };
    void poll(0);
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artifactId]);

  async function planUndo() {
    setBusy(true);
    try {
      const response = await fetch("/api/actions/restore/compensate", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": `compensate:${restoreArtifactId}:${Date.now()}` },
        body: JSON.stringify({ restoreArtifactId }),
      });
      const payload = (await response.json().catch(() => ({}))) as { artifactId?: string; message?: string };
      if (!response.ok || !payload.artifactId) {
        toast({ tone: "warning", title: "Undo not planned", detail: payload.message ?? `Request failed (${response.status})` });
        return;
      }
      setError(false);
      setArtifact(null);
      setArtifactId(payload.artifactId);
    } finally {
      setBusy(false);
    }
  }

  async function requestApproval() {
    if (!artifact) return;
    setBusy(true);
    try {
      const response = await fetch("/api/actions/restore", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": `restore:${artifact.id}` },
        body: JSON.stringify({ artifactId: artifact.id, justification }),
      });
      const payload = (await response.json().catch(() => ({}))) as { message?: string };
      if (!response.ok) {
        toast({ tone: "warning", title: "Approval not requested", detail: payload.message ?? `Request failed (${response.status})` });
        return;
      }
      setRequested(true);
      toast({ title: "Undo sent for approval", detail: "Another approver must confirm exactly this plan before anything is written." });
    } finally {
      setBusy(false);
    }
  }

  const compensation = artifact?.compensation ?? null;
  const executable = artifact?.status === "completed" && (compensation?.operations.length ?? 0) > 0;
  return (
    <section aria-labelledby="compensation-heading" className="panel compensation-panel">
      <div className="section-head">
        <p className="section-kicker">Undo</p>
        <h2 id="compensation-heading">{failed ? "Undo what this failed restore changed" : "Undo this restore"}</h2>
      </div>
      {!artifactId ? (
        <div className="compensation-intro">
          <p>
            {failed ? "This restore stopped partway. " : ""}
            Planning an undo re-reads the tenant and reverses only the writes this restore actually made.
            Anything changed since is left alone and listed. Nothing is written until the plan is approved.
          </p>
          {canRestore ? (
            <button aria-busy={busy || undefined} className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void planUndo()} type="button">
              Plan undo
            </button>
          ) : null}
        </div>
      ) : error ? (
        <p className="data-error" role="alert">The undo plan is unavailable right now.</p>
      ) : !artifact ? (
        <p aria-live="polite" className="muted-value">Planning the undo against the live tenant…</p>
      ) : (
        <>
          <p className="compensation-status">
            <span className={`pill pill-${STATUS_TONES[artifact.status]}`}>{STATUS_LABELS[artifact.status]}</span>
          </p>
          {artifact.guardRefusals?.length ? (
            <Section items={artifact.guardRefusals.map((item) => ({ naturalKey: item.naturalKey, text: item.reason }))} title="REFUSED BY A GUARD" tone="bad" />
          ) : null}
          {artifact.contentEffects?.length ? (
            <ContentEffectsPanel
              approvals={artifact.contentEffectApprovals ?? []}
              artifactId={artifact.id}
              canApprove={canApprove}
              effects={artifact.contentEffects}
              effectsDigest={artifact.effectsDigest ?? null}
              onApproved={() => void load(artifact.id)}
            />
          ) : null}
          {compensation ? <CompensationPlanView plan={compensation} /> : null}
          {executable && canRestore ? (
            requested ? (
              <p className="compensation-requested">Sent for approval. Track it under Approvals.</p>
            ) : (
              <div className="compensation-confirm">
                <label className="filter-field">
                  <span>Why undo this restore?</span>
                  <input onChange={(event) => setJustification(event.target.value)} placeholder="Reason for the approver" value={justification} />
                </label>
                <button
                  aria-busy={busy || undefined}
                  className="btn btn-primary btn-sm"
                  disabled={busy || justification.trim().length === 0}
                  onClick={() => void requestApproval()}
                  type="button"
                >
                  Request approval to undo
                </button>
              </div>
            )
          ) : null}
        </>
      )}
    </section>
  );
}
