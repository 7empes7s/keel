"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Icon } from "@/components/shell/icons";
import { RecordField, TechnicalDetails } from "@/components/technical-details";
import { Badge } from "@/components/ui/badge";
import { askFixApproval, planFix, readFixProgress, type FixPlan } from "@/lib/compliance-change";
import {
  FIX_STEPS,
  fixAction,
  fixCandidates,
  fixEffect,
  fixObjectName,
  fixPlanProblem,
  fixSetting,
  fixValue,
} from "@/lib/compliance-view";
import { refusalSentence } from "@/lib/changes-view";
import { ago } from "@/lib/presentation";
import { toast } from "@/lib/toast";
import type { ComplianceFinding, ComplianceFixCandidate } from "@/lib/types";

// "Make it pass" (CoreView gap 6): one row per object the control fails on, with the
// setting, its value now and after. A row's button asks Keel to plan the change (a dry
// run against the live tenant); a ready plan goes to the approvers with a reason. The
// row says at each step where it stands, and nothing is written before an approval.

type RowState =
  | { step: "idle" }
  | { step: "planning"; artifactId: string; jobId: string }
  | { step: "planned"; plan: FixPlan }
  | { step: "failed"; message: string | null }
  | { step: "sent" };

export function FixPanel({ finding, canRestore, now }: { finding: ComplianceFinding; canRestore: boolean; now: string }) {
  const candidates = fixCandidates(finding);
  if (candidates.length === 0) return null;
  const effect = fixEffect(finding);
  return (
    <section aria-labelledby="cp-fix-heading" className="cp-block cp-fix">
      <h3 id="cp-fix-heading">
        <Icon name="check-circle" />{fixAction(finding)}
        <Badge icon={null} tone="fine">Keel can fix this</Badge>
      </h3>
      {effect ? <p className="cp-muted">{effect}</p> : null}
      <ul aria-label="Objects to fix" className="cp-fix-list">
        {candidates.map((candidate) => (
          <FixRow candidate={candidate} canRestore={canRestore} finding={finding} key={candidate.naturalKey} now={now} primary={candidates.length === 1} />
        ))}
      </ul>
      <p className="cp-muted">{canRestore ? FIX_STEPS : "Ask someone with the restore permission to make this change."}</p>
    </section>
  );
}

function FixRow({ finding, candidate, canRestore, now, primary }: {
  finding: ComplianceFinding;
  candidate: ComplianceFixCandidate;
  canRestore: boolean;
  now: string;
  // One object: its button is the panel's one main action. Several: each is secondary.
  primary: boolean;
}) {
  const [state, setState] = useState<RowState>({ step: "idle" });
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState("");
  const name = fixObjectName(candidate);

  // While Keel plans the change, look every 2 seconds for the saved plan or a failure.
  const planning = state.step === "planning" ? state : null;
  useEffect(() => {
    if (!planning) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async (attempt: number) => {
      try {
        const progress = await readFixProgress(planning.artifactId, planning.jobId);
        if (cancelled) return;
        if (progress.state === "planned") { setState({ step: "planned", plan: progress.plan }); return; }
        if (progress.state === "failed") { setState({ step: "failed", message: progress.message }); return; }
        if (attempt >= 90) { setState({ step: "failed", message: "Planning took longer than 3 minutes." }); return; }
        timer = setTimeout(() => void poll(attempt + 1), 2000);
      } catch {
        if (!cancelled) setState({ step: "failed", message: "The plan could not be read." });
      }
    };
    void poll(0);
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [planning]);

  async function start() {
    setBusy(true);
    try {
      const started = await planFix(finding.id, candidate.naturalKey);
      if (!started.ok) { toast({ tone: "warning", title: "The fix was not planned", detail: started.reason }); return; }
      setState({ step: "planning", artifactId: started.artifactId, jobId: started.jobId });
    } finally {
      setBusy(false);
    }
  }

  async function send(plan: FixPlan) {
    setBusy(true);
    try {
      const sent = await askFixApproval(plan.id, reason.trim());
      if (!sent.ok) { toast({ tone: "warning", title: "Not sent for approval", detail: sent.reason }); return; }
      setState({ step: "sent" });
      toast({ title: "Sent to approvers", detail: "Nothing changes until one of them approves." });
    } finally {
      setBusy(false);
    }
  }

  const plan = state.step === "planned" ? state.plan : null;
  const ready = plan?.status === "completed" && plan.complianceFix !== null;
  return (
    <li className="cp-fix-row" data-step={state.step}>
      <div className="cp-fix-main">
        <span className="cp-fix-name">
          <b>{name}</b>
          <small>{fixSetting(finding)} · in the backup taken {ago(candidate.seenAt, now)}</small>
        </span>
        <span aria-label={`${fixSetting(finding)}: now ${fixValue(candidate.from)}, after ${fixValue(candidate.to)}`} className="cp-fix-values" role="img">
          <Badge icon="x-circle" tone="urgent">{fixValue(candidate.from)}</Badge>
          <Icon name="chevron" />
          <Badge icon="check-circle" tone="fine">{fixValue(candidate.to)}</Badge>
        </span>
        <span className="cp-fix-act">
          {state.step === "idle" && canRestore ? (
            <button aria-busy={busy || undefined} className={primary ? "btn btn-primary btn-sm" : "btn btn-sm"} disabled={busy} onClick={() => void start()} type="button">Make it pass</button>
          ) : null}
          {state.step === "planning" ? <Badge icon="clock" tone="neutral">Planning</Badge> : null}
          {state.step === "planned" ? (ready ? <Badge icon="check-circle" tone="fine">Ready for approval</Badge> : <Badge icon="x-circle" tone="urgent">Refused</Badge>) : null}
          {state.step === "failed" ? <Badge icon="x-circle" tone="urgent">Not planned</Badge> : null}
          {state.step === "sent" ? <Badge icon="clock" tone="soon">Waiting for approval</Badge> : null}
        </span>
      </div>

      {state.step === "planning" ? <p aria-live="polite" className="cp-muted">Reading {name} in the live tenant and planning the change…</p> : null}

      {plan && ready ? (
        <div className="cp-fix-confirm">
          <p className="cp-muted">
            Keel will change only “{fixSetting(finding)}” on {name}, from {fixValue(plan.complianceFix?.from)} to {fixValue(plan.complianceFix?.to)}, and write every other setting back as it is now.
          </p>
          <label className="filter-field">
            <span>Why make this change?</span>
            <input onChange={(event) => setReason(event.target.value)} placeholder="Reason for the approver" value={reason} />
          </label>
          <button aria-busy={busy || undefined} className="btn btn-primary btn-sm" disabled={busy || reason.trim().length === 0} onClick={() => void send(plan)} type="button">
            Ask for approval
          </button>
        </div>
      ) : null}

      {plan && !ready ? (
        <div className="cp-fix-problem" role="alert">
          <p>A safety check stopped this change, so it cannot be approved.</p>
          {(plan.guardRefusals ?? []).map((item, index) => <p className="cp-muted" key={index}>{refusalSentence(item, name)}</p>)}
          <TechnicalDetails summary="Error details">
            <RecordField label="Restore plan ID" value={plan.id} />
            <RecordField copy={false} label="Status" value={plan.status} />
            {(plan.guardRefusals ?? []).map((item, index) => <RecordField copy={false} key={index} label="Refusal" value={item.reason} />)}
          </TechnicalDetails>
        </div>
      ) : null}

      {state.step === "failed" ? (
        <div className="cp-fix-problem" role="alert">
          <p>{fixPlanProblem(state.message)}</p>
          {state.message ? (
            <TechnicalDetails summary="Error details">
              <RecordField copy={false} label="Message" value={state.message} />
            </TechnicalDetails>
          ) : null}
          {canRestore ? <button className="btn btn-sm" onClick={() => setState({ step: "idle" })} type="button">Try again</button> : null}
        </div>
      ) : null}

      {state.step === "sent" ? (
        <p className="cp-muted">Sent to approvers. Nothing changes until one of them approves. <Link className="cp-inline-link" href="/approvals">Open approvals</Link></p>
      ) : null}
    </li>
  );
}
