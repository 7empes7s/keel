"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { useBackup } from "@/components/backup-controls";
import { CredentialAlerts, ServiceStatusSection } from "@/components/setup/service-status";
import { Icon } from "@/components/shell/icons";
import { RecordField, RecordGroup, TechnicalDetails } from "@/components/technical-details";
import { ConnectionsPanel } from "@/components/setup/connections-panel";
import { PermissionsPanel } from "@/components/setup/permissions-panel";
import { Badge } from "@/components/ui/badge";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { Verdict } from "@/components/verdict";
import { ago, formatTimestamp } from "@/lib/presentation";
import { TIERS } from "@/lib/protect-view";
import {
  PROGRESS_LABELS, PROGRESS_TONES, SCOPE_PURPOSE, SCOPE_TITLES,
  appRole, canContinue, canStartScope, currentStep, nextSentence, permissionChips, permissionCounts, permissionList, permissionRows,
  progressCounts, runSentence, setupPrimary, setupVerdict, stepHelp, stepLink, stepTitle, workloadChip, workloadLabel,
  type SetupPrimary, type SetupScope, type SetupState, type SetupStep,
} from "@/lib/setup-view";
import type { ServiceStatus } from "@/lib/setup-services";
import { toast } from "@/lib/toast";

// Setup (portal audit, pick A): the verdict, four tiles, then the two setups side by
// side (read access for backups, write access for restores). In each, done steps fold
// to one line, the step waiting on someone is open with what to do, who can do it and
// the exact Microsoft page, and later steps are muted. A step is done only when Keel
// has seen it in the tenant, so nothing here ticks a step by hand. Starting and
// continuing go through the guarded setup route; the page then re-reads with
// router.refresh. The page has one amber action at most (setupPrimary).

export function SetupPage({ state, canStart, canBackup, services = null }: {
  state: SetupState;
  canStart: boolean;
  canBackup: boolean;
  // One line per Microsoft 365 service; null when the coverage report could not be read.
  services?: ServiceStatus[] | null;
}) {
  const verdict = setupVerdict(state);
  const primary = setupPrimary(state, { canStart, canBackup });
  const { backUp, busy: backingUp, feedback } = useBackup();
  const read = state.scopes.find((scope) => scope.scope === "read") ?? null;
  const restore = state.scopes.find((scope) => scope.scope === "restore") ?? null;
  const permissions = permissionCounts(permissionRows(state));
  const first = state.firstCollection;

  const jump = (scope: SetupScope["scope"]) => document.getElementById(`setup-${scope}`)?.scrollIntoView({ behavior: "smooth", block: "start" });

  return (
    <div className="su-page">
      <Verdict
        action={primary?.kind === "backup"
          ? { label: "Run the first backup", onClick: () => backUp(TIERS.map((tier) => tier.id), "first"), busy: backingUp === "first" }
          : null}
        text={verdict.text}
        tone={verdict.tone}
      />
      {feedback}
      <CredentialAlerts canCheck={state.canCheck} credentials={state.connections} now={state.generatedAt} />
      <div className="su-body" data-layer="explanation">
        <section aria-label="Setup at a glance" className="su-tiles">
          {[read, restore].map((scope) => scope ? (
            <button className="su-tile" data-tone={tileTone(scope)} key={scope.scope} onClick={() => jump(scope.scope)} type="button">
              <span className="su-tile-label"><Icon name={scope.scope === "read" ? "backup" : "restore"} />{scope.scope === "read" ? "Read access" : "Write access"}</span>
              <b className="su-tile-count">{progressCounts(scope.steps).done} of {scope.steps.length}</b>
              <small>{scope.scope === "read" ? "Needed for backups" : "Needed for restores"}</small>
            </button>
          ) : null)}
          <button className="su-tile" data-tone={permissions.missing ? "urgent" : undefined} onClick={() => document.getElementById("setup-permissions")?.scrollIntoView({ behavior: "smooth", block: "start" })} type="button">
            <span className="su-tile-label"><Icon name="settings" />Permissions</span>
            <b className="su-tile-count">{permissions.missing ? `${permissions.missing} missing` : permissions.granted ? "All granted" : "Not checked"}</b>
            <small>
              {permissions.granted} granted{permissions.optional ? `, ${permissions.optional} optional` : ""}{permissions.unused ? `, ${permissions.unused} not used by Keel` : ""}
            </small>
          </button>
          <Link className="su-tile" data-tone={first?.notRead ? "soon" : undefined} href="/protect">
            <span className="su-tile-label"><Icon name="calendar" />First backup</span>
            <b className="su-tile-count">{first ? "Done" : "Not yet"}</b>
            <small>
              {first
                ? <>{ago(first.completedAt, state.generatedAt)}: {first.read} types read{first.notRead ? `, ${first.notRead} not read` : ""}</>
                : state.collect.allowed ? "Ready to run" : "Can run once read access is done"}
            </small>
          </Link>
        </section>

        {/* Once Keel can read the tenant, how each service is doing comes first; before
            that, the setup steps do. */}
        {state.collect.allowed ? <ServiceStatusSection now={state.generatedAt} services={services} /> : null}
        <div className="su-tracks">
          {state.scopes.map((scope) => (
            <SetupTrack
              canStart={canStart}
              key={scope.scope}
              primary={primary}
              scope={scope}
              state={state}
            />
          ))}
        </div>
        <ConnectionsPanel state={state} />
        <PermissionsPanel state={state} />
        {state.collect.allowed ? null : <ServiceStatusSection now={state.generatedAt} services={services} />}
      </div>
    </div>
  );
}

function tileTone(scope: SetupScope): "soon" | undefined {
  return progressCounts(scope.steps).waitingForYou ? "soon" : undefined;
}

function SetupTrack({ scope, state, canStart, primary }: {
  scope: SetupScope;
  state: SetupState;
  canStart: boolean;
  primary: SetupPrimary;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [workloads, setWorkloads] = useState<string[]>(scope.workloads);
  const counts = progressCounts(scope.steps);
  const title = SCOPE_TITLES[scope.scope];
  const run = scope.run;
  const headingId = `setup-${scope.scope}`;
  const current = currentStep(scope.steps);
  const next = nextSentence(scope);
  const continuable = state.canProvision && canContinue(scope);
  const startable = state.canProvision && canStartScope(scope, canStart);
  const amberContinue = primary?.kind === "continue" && primary.scope === scope.scope;
  const amberStart = primary?.kind === "start" && primary.scope === scope.scope;
  const app = scope.steps.find((step) => step.app)?.app ?? null;
  const shownWorkloads = run?.workloads ?? scope.workloads;

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
        toast({ tone: "warning", title: "Setup stopped", detail: "What was done so far is kept. The steps show where it stopped." });
      } else {
        const { run: result } = await response.json() as { run: { status: string } };
        toast({ title: result.status === "complete" ? "Setup finished" : "Setup paused on a step for you" });
      }
      // Progress is read back from what Keel recorded, never from this response.
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby={`${headingId}-title`} className="su-track" id={headingId}>
      <header className="su-track-head">
        <ProgressRing steps={scope.steps} />
        <div className="su-track-title">
          <h2 id={`${headingId}-title`}>{title}</h2>
          <p>{SCOPE_PURPOSE[scope.scope]}</p>
        </div>
      </header>
      <p className="su-next" data-done={next ? undefined : true}>
        <Icon name={next ? "clock" : "check-circle"} />
        <span>{next ?? `All ${counts.total} steps are done.`}</span>
      </p>

      {startable && scope.workloads.length > 1 ? (
        <fieldset className="su-services" disabled={busy}>
          <legend>Services to set up</legend>
          {scope.workloads.map((workload) => {
            const chip = workloadChip(workload);
            const on = workloads.includes(workload);
            return (
              <button
                aria-pressed={on}
                className="su-service"
                key={workload}
                onClick={() => setWorkloads((current) => on ? current.filter((item) => item !== workload) : [...current, workload])}
                title={workloadLabel(workload)}
                type="button"
              >
                <Icon name={chip.icon} />{chip.label}
              </button>
            );
          })}
        </fieldset>
      ) : (
        <ul aria-label="Services" className="su-services">
          {shownWorkloads.map((workload) => {
            const chip = workloadChip(workload);
            return <li className="su-service" key={workload} title={workloadLabel(workload)}><Icon name={chip.icon} />{chip.label}</li>;
          })}
        </ul>
      )}

      {run ? (
        <p className="su-run">
          {runSentence(run, ago(run.lastEventAt ?? run.approvedAt, state.generatedAt))}{" "}
          Started by {run.approvedByName ?? "an earlier admin"}{" "}
          <time dateTime={run.approvedAt} title={formatTimestamp(run.approvedAt)}>{ago(run.approvedAt, state.generatedAt)}</time>.
          {!run.resumableByViewer && run.state !== "complete" ? " Only the person who started it can continue it; you can start a new one." : ""}
        </p>
      ) : !state.canCheck ? (
        <p className="su-run">Keel cannot look at your tenant from this server yet, so steps it has not seen show as not checked.</p>
      ) : state.checkFailed ? (
        <p className="su-run">Keel could not read your tenant just now, so these steps show as not checked. Press Check again to try again.</p>
      ) : null}

      <ol className="su-steps">
        {scope.steps.map((step, index) => (
          <SetupStepRow
            busy={busy}
            continuable={continuable && step.id === current?.id}
            amber={amberContinue}
            current={step.id === current?.id}
            index={index}
            key={step.id}
            onContinue={() => run && post({ resume: run.artifactId })}
            step={step}
            tenantId={state.tenantId ?? null}
          />
        ))}
      </ol>

      {(startable || (continuable && !current)) ? (
        <div className="su-actions">
          {continuable && !current && run ? (
            <button className={amberContinue ? "btn btn-primary" : "btn"} disabled={busy} onClick={() => post({ resume: run.artifactId })} type="button">
              Continue setup
            </button>
          ) : null}
          {startable ? (
            <ConfirmButton
              confirmLabel="Start"
              description={<p>Keel makes the changes it can in Microsoft 365 for {workloads.map(workloadLabel).join(" and ")}, checks each one in the tenant, and stops at the first step only you can do.</p>}
              disabled={busy || workloads.length === 0}
              onConfirm={() => post({ scope: scope.scope, workloads })}
              title={`Start ${title.toLowerCase()} setup?`}
              tone={amberStart ? "primary" : "neutral"}
            >
              {run ? "Start a new run" : "Start setup"}
            </ConfirmButton>
          ) : null}
        </div>
      ) : null}
      {!state.canProvision ? (
        <p className="su-note">This server cannot make these changes for you. Do each step in Microsoft, then press Check again.</p>
      ) : null}

      <TechnicalDetails>
        <RecordGroup title={`The ${appRole(scope.steps[0]?.identity ?? (scope.scope === "read" ? "collector" : "restorer"))}`}>
          <RecordField label="Tenant ID" value={state.tenantId ?? null} />
          <RecordField label="App ID" usage="the app Keel signs in as for this setup" value={app?.appId ?? null} />
          <RecordField copy={false} label="Name in Entra ID" value={app?.displayName ?? null} />
        </RecordGroup>
        {run ? (
          <RecordGroup title="Setup run">
            <RecordField label="Setup run ID" usage={<>use with <code>POST /api/actions/setup</code> as <code>resume</code></>} value={run.artifactId} />
            <RecordField label="Started by principal ID" value={run.approvedBy} />
            <RecordField copy={false} label="Run state" value={run.state} />
            <RecordField copy={false} label="Build and qualification mode" value={`${run.build} · ${run.qualificationMode}`} />
          </RecordGroup>
        ) : scope.planId ? (
          <RecordField label="Plan ID" usage="content hash; stays the same while the steps do" value={scope.planId} />
        ) : null}
        {scope.scope === "read" && state.firstCollection ? (
          <RecordField label="Snapshot ID" usage="the first backup, as What's protected reports it" value={state.firstCollection.snapshotId} />
        ) : null}
        <RecordGroup title="Steps">
          {scope.steps.map((step) => (
            <RecordField key={step.id} label={`Step ID (${step.kind}, ${step.action})`} usage={step.workload ?? step.identity} value={step.id} />
          ))}
        </RecordGroup>
        {!state.canCheck ? (
          <p className="field-help">The Keel server needs the backup reader and restore writer sign-in files in /etc/keel to check or change the tenant.</p>
        ) : null}
      </TechnicalDetails>
    </section>
  );
}

function SetupStepRow({ step, index, current, continuable, amber, busy, onContinue, tenantId }: {
  step: SetupStep;
  index: number;
  current: boolean;
  continuable: boolean;
  amber: boolean;
  busy: boolean;
  onContinue: () => void;
  tenantId: string | null;
}) {
  const done = step.progress === "done";
  const chips = permissionChips(step);
  const link = stepLink(step, tenantId);
  const state = done ? "done" : current ? "current" : "later";

  return (
    <li className={`su-step su-step-${step.progress}`} data-state={state}>
      <div className="su-step-head">
        <span aria-hidden="true" className="su-step-mark">{done ? <Icon name="check" /> : index + 1}</span>
        <h3>{stepTitle(step)}</h3>
        {current || step.progress === "unclear" ? <Badge tone={PROGRESS_TONES[step.progress]}>{PROGRESS_LABELS[step.progress]}</Badge> : null}
        {done ? <span className="su-step-done">Done</span> : null}
        {!done && !current && step.progress !== "unclear" ? <span className="su-step-later">{PROGRESS_LABELS[step.progress]}</span> : null}
      </div>
      {current ? (
        <div className="su-step-body">
          <p>{stepHelp(step)}</p>
          {(step.kind === "graph-permission" || step.kind === "registration") && chips.length ? (
            <PermissionChips chips={chips} />
          ) : null}
          {link || continuable || step.kind === "graph-permission" ? (
            <div className="su-step-actions">
              {link ? (
                <a className="btn" href={link.href} rel="noreferrer" target="_blank">
                  <Icon name="link" />{link.label}<span className="visually-hidden"> (opens in a new tab)</span>
                </a>
              ) : null}
              {step.kind === "graph-permission" && chips.length ? <CopyList text={permissionList(step)} /> : null}
              {continuable ? (
                <button className={amber ? "btn btn-primary" : "btn"} disabled={busy} onClick={onContinue} type="button">Continue setup</button>
              ) : null}
            </div>
          ) : null}
          {step.manual ? <p className="su-step-hint">When you have done it, press Continue setup: Keel checks it in your tenant. Steps are never ticked by hand.</p> : null}
        </div>
      ) : null}
      {step.kind === "graph-permission" && done ? (
        <p className="su-step-extra su-step-hint">
          Every permission this app holds, and any still missing, is in <a className="su-inline-link" href="#setup-permissions">Permissions</a> below.
        </p>
      ) : null}
    </li>
  );
}

function PermissionChips({ chips }: { chips: ReturnType<typeof permissionChips> }) {
  return (
    <ul aria-label="Permissions" className="su-perms">
      {chips.map((chip) => (
        <li className="su-perm" key={chip.code}>
          <span className="su-perm-words">{chip.words}</span>
          {chip.words !== chip.code ? <code className="su-perm-code">{chip.code}</code> : null}
        </li>
      ))}
    </ul>
  );
}

function CopyList({ text }: { text: string }) {
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: "Permission list copied" });
    } catch {
      toast({ tone: "warning", title: "Could not copy", detail: "Your browser blocked the clipboard. The Microsoft names are under each permission." });
    }
  }
  return <button className="btn" onClick={copy} type="button"><Icon name="page" />Copy permission list</button>;
}

const RADIUS = 20;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

// One segment per step: done green, waiting on someone amber, the rest the track colour.
function ProgressRing({ steps }: { steps: SetupStep[] }) {
  const counts = progressCounts(steps);
  const gap = steps.length > 1 ? 3 : 0;
  const length = steps.length ? CIRCUMFERENCE / steps.length : 0;
  return (
    <span className="su-ring" role="img" aria-label={`${counts.done} of ${counts.total} steps done`}>
      <svg aria-hidden="true" viewBox="0 0 48 48">
        {steps.map((step, index) => (
          <circle
            cx="24"
            cy="24"
            data-tone={step.progress === "done" ? "fine" : PROGRESS_TONES[step.progress] === "soon" || step.progress === "unclear" ? "soon" : undefined}
            fill="none"
            key={step.id}
            r={RADIUS}
            strokeDasharray={`${Math.max(0, length - gap)} ${CIRCUMFERENCE}`}
            strokeDashoffset={-index * length}
            strokeWidth="5"
            transform="rotate(-90 24 24)"
          />
        ))}
      </svg>
      <b>{counts.done}/{counts.total}</b>
    </span>
  );
}
