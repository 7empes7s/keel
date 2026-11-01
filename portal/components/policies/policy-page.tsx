"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { NewRuleSheet } from "@/components/policies/new-rule-sheet";
import { RuleRecord } from "@/components/policies/rule-record";
import { PolicyActivation } from "@/components/policy-preview";
import { Icon } from "@/components/shell/icons";
import { RecordField, TechnicalDetails } from "@/components/technical-details";
import { Badge } from "@/components/ui/badge";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { Person } from "@/components/ui/person";
import { Verdict } from "@/components/verdict";
import { changeRule, deleteRule, type RuleChange } from "@/lib/policy-change";
import {
  RULE_KINDS,
  RULE_STATES,
  actionKindLine,
  actionLine,
  actionName,
  actionOutcome,
  ceilingWords,
  createdWords,
  lastActionWords,
  rateWords,
  ruleKind,
  ruleSentence,
  ruleState,
  runAsRef,
  watchChips,
} from "@/lib/policy-view";
import type { ActivationPreview, Policy, PolicyAction } from "@/lib/policies";
import { toast } from "@/lib/toast";

// One rule's page (Policies spec, section 3.6): the sentence once, then what it watches,
// what it does, who it acts as and its limits as a facts grid, its newest actions with a
// link to each job, and the controls. The one amber action is Resume (paused) or, for
// an undo rule that is off, "Preview turning on"; Turn off is outlined. Ids stay in the
// record at the foot.

const TONES = { running: "fine", paused: "soon", stopped: "urgent", off: "neutral" } as const;

export function PolicyPage({ canEdit, policy, actions, halted, now = new Date().toISOString(), initialPreview = null }: {
  canEdit: boolean;
  policy: Policy;
  actions: PolicyAction[];
  halted: boolean;
  now?: string;
  initialPreview?: ActivationPreview | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<RuleChange | "delete" | null>(null);
  const [editing, setEditing] = useState(false);
  const kind = ruleKind(policy);
  const state = ruleState(policy);
  const words = RULE_STATES[state];
  const person = runAsRef(policy);
  const rate = rateWords(policy);
  const previewing = canEdit && kind === "undo" && state === "off" && !halted;

  async function change(change: RuleChange) {
    setBusy(change);
    try {
      const result = await changeRule(policy.id, change);
      if (!result.ok) { toast({ tone: "warning", title: "Not changed", detail: result.reason }); return; }
      toast({ title: change === "resume" ? `${policy.name} resumed` : change === "turn-off" ? `${policy.name} turned off` : `${policy.name} turned on` });
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    setBusy("delete");
    try {
      const result = await deleteRule(policy.id);
      if (!result.ok) { toast({ tone: "warning", title: "Not deleted", detail: result.reason }); return; }
      toast({ title: `${policy.name} deleted`, detail: "It no longer acts. Its past actions stay in Activity." });
      router.push("/rules");
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  const detail = halted ? "Automation is stopped by an operator, so this rule does not act until it is started again."
    : state === "stopped" ? "The account it acts as lost the restorer role. Give it back on the People page, then resume the rule."
    : state === "paused" ? `${lastActionWords(policy, now)}. Nothing new is undone by it until someone resumes it.`
    : state === "off" ? (kind === "undo" ? "It is off. Preview what it would undo before turning it on." : "It is off. Turn it on when needed.")
    : `${lastActionWords(policy, now)}.`;
  const verdictAction = canEdit && state === "paused" && !halted ? { label: "Resume", onClick: () => void change("resume"), busy: busy === "resume" } : null;

  return (
    <div className="po-page po-detail">
      <Verdict action={verdictAction} detail={detail} text={ruleSentence(policy)} tone={halted ? "urgent" : TONES[state]} />
      <div data-layer="explanation">
        {previewing ? (
          <section aria-labelledby="po-preview-heading" className="po-card po-activation">
            <h2 id="po-preview-heading"><Icon name="show" />Before it turns on</h2>
            <p className="po-plain">What it would undo today, and what it would refuse. Turning it on approves nothing in advance.</p>
            <PolicyActivation initialPreview={initialPreview} name={policy.name} now={now} policyId={policy.id} />
          </section>
        ) : null}

        <dl className="po-facts">
          <div>
            <dt><Icon name="show" />Watches</dt>
            <dd className="po-chips">{watchChips(policy).map((chip) => <span className="po-chip" key={chip.label} title={chip.hint}>{chip.icon ? <Icon name={chip.icon} /> : null}{chip.label}</span>)}</dd>
          </div>
          <div>
            <dt><Icon name={RULE_KINDS[kind].icon} />Does</dt>
            <dd>{RULE_KINDS[kind].does}</dd>
          </div>
          <div>
            <dt><Icon name="clock" />Limits</dt>
            <dd className="po-limits">
              <span><b>{rate ?? "No limit"}</b><small>{rate ? "then it pauses itself" : "on how often it acts"}</small></span>
              <span><b>{ceilingWords(policy)}</b><small>the most risky change it may touch</small></span>
            </dd>
          </div>
          <div>
            <dt><Icon name="settings" />Acting as</dt>
            <dd className="po-person">
              {person ? <>
                <Link className="po-person-link" href={`/people#person-${encodeURIComponent(person.id)}`}><Person person={person} /></Link>
                {state === "stopped" ? <small className="po-help" data-tone="urgent">Needs the restorer role, then Resume.</small> : <small className="po-help">Checked again before every undo.</small>}
              </> : <><span className="po-nobody"><Icon name="bell" />Nobody</span><small className="po-help">{kind === "alert" ? "An alert changes nothing, so no account is needed." : "Approved undos run as the approver's own access."}</small></>}
            </dd>
          </div>
        </dl>

        <section aria-labelledby="po-actions-heading" className="po-section">
          <div className="po-section-head">
            <h2 id="po-actions-heading">Recent actions</h2>
            <small>{actions.length ? `Newest ${actions.length} · each opens its job` : null}</small>
          </div>
          {kind === "alert" ? (
            <p className="sel-empty">Alert rules send alerts and change nothing. <Link className="po-inline-link" href="/alerts">Open alerts</Link></p>
          ) : actions.length === 0 ? (
            <p className="sel-empty">{policy.last_action_at ? "Its actions could not be read right now." : "It has not acted yet."}</p>
          ) : (
            <ul className="po-actions">
              {actions.map((action) => {
                const outcome = actionOutcome(action);
                return (
                  <li className="po-action" data-tone={outcome.tone === "neutral" ? undefined : outcome.tone} key={action.job_id}>
                    <span aria-hidden="true" className="po-kind" data-tone={outcome.tone === "neutral" ? undefined : outcome.tone}><Icon name={RULE_KINDS[kind].icon} /></span>
                    <span className="po-row-name">
                      <Link className="po-row-link" href={`/jobs/${encodeURIComponent(action.job_id)}`}>{actionName(action)}</Link>
                      <small>{actionKindLine(action)}</small>
                    </span>
                    <span className="po-row-mid">
                      <Badge icon={outcome.icon} tone={outcome.tone}>{outcome.label}</Badge>
                      <small>{actionLine(action, now)}</small>
                    </span>
                    <span className="po-row-acts"><Link className="btn btn-sm" href={`/jobs/${encodeURIComponent(action.job_id)}`}>Open job</Link></span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <p className="po-muted">{createdWords(policy)}.</p>

        {canEdit ? (
          <div className="po-controls">
            {kind === "alert" ? <Link className="btn" href="/alerts"><Icon name="bell" />Open alerts</Link> : null}
            {state === "stopped" ? <Link className="btn" href="/people">Open People</Link> : null}
            {state === "off" && kind !== "undo" ? <button aria-busy={busy === "turn-on" || undefined} className="btn" disabled={busy !== null} onClick={() => void change("turn-on")} type="button"><Icon name="play" />Turn on</button> : null}
            {policy.enabled ? (
              <ConfirmButton confirmLabel="Turn off" description={<p>{policy.name} stops acting on new changes.{kind === "undo" ? " It needs a preview to turn back on." : ""}</p>} disabled={busy !== null} onConfirm={() => change("turn-off")} title={`Turn off ${policy.name}?`}>
                <Icon name="pause" />Turn off
              </ConfirmButton>
            ) : null}
            <button className="btn" disabled={busy !== null} onClick={() => setEditing(true)} type="button"><Icon name="edit" />Edit</button>
            <Link className="btn" href={`/activity?what=policy`}>Open its history</Link>
            <ConfirmButton
              acknowledge={<>I understand {policy.name} stops acting and cannot be brought back.</>}
              confirmLabel="Delete rule"
              description={<p>{policy.name} is turned off and removed from the list. What it already did stays in Activity, and its jobs stay open. To use it again, create a new rule.</p>}
              disabled={busy !== null}
              onConfirm={remove}
              title={`Delete ${policy.name}?`}
              tone="danger"
            >
              <Icon name="trash" />Delete
            </ConfirmButton>
          </div>
        ) : null}
        {editing && canEdit ? <NewRuleSheet onClose={() => setEditing(false)} policy={policy} /> : null}

        <TechnicalDetails>
          <RuleRecord actions={actions} policy={policy} />
          <RecordField copy={false} label="Read with" value={`GET /api/policies/${policy.id}`} />
        </TechnicalDetails>
      </div>
    </div>
  );
}
