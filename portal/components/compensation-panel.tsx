"use client";

import { useEffect, useState } from "react";

import { type ContentEffect, ContentEffectsPanel } from "@/components/content-effects";
import { RecordField, TechnicalDetails } from "@/components/technical-details";
import { refusalSentence } from "@/lib/changes-view";
import { toast } from "@/lib/toast";
import {
  UNDO_STATEMENT,
  conflictSentence,
  fieldList,
  irrecoverableSentence,
  manualSentence,
  notAppliedSentence,
  undoSubject,
} from "@/lib/undo-view";

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
  refused: "Refused by a safety check",
  failed: "Planning failed",
};

function operationLabel(op: CompensationPlan["operations"][number]): string {
  if (op.verb === "delete") return op.undoes === "restore-soft-deleted" ? "Delete again (return to deleted items)" : "Delete the object this restore created";
  return `Revert ${fieldList(op.revertedFields ?? []) || "changed fields"}`;
}

function Section({ title, tone, items }: { title: string; tone: string; items: { naturalKey: string; text: string }[] }) {
  if (items.length === 0) return null;
  return (
    <section className="compensation-section">
      <p className="severity-label">{title}</p>
      <ul className="compensation-list">
        {items.map((item, index) => (
          <li className={`compensation-item compensation-${tone}`} key={`${item.naturalKey}-${index}`}>
            <strong className="resource-name">{undoSubject(item.naturalKey)}</strong>
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
      <p className="compensation-statement">{UNDO_STATEMENT}</p>
      <Section items={plan.operations.map((op) => ({ naturalKey: op.naturalKey, text: operationLabel(op) }))} title="WILL BE UNDONE" tone="ok" />
      <Section items={plan.conflicts.map((item) => ({ naturalKey: item.naturalKey, text: conflictSentence(item.reason) }))} title="CHANGED SINCE · NOT OVERWRITTEN" tone="warn" />
      <Section items={plan.irrecoverable.map((item) => ({ naturalKey: item.naturalKey, text: irrecoverableSentence(item) }))} title="CANNOT BE UNDONE" tone="bad" />
      <Section items={plan.manual.map((item) => ({ naturalKey: item.naturalKey, text: manualSentence(item.reason) }))} title="NEEDS MANUAL REVIEW" tone="warn" />
      <Section items={plan.notApplied.map((item) => ({ naturalKey: item.naturalKey, text: notAppliedSentence(item.reason) }))} title="NOTHING TO UNDO" tone="neutral" />
      <TechnicalDetails>
        <RecordField label="Undoes restore plan" value={plan.compensates} usage={<code>GET /api/actions/restore/dry-run/{plan.compensates}</code>} />
        <RecordField copy={false} label="Statement" value={plan.statement} />
        {plan.operations.map((op, index) => (
          <RecordField copy={false} key={`op-${index}`} label={`Will undo · ${op.naturalKey}`}
            value={`${op.verb} (undoes ${op.undoes})${op.revertedFields?.length ? ` · fields ${op.revertedFields.join(", ")}` : ""}`} />
        ))}
        {plan.conflicts.map((item, index) => <RecordField copy={false} key={`conflict-${index}`} label={`Not overwritten · ${item.naturalKey}`} value={item.reason} />)}
        {plan.irrecoverable.map((item, index) => <RecordField copy={false} key={`lost-${index}`} label={`Cannot be undone · ${item.naturalKey}`} value={`${item.effect} · ${item.field} · ${item.reason}`} />)}
        {plan.manual.map((item, index) => <RecordField copy={false} key={`manual-${index}`} label={`Manual review · ${item.naturalKey}`} value={item.reason} />)}
        {plan.notApplied.map((item, index) => <RecordField copy={false} key={`skip-${index}`} label={`Nothing to undo · ${item.naturalKey}`} value={item.reason} />)}
      </TechnicalDetails>
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
      toast({ title: "Sent to approvers", detail: "Nothing changes until one of them approves." });
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
          <TechnicalDetails summary="Technical details for this undo plan">
            <RecordField label="Undo plan ID" value={artifact.id} usage={<code>GET /api/actions/restore/dry-run/{artifact.id}</code>} />
            <RecordField copy={false} label="Status" value={artifact.status} />
            {artifact.effectsDigest ? <RecordField label="Effects digest" value={artifact.effectsDigest} /> : null}
          </TechnicalDetails>
          {artifact.guardRefusals?.length ? (
            <>
              <Section items={artifact.guardRefusals.map((item) => ({ naturalKey: item.naturalKey, text: refusalSentence(item) }))} title="REFUSED BY A SAFETY CHECK" tone="bad" />
              <TechnicalDetails summary="Technical details for the refusals">
                {artifact.guardRefusals.map((item, index) => <RecordField copy={false} key={index} label={`Guard refusal · ${item.naturalKey}`} value={item.reason} />)}
              </TechnicalDetails>
            </>
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
              <p className="compensation-requested">Sent to approvers. Nothing changes until one of them approves.</p>
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
