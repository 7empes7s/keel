"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import { ContentEffectsPanel, type ContentEffect } from "@/components/content-effects";
import { RestorePoint } from "@/components/restore/restore-point";
import { RestoreStepper } from "@/components/restore-selection";
import { RecordField, TechnicalDetails } from "@/components/technical-details";
import { postAction } from "@/lib/action-client";
import { fieldWords, valueWords } from "@/lib/changes-view";
import { toast } from "@/lib/toast";
import { plural } from "@/lib/restore-view";
import {
  backupPointWords,
  choiceChangeWords,
  type WorkloadChoiceGroup,
  type WorkloadChoices,
} from "@/lib/restore-workloads-view";
import type { SnapshotOption } from "@/lib/portal-jobs";

// One service's restore from the Restore page (Exchange, Teams, Purview): the same
// steps as Entra ID and Intune. Choose objects from a backup, KEEL checks what would
// change (a dry run, nothing written), review, then send for approval.

const POLL_MS = 3000;

interface FieldChange { field: string; before: unknown; after: unknown }
interface WorkloadPlan {
  operations: { resourceKey: string; kind?: string; changes: FieldChange[] }[];
  manual: { resourceKey: string; field: string | null; reason: string; before?: unknown; after?: unknown }[];
  refusals: { naturalKey: string; reason: string }[];
}
interface WorkloadArtifact {
  id: string;
  status: string;
  guardRefusals: { naturalKey: string; reason: string }[];
  workloadRestore: WorkloadPlan | null;
  contentEffects?: ContentEffect[] | null;
  effectsDigest?: string | null;
  contentEffectApprovals?: { approvedBy: string; approvedAt: string | null }[];
}

type Step = "select" | "dry-run" | "review" | "track";

async function fetchChoices(workload: string, collectionId: string | null): Promise<WorkloadChoices> {
  const query = new URLSearchParams({ workload, ...(collectionId ? { collection: collectionId } : {}) });
  const response = await fetch(`/api/actions/restore/workload?${query}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`choices failed (${response.status})`);
  return ((await response.json()) as { choices: WorkloadChoices }).choices;
}

async function fetchJobStatus(jobId: string): Promise<string | null> {
  const response = await fetch(`/api/jobs/${jobId}`, { cache: "no-store" });
  if (!response.ok) return null;
  return ((await response.json()) as { job: { status: string } }).job.status;
}

async function fetchArtifact(artifactId: string): Promise<WorkloadArtifact | null> {
  const response = await fetch(`/api/actions/restore/dry-run/${artifactId}`, { cache: "no-store" });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`dry-run fetch failed (${response.status})`);
  return ((await response.json()) as { artifact: WorkloadArtifact }).artifact;
}

// Exchange rule modes, in plain words (the shared vocabulary avoids "enforce").
const MODE_WORDS: Record<string, string> = { Enforce: "On", Audit: "Test only", AuditAndNotify: "Test only, with tips" };

/** A setting's value as a person reads it. */
export function settingValueWords(field: string, value: unknown): string {
  if (field === "Mode" && typeof value === "string" && MODE_WORDS[value]) return MODE_WORDS[value];
  if (Array.isArray(value)) return value.length ? value.map((entry) => settingValueWords(field, entry)).join(", ") : "empty";
  return valueWords(value);
}

/** Why KEEL will not write one object, in plain words; the raw reason stays in Technical details. */
export function refusalWords(reason: string): string {
  if (reason.startsWith("not-a-fixture")) return "On the test tenant KEEL only writes KEEL-RT test settings, and never one that affects the whole tenant.";
  if (reason.startsWith("preservation-locked")) return "A preservation lock protects it, so KEEL never changes it.";
  return "KEEL refused to change it. The reason is in Technical details.";
}

const sentence = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}${/[.!?]$/.test(text) ? "" : "."}`;

/** The engine's reason a difference is left to a person, without cmdlet words. */
export function manualWords(reason: string): string {
  if (/Enable-\/Disable-/.test(reason)) return "Turning it on or off is a separate step an admin takes in the admin center.";
  return sentence(reason.replace(/\ban administrator\b/g, "an admin"));
}

export function WorkloadRestore({ workload, name, canRestore, canApprove, now, onClose }: {
  workload: string;
  name: string;
  canRestore: boolean;
  canApprove: boolean;
  now: string;
  onClose: () => void;
}) {
  const [choices, setChoices] = useState<WorkloadChoices | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [step, setStep] = useState<Step>("select");
  const [jobId, setJobId] = useState<string | null>(null);
  const [artifactId, setArtifactId] = useState<string | null>(null);
  const [artifact, setArtifact] = useState<WorkloadArtifact | null>(null);
  const [justification, setJustification] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const headingId = `workload-restore-${workload}`;

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  // The steps open below the cards: bring them into view and move focus to them.
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.scrollIntoView?.({ block: "start", behavior: "smooth" });
    headingRef.current?.focus({ preventScroll: true });
  }, [step]);

  async function load(collectionId: string | null) {
    setLoading(true);
    setError(null);
    try {
      const found = await fetchChoices(workload, collectionId);
      setChoices(found);
      // Start with what changed since: the likely thing to put back.
      setSelected(new Set(found.groups.flatMap((group) => group.items.filter((item) => item.restorable && item.change === "changed").map((item) => item.key))));
    } catch {
      setError("KEEL could not read this backup. Reload in a minute.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(null); }, [workload]); // eslint-disable-line react-hooks/exhaustive-deps

  const snapshots = useMemo<SnapshotOption[]>(() => (choices?.backups ?? []).map((backup) => ({
    id: backup.collectionId, startedAt: backup.takenAt, completedAt: backup.takenAt, resourceCount: backup.items,
  })), [choices]);
  const names = useMemo(() => new Map((choices?.groups ?? []).flatMap((group) => group.items.map((item) => [item.key, item.name] as const))), [choices]);
  const nameOf = (key: string) => names.get(key.replace(/^[^:]+:(?=[^:]+:)/, "")) ?? names.get(key) ?? "a setting";

  function toggle(key: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  function toggleGroup(group: WorkloadChoiceGroup) {
    const keys = group.items.filter((item) => item.restorable).map((item) => item.key);
    setSelected((current) => {
      const all = keys.every((key) => current.has(key));
      const next = new Set(current);
      for (const key of keys) { if (all) next.delete(key); else next.add(key); }
      return next;
    });
  }

  function poll(job: string, id: string) {
    timer.current = setTimeout(async () => {
      try {
        const status = await fetchJobStatus(job);
        if (status === "failed" || status === "cancelled") {
          setStep("select");
          setError("The check did not finish, so nothing was planned. Try again in a minute.");
          return;
        }
        if (status === "succeeded") {
          const found = await fetchArtifact(id);
          if (found) { setArtifact(found); setStep("review"); return; }
        }
        poll(job, id);
      } catch {
        poll(job, id);
      }
    }, POLL_MS);
  }

  async function check() {
    if (!choices || selected.size === 0 || !canRestore) return;
    setBusy(true);
    setError(null);
    try {
      const { payload } = await postAction(
        "/api/actions/restore/workload/dry-run",
        { workload, collectionId: choices.chosen.collectionId, targets: [...selected] },
        idempotencyKey,
      );
      const job = payload.job as { id?: string } | undefined;
      const id = payload.artifactId;
      if (!job?.id || typeof id !== "string") throw new Error("no job");
      setIdempotencyKey(crypto.randomUUID());
      setJobId(job.id);
      setArtifactId(id);
      setStep("dry-run");
      poll(job.id, id);
    } catch {
      setError("KEEL could not start the check. Nothing was started.");
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    if (!artifact || artifact.status !== "completed") return;
    setBusy(true);
    setError(null);
    try {
      const { payload } = await postAction(
        "/api/actions/restore",
        { artifactId: artifact.id, ...(justification.trim() ? { justification: justification.trim() } : {}) },
        idempotencyKey,
      );
      if (!payload.approvalRequest) throw new Error("no approval");
      setIdempotencyKey(crypto.randomUUID());
      setStep("track");
      toast({ tone: "info", title: "Sent to approvers", detail: "Nothing changes until one of them approves.", href: "/approvals", hrefLabel: "Open approvals" });
    } catch {
      setError("KEEL could not send the restore for approval. Try again in a minute.");
    } finally {
      setBusy(false);
    }
  }

  function discard() {
    if (timer.current) clearTimeout(timer.current);
    setArtifact(null);
    setArtifactId(null);
    setJobId(null);
    setJustification("");
    setStep("select");
  }

  const plan = artifact?.workloadRestore ?? null;
  const operations = plan?.operations ?? [];
  const refusals = [...(artifact?.guardRefusals ?? []), ...(plan?.refusals ?? [])]
    .filter((item, index, list) => list.findIndex((other) => other.naturalKey === item.naturalKey) === index);
  const settingCount = operations.reduce((sum, op) => sum + op.changes.length, 0);
  const title = step === "select" ? "Step 1 of 4: choose what to put back."
    : step === "dry-run" ? "Step 2 of 4: KEEL is checking what would change. Nothing is written."
    : step === "review" ? (artifact?.status === "completed" ? "Step 3 of 4: review what will change, then send it for approval." : "Step 3 of 4: the check found problems, so nothing can be put back from it.")
    : "Step 4 of 4: sent to approvers. Nothing changes until one of them approves.";

  return (
    <section aria-labelledby={headingId} className="workload-restore">
      <div className="workload-restore-head">
        <div>
          <p className="section-kicker">{name}</p>
          <h3 id={headingId} ref={headingRef} tabIndex={-1}>{title}</h3>
          {choices ? <p className="workload-restore-from">From the backup of {backupPointWords(choices.chosen.takenAt)}. Nothing is written until someone approves.</p> : null}
        </div>
        <button className="btn btn-sm" onClick={onClose} type="button">Close</button>
      </div>
      <RestoreStepper current={step === "review" ? "confirm" : step} failed={step === "review" && artifact?.status !== "completed"} />

      {step === "select" ? (
        loading && !choices ? <p className="workload-restore-loading" role="status">Reading the backup…</p> : choices ? (
          <>
            {snapshots.length > 1 ? (
              <RestorePoint
                chosen={snapshots.find((snapshot) => snapshot.id === choices.chosen.collectionId) ?? snapshots[0]}
                headingId={`${headingId}-point`}
                now={now}
                onPick={(id) => { if (id !== choices.chosen.collectionId) void load(id); }}
                snapshots={snapshots}
                urlDay={false}
              />
            ) : null}
            <div className="workload-choices">
              {choices.groups.length === 0 ? <p className="workload-restore-loading">This backup holds nothing to put back.</p> : null}
              {choices.groups.map((group) => {
                const restorable = group.items.filter((item) => item.restorable);
                const all = restorable.length > 0 && restorable.every((item) => selected.has(item.key));
                return (
                  <fieldset className="workload-choice-group" key={group.kind}>
                    <legend className="workload-choice-head">
                      {restorable.length ? (
                        <label>
                          <input checked={all} onChange={() => toggleGroup(group)} type="checkbox" />
                          <span>{group.name} ({group.items.length})</span>
                        </label>
                      ) : <span>{group.name} ({group.items.length})</span>}
                      {group.restorable ? null : <span className="restore-chip" data-tone="soon">By hand only</span>}
                    </legend>
                    {group.restorable ? null : <p className="workload-choice-note">{group.reason}</p>}
                    <ul>
                      {group.items.map((item) => {
                        const words = choiceChangeWords(item);
                        return (
                          <li className="workload-choice" data-change={item.change ?? undefined} data-restorable={item.restorable ? "yes" : "no"} key={item.key}>
                            <label>
                              <input
                                aria-label={item.restorable ? undefined : `${item.name}, cannot be put back`}
                                checked={selected.has(item.key)}
                                disabled={!item.restorable || !canRestore}
                                onChange={() => toggle(item.key)}
                                type="checkbox"
                              />
                              <span>
                                <b>{item.name}</b>
                                {words ? <small>{words}</small> : null}
                                {item.reason && group.restorable ? <small>{item.reason}</small> : null}
                              </span>
                            </label>
                          </li>
                        );
                      })}
                    </ul>
                  </fieldset>
                );
              })}
            </div>
            <div className="workload-restore-bar">
              <p><b>{plural(selected.size, "setting")} chosen.</b> KEEL checks what would change next. Nothing is written.</p>
              <button className="primary-action" disabled={!canRestore || busy || loading || selected.size === 0} onClick={() => void check()} type="button">
                Check what would change
              </button>
            </div>
          </>
        ) : null
      ) : null}

      {step === "dry-run" ? (
        <div aria-live="polite" className="wizard-running">
          <div aria-hidden="true" className="progress-indeterminate"><span /></div>
          <p>KEEL is reading {plural(selected.size, "setting")} from your tenant to compare them with the backup. This only reads; nothing is written.</p>
          <TechnicalDetails>
            {jobId ? <RecordField label="Job ID" value={jobId} usage={<code>GET /api/jobs/{jobId}</code>} /> : null}
            {artifactId ? <RecordField label="Dry run ID" value={artifactId} usage={<code>GET /api/actions/restore/dry-run/{artifactId}</code>} /> : null}
          </TechnicalDetails>
        </div>
      ) : null}

      {step === "review" && artifact ? (
        <div className="workload-review">
          {operations.length ? (
            <p className="workload-review-lead"><b>KEEL will put back {plural(operations.length, "object")}, {plural(settingCount, "setting")} in all.</b></p>
          ) : <p className="workload-review-lead"><b>Nothing to put back: the chosen settings already match the backup.</b></p>}
          {operations.length ? (
            <div className="restore-before-after">
              <ul>
                {operations.map((op) => (
                  <li key={op.resourceKey}>
                    <strong>{nameOf(op.resourceKey)}</strong>
                    <table className="restore-ba-table">
                      <thead><tr><th scope="col">Setting</th><th scope="col">Now in your tenant</th><th scope="col">After the restore</th></tr></thead>
                      <tbody>
                        {op.changes.map((change) => (
                          <tr key={change.field}>
                            <th scope="row">{fieldWords(change.field)}</th>
                            <td data-label="Now">{settingValueWords(change.field, change.before)}</td>
                            <td data-label="After">{settingValueWords(change.field, change.after)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {artifact.contentEffects?.length ? (
            <ContentEffectsPanel
              approvals={artifact.contentEffectApprovals ?? []}
              artifactId={artifact.id}
              canApprove={canApprove}
              effects={artifact.contentEffects}
              effectsDigest={artifact.effectsDigest ?? null}
              onApproved={() => { void fetchArtifact(artifact.id).then((found) => { if (found) setArtifact(found); }); }}
            />
          ) : null}

          {plan?.manual.length ? (
            <div className="workload-manual">
              <p className="severity-label">Also different, but KEEL does not send it</p>
              <ul>
                {plan.manual.map((item, index) => (
                  <li key={`${item.resourceKey}:${item.field ?? ""}:${index}`}>
                    <strong>{nameOf(item.resourceKey)}</strong>
                    {item.field ? `: ${fieldWords(item.field)} is ${settingValueWords(item.field, item.before)} now and ${settingValueWords(item.field, item.after)} in the backup. ` : ": "}
                    {manualWords(item.reason)}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {refusals.length ? (
            <div className="data-error" role="alert">
              <p className="severity-label">Cannot restore</p>
              <ul>{refusals.map((item) => <li key={item.naturalKey}><strong>{nameOf(item.naturalKey)}</strong>: {refusalWords(item.reason)}</li>)}</ul>
            </div>
          ) : null}

          <TechnicalDetails>
            <RecordField label="Dry run ID" value={artifact.id} usage={<code>GET /api/actions/restore/dry-run/{artifact.id}</code>} />
            <RecordField copy={false} label="Status" value={artifact.status} />
            {refusals.map((item) => <RecordField copy={false} key={`refused-${item.naturalKey}`} label={`Refused · ${item.naturalKey}`} value={item.reason} />)}
          </TechnicalDetails>

          {artifact.status === "completed" && operations.length ? (
            <div className="wizard-confirm">
              <label className="filter-field">
                <span>Why (optional, approvers see it)</span>
                <input disabled={busy} onChange={(event) => setJustification(event.target.value)} placeholder="Why is this restore appropriate?" value={justification} />
              </label>
              <div className="drift-action-buttons">
                <button aria-busy={busy || undefined} className="primary-action" disabled={!canRestore || busy} onClick={() => void send()} type="button">Send for approval</button>
                <button className="secondary-action" disabled={busy} onClick={discard} type="button">Discard</button>
              </div>
              <p className="selection-scope">This goes to approvers next. Someone other than you approves exactly this plan, and KEEL reads the tenant again before it writes.</p>
            </div>
          ) : (
            <div className="drift-action-buttons">
              <button className="btn" onClick={discard} type="button">Start again</button>
            </div>
          )}
        </div>
      ) : null}

      {step === "track" ? (
        <div className="wizard-track">
          <ol className="track-timeline">
            <li className="track-done">Check finished</li>
            <li className="track-done">Approval requested</li>
            <li className="track-current">Another person reviews this same plan</li>
            <li>KEEL reads the tenant again, writes, then reads it back</li>
          </ol>
          <p className="selection-scope">If a setting changed since this check, KEEL stops and asks for a new check instead of writing over it.</p>
          <div className="form-actions">
            <Link className="btn btn-secondary" href="/approvals">Open in Approvals</Link>
            <button className="btn btn-ghost" onClick={discard} type="button">Put back something else</button>
          </div>
        </div>
      ) : null}

      {error ? <p className="action-error" role="alert">{error}</p> : null}
    </section>
  );
}
