"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import { ContentEffectsPanel, type ContentEffect } from "@/components/content-effects";
import { RestorePoint } from "@/components/restore/restore-point";
import { RestoreStepper } from "@/components/restore-selection";
import { RecordField, RecordGroup, TechnicalDetails, type RecordValue } from "@/components/technical-details";
import { postAction } from "@/lib/action-client";
import { fieldWords, valueWords } from "@/lib/changes-view";
import { toast } from "@/lib/toast";
import { plural } from "@/lib/restore-view";
import {
  PER_ITEM_WORKLOADS,
  backupPointWords,
  choiceChangeWords,
  type WorkloadChoiceGroup,
  type WorkloadChoices,
} from "@/lib/restore-workloads-view";
import type { SnapshotOption } from "@/lib/portal-jobs";

// One service's restore from the Restore page (Exchange, Teams, Purview): the same
// steps as Entra ID and Intune. Choose objects from a backup, KEEL checks what would
// change (a dry run, nothing written), review, then send for approval. Several
// mailboxes or teams are checked one by one and each is sent as its own request.

const POLL_MS = 3000;

interface FieldChange { field: string; before: unknown; after: unknown }
// Policy plans name each object by resourceKey; a mailbox plan has one operation per
// group (mailbox settings, client access, retention, organization) and a team plan
// one for its settings plus one per member added, re-roled or removed.
interface PlanOperation {
  resourceKey?: string;
  naturalKey?: string;
  kind?: string;
  group?: string;
  changes?: FieldChange[];
  member?: { displayName?: string | null; userId?: string; roles?: string[] };
  before?: string[];
}
interface WorkloadPlan {
  operations: PlanOperation[];
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

interface Run {
  // The chosen mailbox or team; null for a policy workload's single run.
  target: string | null;
  jobId: string;
  artifactId: string;
  state: "running" | "done" | "failed";
  artifact: WorkloadArtifact | null;
}

const EXCHANGE_GROUP_WORDS: Record<string, string> = {
  mailboxSettings: "Mailbox settings",
  clientAccess: "Client access",
  retention: "Hold and retention",
  organization: "Organization-wide Exchange settings",
};

const rolesWords = (roles: string[] | undefined) => (roles?.includes("owner") ? "Owner" : roles?.includes("guest") ? "Guest" : "Member");

export interface ChangeTable { key: string; title: string; rows: FieldChange[] }

/** Every operation of one plan as tables of setting, now and after; team members share one table. */
export function changeTables(operations: PlanOperation[], nameOf: (key: string) => string): ChangeTable[] {
  const tables: ChangeTable[] = [];
  const members: FieldChange[] = [];
  for (const [index, op] of operations.entries()) {
    if (op.kind === "member-add" || op.kind === "member-update" || op.kind === "member-remove") {
      const who = op.member?.displayName?.trim() || "A member without a name";
      const before = op.kind === "member-add" ? "Not in the team" : rolesWords(op.kind === "member-update" ? op.before : op.member?.roles);
      const after = op.kind === "member-remove" ? "Removed from the team" : rolesWords(op.member?.roles);
      members.push({ field: who, before, after });
      continue;
    }
    const title = op.resourceKey ? nameOf(op.resourceKey)
      : op.group && EXCHANGE_GROUP_WORDS[op.group] ? EXCHANGE_GROUP_WORDS[op.group]
      : op.kind === "settings" ? "Team settings"
      : "Settings";
    tables.push({ key: op.resourceKey ?? op.naturalKey ?? `op-${index}`, title, rows: op.changes ?? [] });
  }
  if (members.length) tables.push({ key: "members", title: "Members", rows: members });
  return tables;
}

/** What a refusal or a by-hand item is about, in the words of its run. */
export function targetWords(key: string, nameOf: (key: string) => string): string {
  const exchange = /^exchange:.+:(\w+)$/.exec(key);
  if (exchange && EXCHANGE_GROUP_WORDS[exchange[1]]) return EXCHANGE_GROUP_WORDS[exchange[1]];
  if (/^teams:[^:]+:settings$/.test(key)) return "Team settings";
  if (/^teams:[^:]+:members?(:|$)/.test(key)) return "Members";
  return nameOf(key);
}

const isSendable = (run: Run) => run.artifact?.status === "completed" && (run.artifact.workloadRestore?.operations.length ?? 0) > 0;

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

export function WorkloadRestore({ workload, name, canRestore, canApprove, now, onClose, start }: {
  workload: string;
  name: string;
  canRestore: boolean;
  canApprove: boolean;
  now: string;
  onClose: () => void;
  // Opens on this backup with these objects chosen (an undo from the Changes page).
  start?: { collectionId: string; targets: string[] };
}) {
  const [choices, setChoices] = useState<WorkloadChoices | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [step, setStep] = useState<Step>("select");
  // One run per dry run: one for a policy workload, one per chosen mailbox or team.
  const [runs, setRuns] = useState<Run[]>([]);
  const [justification, setJustification] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sentIds = useRef<Set<string>>(new Set());
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
      // Start with what changed since: the likely thing to put back. Settings that
      // affect the whole tenant are never ticked for you, unless an undo asked for them.
      const asked = start && found.chosen.collectionId === start.collectionId ? new Set(start.targets) : null;
      setSelected(new Set(found.groups.flatMap((group) => group.items
        .filter((item) => item.restorable && (asked ? asked.has(item.key) : !item.tenantWide && item.change === "changed"))
        .map((item) => item.key))));
    } catch {
      setError("KEEL could not read this backup. Reload in a minute.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(start?.collectionId ?? null); }, [workload, start?.collectionId]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // One loop for every run; the review opens once each run has finished or failed.
  function poll(current: Run[]) {
    timer.current = setTimeout(async () => {
      const next = await Promise.all(current.map(async (run) => {
        if (run.state !== "running") return run;
        try {
          const status = await fetchJobStatus(run.jobId);
          if (status === "failed" || status === "cancelled") return { ...run, state: "failed" as const };
          if (status === "succeeded") {
            const found = await fetchArtifact(run.artifactId);
            if (found) return { ...run, state: "done" as const, artifact: found };
          }
        } catch {
          // Try again on the next round.
        }
        return run;
      }));
      setRuns(next);
      if (next.some((run) => run.state === "running")) { poll(next); return; }
      if (next.every((run) => run.state === "failed")) {
        setStep("select");
        setError("The check did not finish, so nothing was planned. Try again in a minute.");
        return;
      }
      setStep("review");
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
      const started = (Array.isArray(payload.runs) ? payload.runs : []) as { target?: string | null; job?: { id?: string }; artifactId?: string }[];
      const next: Run[] = started.flatMap((run) => (run.job?.id && typeof run.artifactId === "string"
        ? [{ target: run.target ?? null, jobId: run.job.id, artifactId: run.artifactId, state: "running" as const, artifact: null }]
        : []));
      if (next.length === 0) throw new Error("no job");
      setIdempotencyKey(crypto.randomUUID());
      setRuns(next);
      setStep("dry-run");
      poll(next);
    } catch {
      setError("KEEL could not start the check. Nothing was started.");
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    const sendable = runs.filter(isSendable);
    if (sendable.length === 0) return;
    setBusy(true);
    setError(null);
    let sent = 0;
    try {
      for (const [index, run] of sendable.entries()) {
        // A retry after a partial failure skips the ones already sent.
        if (sentIds.current.has(run.artifactId)) { sent += 1; continue; }
        const { payload } = await postAction(
          "/api/actions/restore",
          { artifactId: run.artifactId, ...(justification.trim() ? { justification: justification.trim() } : {}) },
          sendable.length === 1 ? idempotencyKey : `${idempotencyKey}:${index}`,
        );
        if (!payload.approvalRequest) throw new Error("no approval");
        sentIds.current.add(run.artifactId);
        sent += 1;
      }
      setIdempotencyKey(crypto.randomUUID());
      setStep("track");
      toast({ tone: "info", title: sent === 1 ? "Sent to approvers" : `${sent} restores sent to approvers`, detail: "Nothing changes until one of them approves.", href: "/approvals", hrefLabel: "Open approvals" });
    } catch {
      setError(sent
        ? `KEEL sent ${sent} of ${sendable.length} for approval and could not send the rest. Try again in a minute.`
        : "KEEL could not send the restore for approval. Try again in a minute.");
    } finally {
      setBusy(false);
    }
  }

  function discard() {
    if (timer.current) clearTimeout(timer.current);
    setRuns([]);
    sentIds.current = new Set();
    setJustification("");
    setStep("select");
  }

  const finished = runs.filter((run) => run.state === "done" && run.artifact);
  const sendable = runs.filter(isSendable);
  const tablesOf = (run: Run) => changeTables(run.artifact?.workloadRestore?.operations ?? [], nameOf);
  const objectCount = finished.reduce((sum, run) => sum + tablesOf(run).length, 0);
  const settingCount = finished.reduce((sum, run) => sum + tablesOf(run).reduce((inner, table) => inner + table.rows.length, 0), 0);
  const reviewOk = sendable.length > 0 || (finished.length > 0 && finished.every((run) => run.artifact?.status === "completed"));
  const title = step === "select" ? "Step 1 of 4: choose what to put back."
    : step === "dry-run" ? "Step 2 of 4: KEEL is checking what would change. Nothing is written."
    : step === "review" ? (reviewOk ? "Step 3 of 4: review what will change, then send it for approval." : "Step 3 of 4: the check found problems, so nothing can be put back from it.")
    : "Step 4 of 4: sent to approvers. Nothing changes until one of them approves.";
  const perItem = PER_ITEM_WORKLOADS.includes(workload);
  const unit = workload === "teams-settings" ? "team" : workload === "exchange-mailbox-settings" ? "mailbox" : "setting";
  const units = unit === "mailbox" ? "mailboxes" : `${unit}s`;
  const chosenCount = perItem ? [...selected].filter((key) => key !== "organization").length : selected.size;
  const needsMailbox = perItem && selected.has("organization") && chosenCount === 0;

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
      <RestoreStepper current={step === "review" ? "confirm" : step} failed={step === "review" && !reviewOk} />

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
              <p>
                <b>{plural(chosenCount, unit, units)} chosen.</b>{" "}
                {needsMailbox ? "The organization-wide settings go with a mailbox: choose one too."
                  : perItem && chosenCount > 1 ? `KEEL checks each ${unit} on its own, and each goes to approvers as its own request. Nothing is written.`
                  : "KEEL checks what would change next. Nothing is written."}
              </p>
              <button className="primary-action" disabled={!canRestore || busy || loading || chosenCount === 0 || chosenCount > 20} onClick={() => void check()} type="button">
                {perItem && chosenCount > 1 ? `Check ${chosenCount} ${units}` : "Check what would change"}
              </button>
            </div>
          </>
        ) : null
      ) : null}

      {step === "dry-run" ? (
        <div aria-live="polite" className="wizard-running">
          <div aria-hidden="true" className="progress-indeterminate"><span /></div>
          <p>KEEL is reading {plural(chosenCount, unit, units)} from your tenant to compare with the backup. This only reads; nothing is written.</p>
          {runs.length > 1 ? <p className="selection-scope">{runs.filter((run) => run.state !== "running").length} of {runs.length} checked.</p> : null}
          <TechnicalDetails>
            {runs.map((run) => (
              <RecordGroup key={run.jobId} note={run.state} title={run.target ? nameOf(run.target) : "Check"}>
                {run.target ? <RecordField label="Target (stored key)" value={run.target} /> : null}
                <RecordField label="Job ID" value={run.jobId} usage={<code>GET /api/jobs/{run.jobId}</code>} />
                <RecordField label="Dry run ID" value={run.artifactId} usage={<code>GET /api/actions/restore/dry-run/{run.artifactId}</code>} />
                <RecordField copy={false} label="State" value={run.state} />
              </RecordGroup>
            ))}
          </TechnicalDetails>
        </div>
      ) : null}

      {step === "review" ? (
        <div className="workload-review">
          {objectCount ? (
            <p className="workload-review-lead"><b>KEEL will put back {plural(objectCount, "object")}, {plural(settingCount, "setting")} in all{sendable.length > 1 ? `, as ${sendable.length} requests` : ""}.</b></p>
          ) : <p className="workload-review-lead"><b>Nothing to put back: the chosen settings already match the backup.</b></p>}

          {runs.map((run) => (
            <RunReview
              canApprove={canApprove}
              heading={runs.length > 1 && run.target ? nameOf(run.target) : null}
              key={run.artifactId}
              nameOf={nameOf}
              onApproved={(found) => setRuns((current) => current.map((entry) => (entry.artifactId === found.id ? { ...entry, artifact: found } : entry)))}
              run={run}
            />
          ))}

          {sendable.length ? (
            <div className="wizard-confirm">
              <label className="filter-field">
                <span>Why (optional, approvers see it)</span>
                <input disabled={busy} onChange={(event) => setJustification(event.target.value)} placeholder="Why is this restore appropriate?" value={justification} />
              </label>
              <div className="drift-action-buttons">
                <button aria-busy={busy || undefined} className="primary-action" disabled={!canRestore || busy} onClick={() => void send()} type="button">
                  {sendable.length > 1 ? `Send ${sendable.length} for approval` : "Send for approval"}
                </button>
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

/** One dry run's review: what changes, content effects, what stays by hand, refusals. */
function RunReview({ run, heading, nameOf, canApprove, onApproved }: {
  run: Run;
  heading: string | null;
  nameOf: (key: string) => string;
  canApprove: boolean;
  onApproved: (artifact: WorkloadArtifact) => void;
}) {
  const artifact = run.artifact;
  if (!artifact) {
    return (
      <div className="workload-run">
        {heading ? <h4>{heading}</h4> : null}
        <p className="action-error">The check did not finish, so nothing is planned for this one. Start again to retry it.</p>
      </div>
    );
  }
  const plan = artifact.workloadRestore;
  const operations = plan?.operations ?? [];
  const tables = changeTables(operations, nameOf);
  const refusals = [...(artifact.guardRefusals ?? []), ...(plan?.refusals ?? [])]
    .filter((item, index, list) => list.findIndex((other) => other.naturalKey === item.naturalKey) === index);
  return (
    <div className="workload-run">
      {heading ? <h4>{heading}{operations.length ? null : <span className="workload-run-same"> · already matches the backup</span>}</h4> : null}
      {tables.length ? (
        <div className="restore-before-after">
          <ul>
            {tables.map((table) => (
              <li key={table.key}>
                {table.title !== heading ? <strong>{table.title}</strong> : null}
                <table className="restore-ba-table">
                  <thead><tr><th scope="col">{table.key === "members" ? "Member" : "Setting"}</th><th scope="col">Now in your tenant</th><th scope="col">After the restore</th></tr></thead>
                  <tbody>
                    {table.rows.map((change) => (
                      <tr key={change.field}>
                        <th scope="row">{table.key === "members" ? change.field : fieldWords(change.field)}</th>
                        <td data-label="Now">{table.key === "members" ? String(change.before) : settingValueWords(change.field, change.before)}</td>
                        <td data-label="After">{table.key === "members" ? String(change.after) : settingValueWords(change.field, change.after)}</td>
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
          onApproved={() => { void fetchArtifact(artifact.id).then((found) => { if (found) onApproved(found); }); }}
        />
      ) : null}

      {plan?.manual.length ? (
        <div className="workload-manual">
          <p className="severity-label">Also different, but KEEL does not send it</p>
          <ul>
            {plan.manual.map((item, index) => (
              <li key={`${item.resourceKey}:${item.field ?? ""}:${index}`}>
                <strong>{targetWords(item.resourceKey, nameOf)}</strong>
                {item.field && ("before" in item || "after" in item) ? `: ${fieldWords(item.field)} is ${settingValueWords(item.field, item.before)} now and ${settingValueWords(item.field, item.after)} in the backup. ` : ": "}
                {manualWords(item.reason)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {refusals.length ? (
        <div className="data-error" role="alert">
          <p className="severity-label">Cannot restore</p>
          <ul>{refusals.map((item) => <li key={item.naturalKey}><strong>{targetWords(item.naturalKey, nameOf)}</strong>: {refusalWords(item.reason)}</li>)}</ul>
        </div>
      ) : null}

      <TechnicalDetails>
        <RecordField label="Dry run ID" value={artifact.id} usage={<code>GET /api/actions/restore/dry-run/{artifact.id}</code>} />
        <RecordField label="Job ID" value={run.jobId} usage={<code>GET /api/jobs/{run.jobId}</code>} />
        {run.target ? <RecordField label="Target (stored key)" value={run.target} /> : null}
        <RecordField copy={false} label="Status" value={artifact.status} />
        <RecordField label="Effects digest" usage="approvers bind to this exact set of content effects" value={artifact.effectsDigest} />
        {operations.map((operation, index) => (
          <RecordGroup key={`op:${operation.resourceKey ?? operation.naturalKey ?? ""}:${operation.group ?? operation.kind ?? ""}:${index}`} note={operation.group ?? operation.kind ?? "operation"} title={operation.resourceKey ?? operation.naturalKey ?? `Operation ${index + 1}`}>
            {operation.resourceKey ? <RecordField label="Resource key" value={operation.resourceKey} /> : null}
            {operation.naturalKey ? <RecordField label="Stored key" value={operation.naturalKey} /> : null}
            {operation.kind ? <RecordField copy={false} label="Kind" value={operation.kind} /> : null}
            {operation.group ? <RecordField copy={false} label="Group" value={operation.group} /> : null}
            {operation.member ? <RecordField label="Member" value={operation.member} /> : null}
            {operation.before ? <RecordField label="Roles before" value={operation.before} /> : null}
            {(operation.changes ?? []).map((change) => (
              <RecordField copy={false} key={change.field} label={`Field ${change.field}`} value={{ now: change.before, after: change.after } as RecordValue} />
            ))}
          </RecordGroup>
        ))}
        {(plan?.manual ?? []).map((item, index) => (
          <RecordGroup key={`manual:${item.resourceKey}:${item.field ?? ""}:${index}`} note="not sent; by hand" title={item.resourceKey}>
            <RecordField label="Resource key" value={item.resourceKey} />
            <RecordField copy={false} label="Field path" value={item.field} />
            <RecordField copy={false} label="Reason" value={item.reason} />
            {"before" in item ? <RecordField copy={false} label="Now" value={item.before as RecordValue} /> : null}
            {"after" in item ? <RecordField copy={false} label="In the backup" value={item.after as RecordValue} /> : null}
          </RecordGroup>
        ))}
        {refusals.map((item) => (
          <RecordGroup key={`refused:${item.naturalKey}`} note="refused" title={item.naturalKey}>
            <RecordField label="Stored key" value={item.naturalKey} />
            <RecordField copy={false} label="Reason" value={item.reason} />
          </RecordGroup>
        ))}
        {artifact.contentEffects?.length ? <RecordField label="Content effects" value={artifact.contentEffects as unknown as RecordValue} /> : null}
        {artifact.contentEffectApprovals?.length ? <RecordField label="Content effect approvals" value={artifact.contentEffectApprovals} /> : null}
      </TechnicalDetails>
    </div>
  );
}
