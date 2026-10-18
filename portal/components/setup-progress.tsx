"use client";

import { useState } from "react";

import { Icon } from "@/components/shell/icons";
import { RecordField, TechnicalDetails } from "@/components/technical-details";
import { Badge, type BadgeTone } from "@/components/ui/badge";
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

// The step's progress in the portal's one badge: colour for risk only.
const STEP_TONES: Record<(typeof PROGRESS_TONES)[keyof typeof PROGRESS_TONES], BadgeTone> = {
  ok: "fine", warn: "soon", bad: "urgent", info: "low", neutral: "neutral",
};

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
    <section aria-labelledby={headingId} className="pt-section setup-card">
      <div className="pt-section-head">
        <div>
          <h2 id={headingId}>{title}</h2>
          <p>
            {setup.scope === "read"
              ? "What KEEL needs to read your tenant. Nothing here lets KEEL change anything."
              : "What KEEL needs to write settings back during a restore. Backups do not wait for this."}
          </p>
        </div>
        {canProvision && (startable || continuable) ? (
          <div className="st-head-actions setup-actions">
            {startable ? (
              <ConfirmButton
                confirmLabel="Start"
                description={<p>KEEL makes the changes it can, checks each one in the tenant, and stops at the first step only you can do.</p>}
                disabled={busy || workloads.length === 0}
                onConfirm={() => post({ scope: setup.scope, workloads })}
                size="sm"
                title={`Start ${title.toLowerCase()} setup?`}
                tone="neutral"
              >
                {run ? "Start again" : "Start setup"}
              </ConfirmButton>
            ) : null}
            {continuable ? (
              <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => post({ resume: run.artifactId })} type="button">
                Continue setup
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      {run ? (
        <p className="pt-note setup-run">
          <Icon name={run.state === "complete" ? "check-circle" : run.state === "ready" ? "info" : "clock"} />
          <span>
            {runSentence(run, now)}{" "}
            <span className="st-soft">
              Started by {run.approvedByName ?? "an earlier admin"}{" "}
              <time dateTime={run.approvedAt} title={formatTimestamp(run.approvedAt)}>{ago(run.approvedAt, now)}</time>
              {" "}for {run.workloads.map((workload) => WORKLOAD_LABELS[workload] ?? workload).join(" and ")}.
              {!run.resumableByViewer && run.state !== "complete" ? " Only the person who started it can continue it; you can start a new one." : ""}
            </span>
          </span>
        </p>
      ) : !canCheck ? (
        <p className="pt-note"><Icon name="info" /><span>KEEL cannot look at your tenant from this server yet, so these steps show as not checked.</span></p>
      ) : checkFailed ? (
        <p className="pt-note"><Icon name="info" /><span>KEEL could not read your tenant just now, so these steps show as not checked. Reload the page to try again.</span></p>
      ) : null}
      {!canProvision ? (
        <p className="pt-note"><Icon name="info" /><span>This server cannot make these changes for you. Do each step in the Microsoft admin centers, then reload this page.</span></p>
      ) : null}

      <section className="sel-group st-group">
        <header className="sel-group-head st-group-head">
          <Icon name={setup.scope === "read" ? "backup" : "restore"} />
          <span className="sel-group-name"><b>Steps</b><small>A step is done only when KEEL has seen it in the tenant.</small></span>
          <span className="sel-group-count">{counts.done} of {counts.total} done</span>
          <span aria-hidden="true" className="st-progress"><i style={{ width: `${counts.total ? Math.round((counts.done / counts.total) * 100) : 0}%` }} /></span>
        </header>
        <ol className="sel-rows setup-steps">
          {setup.steps.map((step, index) => {
            const tone = STEP_TONES[PROGRESS_TONES[step.progress]];
            const risk = tone === "urgent" || tone === "soon" ? tone : null;
            return (
              <li className={`sel-row st-row setup-step setup-step-${step.progress}`} data-tone={risk ?? undefined} key={step.id}>
                <div className="sel-row-body pt-row">
                  <span aria-hidden="true" className="pt-kind st-step-number" data-tone={tone === "neutral" || tone === "low" ? undefined : tone}>
                    {step.progress === "done" ? <Icon name="check" /> : index + 1}
                  </span>
                  <span className="pt-row-name">
                    <h3>{stepTitle(step)}</h3>
                    {step.workload ? <small>{WORKLOAD_LABELS[step.workload] ?? step.workload}</small> : null}
                  </span>
                  <span className="pt-row-mid">
                    <Badge tone={tone}>{PROGRESS_LABELS[step.progress]}</Badge>
                    <span className="pt-row-line">
                      {step.progress === "unclear"
                        ? "KEEL could not tell whether this worked. It checks the tenant before trying again, so it never makes the change twice."
                        : stepHelp(step)}
                    </span>
                  </span>
                  <span className="pt-row-acts" />
                </div>
              </li>
            );
          })}
        </ol>
      </section>

      {canProvision && startable && setup.workloads.length > 1 ? (
        <fieldset className="st-checks setup-workloads" disabled={busy}>
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

      <TechnicalDetails summary={`Technical details for ${title.toLowerCase()}`}>
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
