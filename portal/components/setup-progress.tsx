"use client";

import { useState } from "react";

import { RecordField, TechnicalDetails } from "@/components/technical-details";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { ago, formatTimestamp } from "@/lib/presentation";
import {
  PROGRESS_LABELS,
  PROGRESS_TONES,
  SCOPE_TITLES,
  WORKLOAD_LABELS,
  progressCounts,
  stepHelp,
  stepTitle,
  type SetupRun,
  type SetupScope,
} from "@/lib/setup-view";
import { toast } from "@/lib/toast";

// Roadmap task-76: one setup (read access, or write access) as a list of named steps
// with their progress. Steps are never ticked off by hand: a step is done only when
// KEEL has seen it in the tenant. Starting and continuing go through the guarded setup
// route, which re-checks the operator's roles before every change.

function runSentence(run: SetupRun, now: string): string {
  const when = ago(run.lastEventAt ?? run.approvedAt, now);
  switch (run.state) {
    case "complete": return `Finished ${when}. KEEL checked every step again before calling it done.`;
    case "waiting-for-you": return "Paused on a step only you can do. Do it, then continue.";
    case "stopped": return `Stopped ${when}. Continue to check what is in place and pick up from there.`;
    case "interrupted": return "Did not finish. Continue to check what is in place and pick up from there.";
    case "ready": return "Approved and ready to start.";
  }
}

const RESUMABLE = new Set<SetupRun["state"]>(["waiting-for-you", "stopped", "interrupted", "ready"]);

export function SetupProgress({ setup, now, canProvision, canCheck, checkFailed = false, canStart }: {
  setup: SetupScope;
  now: string;
  canProvision: boolean;
  canCheck: boolean;
  checkFailed?: boolean;
  canStart: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [workloads, setWorkloads] = useState<string[]>(setup.workloads);
  const counts = progressCounts(setup.steps);
  const title = SCOPE_TITLES[setup.scope];
  const run = setup.run;
  const headingId = `setup-${setup.scope}`;

  async function post(body: Record<string, unknown>) {
    setBusy(true);
    try {
      const response = await fetch("/api/actions/setup", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify(body),
      });
      if (response.status === 403) {
        toast({ tone: "warning", title: "Not started", detail: "You need the admin and approver roles, or your sign-in has ended. Sign in again; progress so far is kept." });
        return;
      }
      if (!response.ok) {
        toast({ tone: "warning", title: "Setup stopped", detail: "What was done so far is kept. The steps below show where it stopped." });
      } else {
        const { run: result } = await response.json() as { run: { status: string } };
        toast({ title: result.status === "complete" ? "Setup finished" : "Setup paused on a step for you" });
      }
      // A full reload: progress is read back from what KEEL recorded, never from this response.
      window.location.reload();
    } finally {
      setBusy(false);
    }
  }

  const continuable = run !== null && RESUMABLE.has(run.state) && run.resumableByViewer;
  const startable = canStart && (run === null || run.state === "complete" || !run.resumableByViewer || run.state === "stopped");

  return (
    <section aria-labelledby={headingId} className="item-card setup-card">
      <div className="item-card-head">
        <h2 id={headingId}>{title}</h2>
        <span className={`pill pill-${counts.done === counts.total ? "ok" : "neutral"}`}>
          {counts.done} of {counts.total} done
        </span>
      </div>
      <p>
        {setup.scope === "read"
          ? "What KEEL needs to read your tenant. Nothing here lets KEEL change anything."
          : "What KEEL needs to write settings back during a restore. Backups do not wait for this."}
      </p>
      {run ? (
        <p className="setup-run">
          {runSentence(run, now)}{" "}
          <span className="field-help">
            Started by {run.approvedByName ?? "an earlier admin"}{" "}
            <time dateTime={run.approvedAt} title={formatTimestamp(run.approvedAt)}>{ago(run.approvedAt, now)}</time>
            {" "}for {run.workloads.map((workload) => WORKLOAD_LABELS[workload] ?? workload).join(" and ")}.
            {!run.resumableByViewer && run.state !== "complete" ? " Only the person who started it can continue it; you can start a new one." : ""}
          </span>
        </p>
      ) : !canCheck ? (
        <p className="field-help">KEEL cannot look at your tenant from this server yet, so these steps show as not checked.</p>
      ) : checkFailed ? (
        <p className="field-help">KEEL could not read your tenant just now, so these steps show as not checked. Reload the page to try again.</p>
      ) : null}

      <ol className="setup-steps">
        {setup.steps.map((step) => (
          <li className={`setup-step setup-step-${step.progress}`} key={step.id}>
            <div className="setup-step-head">
              <h3>{stepTitle(step)}</h3>
              <span className={`pill pill-${PROGRESS_TONES[step.progress]}`}>{PROGRESS_LABELS[step.progress]}</span>
            </div>
            <p className="field-help">
              {step.workload ? `${WORKLOAD_LABELS[step.workload] ?? step.workload}. ` : ""}
              {step.progress === "unclear"
                ? "KEEL could not tell whether this worked. It checks the tenant before trying again, so it never makes the change twice."
                : stepHelp(step)}
            </p>
          </li>
        ))}
      </ol>

      {canProvision && (startable || continuable) ? (
        <div className="form-actions setup-actions">
          {startable && setup.workloads.length > 1 ? (
            <fieldset className="setup-workloads" disabled={busy}>
              <legend>Set up</legend>
              {setup.workloads.map((workload) => (
                <label key={workload}>
                  <input
                    checked={workloads.includes(workload)}
                    onChange={(event) => setWorkloads((current) => event.target.checked
                      ? [...current, workload]
                      : current.filter((item) => item !== workload))}
                    type="checkbox"
                  />
                  {WORKLOAD_LABELS[workload] ?? workload}
                </label>
              ))}
            </fieldset>
          ) : null}
          {continuable ? (
            <button className="btn btn-primary" disabled={busy} onClick={() => post({ resume: run.artifactId })} type="button">
              Continue setup
            </button>
          ) : null}
          {startable ? (
            <ConfirmButton
              confirmLabel="Start"
              description={<p>KEEL makes the changes it can, checks each one in the tenant, and stops at the first step only you can do.</p>}
              disabled={busy || workloads.length === 0}
              onConfirm={() => post({ scope: setup.scope, workloads })}
              title={`Start ${title.toLowerCase()} setup?`}
            >
              {run ? "Start again" : "Start setup"}
            </ConfirmButton>
          ) : null}
        </div>
      ) : null}
      {!canProvision ? (
        <p className="field-help">This server cannot make these changes for you. Do each step in the Microsoft admin centers, then reload this page.</p>
      ) : null}

      <TechnicalDetails>
        {run ? (
          <>
            <RecordField label="Setup run ID" usage={<>use with <code>POST /api/actions/setup</code> as <code>resume</code></>} value={run.artifactId} />
            <RecordField label="Started by principal ID" value={run.approvedBy} />
            <RecordField copy={false} label="Run state" value={run.state} />
            <RecordField copy={false} label="Build and qualification mode" value={`${run.build} · ${run.qualificationMode}`} />
          </>
        ) : setup.planId ? (
          <RecordField label="Plan ID" usage="content hash; stays the same while the steps do" value={setup.planId} />
        ) : null}
        {setup.steps.map((step) => (
          <RecordField key={step.id} label={`Step ID (${step.kind}, ${step.action})`} usage={step.workload ?? step.identity} value={step.id} />
        ))}
      </TechnicalDetails>
    </section>
  );
}
