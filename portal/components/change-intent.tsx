"use client";

import { useMemo, useState } from "react";

import { ChangedValuesStyles, SidesRow, Value } from "@/components/changed-values";
import { OptionPicker } from "@/components/pickers/option-picker";
import { Icon } from "@/components/shell/icons";
import { RecordField, TechnicalDetails } from "@/components/technical-details";
import { AlertList } from "@/components/ui/alert-list";
import { Badge } from "@/components/ui/badge";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { StatTiles } from "@/components/ui/stat-tiles";
import { valueText } from "@/lib/changed-values";
import { fieldWords } from "@/lib/changes-view";
import { WINDOW_HOURS, intentAlerts, intentBadge, intentEnd, intentResource, intentTiles, openChangeCount, settledBadge, shownTransitions, type ChangeIntent, type ChangeIntentsData, type IntentCandidate, type IntentMadeBy, type IntentPerson, type IntentPersonChoice, type IntentTransition } from "@/lib/change-intents-view";
import { ago, formatTimestamp, fromNow, resourceTypeLabel, words } from "@/lib/presentation";
import { personLabel } from "@/lib/sentences";
import { toast } from "@/lib/toast";
import { ReasonHint } from "@/components/reason-hint";
import { evidenceMessage, reasonProblem } from "@/lib/written-reason";

// Roadmap task-93: an approved emergency change. Keel keeps showing the change, and
// automatic rules do not undo exactly the approved fields until the window ends; any
// other change to the same resource is handled as usual. When the window ends Keel checks
// the resource again. It never puts the setting back by itself, so the copy never says it does.

function fieldList(transitions: IntentTransition[]): string {
  const names = shownTransitions(transitions).map((transition) => words(transition.field).toLowerCase());
  if (names.length <= 1) return names[0] ?? "approved";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

function personName(person: IntentPerson | null): string {
  if (!person) return "someone";
  return personLabel({ kind: "person", id: person.id, name: person.name === person.email ? null : person.name, email: person.email, readable: person.readable }, "someone");
}

function sideText(side: { present: boolean; value: unknown }): string {
  return side.present ? JSON.stringify(side.value) : "(absent)";
}


/** One sentence for the intent's state, in words. */
export function intentStateSentence(intent: ChangeIntent, now: string): string {
  const fields = fieldList(intent.transitions);
  switch (intent.state) {
    case "active": return `Automatic rules will not undo the ${fields} change until ${formatTimestamp(intent.windowEnd)} (${fromNow(intent.windowEnd, now)}).`;
    case "scheduled": return `Approved ahead: the ${fields} change may be made from ${formatTimestamp(intent.windowStart)} (${fromNow(intent.windowStart, now)}).`;
    case "revoked": return `Revoked ${ago(intent.revokedAt, now)} by ${personName(intent.revokedBy)}${intent.revokeReason ? `: ${intent.revokeReason}` : ""}.`;
    default: return `Ended ${ago(intent.windowEnd, now)}.`;
  }
}

/** One approved setting, as the baseline has it and as the approval allows it. */
function TransitionRows({ transitions }: { transitions: IntentTransition[] }) {
  const shown = shownTransitions(transitions);
  if (!shown.length) return <p className="pg-muted"><Icon name="info" />{NO_CHANGE_WORDS}</p>;
  return (
    <ul aria-label="Approved settings" className="cv-list">
      {shown.map((transition) => (
        <SidesRow
          after={transition.after.present ? <Value value={transition.after.value} /> : null}
          before={transition.before.present ? <Value value={transition.before.value} /> : null}
          key={transition.field}
          name={fieldWords(transition.field)}
          sides={SIDES}
        />
      ))}
    </ul>
  );
}

const SIDES = { before: "Baseline", after: "Approved" };
const NO_CHANGE_WORDS = "Only empty values or the order of a list differ. Nothing that changes behaviour.";

function IntentRecord({ intent }: { intent: ChangeIntent }) {
  return (
    <TechnicalDetails>
      <RecordField label="Emergency change ID" usage={<>use with <code>POST /api/change-intents/&lt;id&gt;/revoke</code></>} value={intent.id} />
      <RecordField label="Decision digest" usage="carried by a mirrored change record" value={intent.decisionDigest} />
      <RecordField copy={false} label="Setting" value={`${intent.naturalKey} · ${intent.resourceType}`} />
      <RecordField copy={false} label="Approved transitions" value={shownTransitions(intent.transitions).map((transition) => `${transition.field}: ${sideText(transition.before)} -> ${sideText(transition.after)}`).join("\n")} />
      <RecordField copy={false} label="Window" value={`${intent.windowStart} to ${intent.windowEnd} (end excluded)`} />
      <RecordField label="Owner principal ID" value={intent.owner.id} />
      <RecordField label="Approver principal ID" value={intent.approver.id} />
      {intent.sourceDriftId ? <RecordField label="Approved from drift ID" value={intent.sourceDriftId} /> : null}
      {intent.externalChangeId ? <RecordField label="External change ID" value={intent.externalChangeId} /> : null}
      <RecordField copy={false} label="State" value={intent.state} />
      {intent.revokedAt ? <RecordField copy={false} label="Revoked" value={`${intent.revokedAt} by ${intent.revokedBy?.id ?? "?"}`} /> : null}
      {intent.settlement ? <RecordField copy={false} label="Settlement" value={`${intent.settledAt} · ${intent.settlement.currentState}${intent.settlement.driftId ? ` · drift ${intent.settlement.driftId}` : ""}${intent.settlement.snapshotId ? ` · backup ${intent.settlement.snapshotId}` : ""}`} /> : null}
      <RecordField copy={false} label="Approved at" value={intent.approvedAt} />
    </TechnicalDetails>
  );
}

/** An approval in force or waiting to start: what is held back, until when, and Revoke. */
export function IntentCard({ intent, now, canRevoke = true }: { intent: ChangeIntent; now: string; canRevoke?: boolean }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const live = intent.state === "active" || intent.state === "scheduled";
  const resource = intentResource(intent);
  const badge = intentBadge(intent);

  async function revoke() {
    setBusy(true);
    try {
      const response = await fetch(`/api/change-intents/${encodeURIComponent(intent.id)}/revoke`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ reason }),
      });
      if (!response.ok) {
        toast({ tone: "warning", title: "Not revoked", detail: response.status === 409 ? "This approval has already ended." : "The approval could not be revoked." });
        return;
      }
      toast({ title: "Approval revoked", detail: "KEEL checked the setting again and acted on what it found." });
      window.location.reload();
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className={`pg-card change-intent is-${intent.state}`} data-tone={badge.tone} id={`intent-${intent.id}`}>
      <div className="pg-card-head">
        <h3 className="change-intent-name">{resource}</h3>
        <Badge tone={badge.tone}>{badge.label}</Badge>
        {intent.selfApproved ? <Badge icon="person" tone="soon" title="The person who made the change approved it, under solo approval mode">Self-approved</Badge> : null}
      </div>
      <p className="change-intent-sentence">{intentStateSentence(intent, now)}</p>
      <TransitionRows transitions={intent.transitions} />
      <dl className="pg-facts">
        <div><dt>Approved by</dt><dd>{personName(intent.approver)}, <time dateTime={intent.approvedAt} title={formatTimestamp(intent.approvedAt)}>{ago(intent.approvedAt, now)}</time></dd></div>
        <div><dt>Change made by</dt><dd>{personName(intent.owner)}</dd></div>
        <div><dt>Reason</dt><dd>{intent.reason}</dd></div>
        {intent.externalChangeId ? <div><dt>Change ticket</dt><dd>{intent.externalChangeId}</dd></div> : null}
      </dl>
      <p className="pg-help change-intent-other"><Icon name="info" />Other changes to this {resourceKind(intent)} follow your automatic rules as usual. When the approval ends, Keel checks it again but does not put the setting back by itself.</p>
      {live && canRevoke ? (
        <div className="form-actions change-intent-revoke">
          <input aria-label={`Why revoke the approval for ${resource}`} onChange={(event) => setReason(event.target.value)} placeholder="Why end it now?" value={reason} />
          <ReasonHint value={reason} />
          <ConfirmButton
            confirmLabel="Revoke"
            description={<p>Automatic rules can act on this change again, and Keel checks {resource} again now. Keel does not put the setting back by itself.</p>}
            disabled={busy || reasonProblem(reason) !== null}
            onConfirm={revoke}
            size="sm"
            title={`Revoke the approval for ${resource}?`}
          >
            Revoke
          </ConfirmButton>
        </div>
      ) : null}
      <IntentRecord intent={intent} />
    </li>
  );
}

function resourceKind(intent: ChangeIntent): string {
  return resourceTypeLabel(intent.resourceType);
}

/** Approvals that ended or were revoked, in one compact table: how each ended and what
 *  KEEL found when it checked again. */
export function EndedIntents({ intents, now }: { intents: ChangeIntent[]; now: string }) {
  return (
    <div className="pg-table-wrap">
      <table className="pg-table">
        <thead>
          <tr><th scope="col">Change</th><th scope="col">How it ended</th><th scope="col">Checked again</th><th scope="col">When</th></tr>
        </thead>
        <tbody>
          {intents.map((intent) => {
            const badge = intentBadge(intent);
            const settled = settledBadge(intent);
            return (
              <tr className={`change-intent is-${intent.state}`} data-tone={settled?.tone ?? "neutral"} id={`intent-${intent.id}`} key={intent.id}>
                <th scope="row">
                  <span className="pg-row-name">{intentResource(intent)}</span>
                  <small>{shownTransitions(intent.transitions).map((transition) => fieldWords(transition.field)).join(", ") || NO_CHANGE_WORDS}</small>
                </th>
                <td data-label="How it ended">
                  <Badge tone={badge.tone}>{badge.label}</Badge>
                  <small className="change-intent-sentence">{intentStateSentence(intent, now)}</small>
                </td>
                <td data-label="Checked again">
                  {settled ? <><Badge tone={settled.tone}>{settled.label}</Badge><small className="change-intent-settled">{settled.about}</small></> : <span className="pg-muted">Not yet</span>}
                </td>
                <td data-label="When"><time dateTime={intentEnd(intent)} title={formatTimestamp(intentEnd(intent))}>{ago(intentEnd(intent), now)}</time>
                  <IntentRecord intent={intent} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const AUDIT_LOG_NAMES: Record<string, string> = { audit: "Microsoft Entra audit log", "intune-audit": "Intune audit log" };

/** Where "Who made the change" came from, in one line under the picker. */
export function madeBySentence(madeBy: IntentMadeBy | null | undefined, chosen: string): { tone: "fine" | "low" | "neutral"; text: string } {
  const log = madeBy?.source ? AUDIT_LOG_NAMES[madeBy.source] ?? "audit log" : "audit log";
  const at = madeBy?.at ? ` on ${formatTimestamp(madeBy.at)}` : "";
  switch (madeBy?.state) {
    case "keel-user":
      return madeBy.principalId === chosen
        ? { tone: "fine", text: `Filled in from the ${log}: ${madeBy.who ?? "this person"} made the change${at}.` }
        : { tone: "low", text: `The ${log} says ${madeBy.who ?? "someone else"} made the change${at}.` };
    case "not-keel-user": return { tone: "low", text: `The ${log} says ${madeBy.who ?? "an account Keel has no name for"} made the change${at}, but they have no Keel account. Choose who answers for it.` };
    case "app": return { tone: "low", text: `The ${log} says the app ${madeBy.who ?? "Keel has no name for"} made the change${at}. Choose the person who answers for it.` };
    case "several": return { tone: "low", text: `The ${log} names more than one account for this change. Choose the person who made it.` };
    case "unknown": return { tone: "neutral", text: madeBy.source ? `The ${log} does not say who made this change. Choose the person.` : "Keel reads no audit log for this setting type. Choose the person who made the change." };
    default: return { tone: "neutral", text: "Keel could not tell who made this change. Choose the person." };
  }
}

/** Approve an emergency change from one open change, field by field. */
export function ApproveIntentForm({ changes, people, now, openCount = changes.length }: { changes: IntentCandidate[]; people: IntentPersonChoice[]; now: string; openCount?: number }) {
  const [driftId, setDriftId] = useState(changes[0]?.driftId ?? "");
  const change = useMemo(() => changes.find((candidate) => candidate.driftId === driftId) ?? null, [changes, driftId]);
  const [fields, setFields] = useState<string[]>([]);
  const [owner, setOwner] = useState(changes[0]?.madeBy?.principalId ?? "");
  const [hours, setHours] = useState<number>(4);
  const [ticket, setTicket] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const ticketProblem = ticket.trim() ? evidenceMessage("ticket", ticket) : null;
  const changeOptions = useMemo(() => changes.map((candidate) => {
    const count = shownTransitions(candidate.transitions).length;
    return {
      value: candidate.driftId,
      label: intentResource(candidate),
      hint: `${count === 1 ? "1 setting" : `${count} settings`} · detected ${candidate.detectedAt ? ago(candidate.detectedAt, now) : "at an unknown time"}`,
    };
  }), [changes, now]);
  const personOptions = useMemo(() => people.map((person) => ({ value: person.id, label: person.name, ...(person.email ? { hint: person.email } : {}) })), [people]);

  if (changes.length === 0) return <p className="pg-empty"><Icon name="info" />No open change to approve. One shows here once KEEL detects it.</p>;

  // Settings where only an empty value or list order differs are not offered, but are
  // approved with the rest so automatic rules do not undo a change nobody can see.
  const picks = change ? shownTransitions(change.transitions) : [];
  const silent = change ? change.transitions.filter((transition) => transition.noChange).map((transition) => transition.field) : [];
  const ready = fields.length > 0 || (picks.length === 0 && silent.length > 0);
  const madeBy = madeBySentence(change?.madeBy, owner);

  function pickChange(id: string) {
    setDriftId(id);
    setFields([]);
    // Who made it, from the audit log when it names a Keel user; else the choice is the reader's.
    const next = changes.find((candidate) => candidate.driftId === id);
    setOwner(next?.madeBy?.principalId ?? "");
  }

  async function submit() {
    setBusy(true);
    try {
      const response = await fetch("/api/change-intents", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ driftId, fields: [...fields, ...silent], ownerPrincipalId: owner, windowHours: hours, externalChangeId: ticket.trim() || null, reason }),
      });
      if (!response.ok) {
        const { error } = (await response.json().catch(() => ({}))) as { error?: string };
        const detail = error === "owner-is-approver" ? "The person who made the change cannot approve it while approvals need two people." : error === "reason-required" ? "Approving your own emergency change needs a reason that says why, in a few words." : error === "approver-not-authorized" ? "You cannot approve changes." : "The approval was not recorded. Check the fields and try again.";
        toast({ tone: "warning", title: "Not approved", detail });
        return;
      }
      toast({ title: "Emergency change approved", detail: "Keel keeps showing the change, and automatic rules will not undo these settings until the window ends." });
      window.location.reload();
    } finally {
      setBusy(false);
    }
  }

  const until = formatTimestamp(new Date(Date.parse(now) + hours * 3_600_000).toISOString());
  const durations = WINDOW_HOURS.map((value) => ({ value, label: value < 24 ? `${value} hour${value === 1 ? "" : "s"}` : `${value / 24} day${value === 24 ? "" : "s"}` }));
  // The settings list changes height with the chosen change, so it sits after every
  // typed field: picking a change or a setting never moves a box under the pointer.
  return (
    <form className="pg-form change-intent-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <div className="pg-wide change-intent-pick">
        <OptionPicker label="Change" onChange={pickChange} options={changeOptions} placeholder="Find an open change by name" value={driftId || null} />
        {openCount > changes.length ? <small className="field-help">The newest {changes.length.toLocaleString("en-GB")} of {openCount.toLocaleString("en-GB")} open changes. Type to find one by name.</small> : null}
      </div>
      <OptionPicker label="Who made the change" onChange={setOwner} options={personOptions} placeholder="Choose a person" value={owner || null} />
      <label className="filter-field">
        <span>For how long</span>
        <select onChange={(event) => setHours(Number(event.target.value))} value={hours}>
          {durations.map((duration) => <option key={duration.value} value={duration.value}>{duration.label}</option>)}
        </select>
      </label>
      <label className="filter-field">
        <span>Change ticket (optional)</span>
        <input onChange={(event) => setTicket(event.target.value)} placeholder="For example CHG0031337" value={ticket} />
        {ticket.trim() && ticketProblem ? <small className="reason-hint" role="status">{ticketProblem}</small> : null}
      </label>
      <label className="filter-field pg-wide">
        <span>Reason</span>
        <input onChange={(event) => setReason(event.target.value)} placeholder="Why is this change needed now?" required value={reason} />
        <ReasonHint value={reason} />
      </label>
      {/* Under every typed field, like the settings list: its length follows the change. */}
      <p className="pg-wide change-intent-madeby" data-tone={madeBy.tone} role="status"><Icon name={madeBy.tone === "fine" ? "check-circle" : "info"} />{madeBy.text}</p>
      <fieldset className="pg-wide pg-picks">
        <legend>Settings to approve</legend>
        {picks.length === 0 && silent.length ? <p className="pg-muted"><Icon name="info" />{NO_CHANGE_WORDS}</p> : null}
        {picks.map((transition) => (
          <label className="pg-pick" data-checked={fields.includes(transition.field) || undefined} key={transition.field}>
            <input checked={fields.includes(transition.field)} onChange={(event) => setFields(event.target.checked ? [...fields, transition.field] : fields.filter((field) => field !== transition.field))} type="checkbox" />
            <span className="pg-pick-name">{words(transition.field)}</span>
            <span className="pg-pick-values">
              <span data-empty={!transition.before.present || undefined} data-side="before">{transition.before.present ? valueText(transition.before.value) : "Not set"}</span>
              <Icon name="chevron" />
              <span data-side="after">{transition.after.present ? valueText(transition.after.value) : "Not set"}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="pg-wide pg-form-foot">
        <p className="pg-summary" aria-live="polite">{ready
          ? <><Icon name="pause" />Automatic rules will not undo {fields.length === 0 ? "this change" : fields.length === 1 ? "1 setting" : `${fields.length} settings`} on {change ? intentResource(change) : "this change"} until {until}.</>
          : <><Icon name="info" />Choose the settings to approve.</>}</p>
        <button aria-busy={busy} className="btn btn-secondary" disabled={busy || !ready || !owner || reasonProblem(reason) !== null || (ticket.trim() !== "" && ticketProblem !== null)} type="submit">Approve emergency change</button>
      </div>
    </form>
  );
}

/** The page body: alerts, tiles, approvals in force, the approve form, then ended ones. */
export function EmergencyChangesView({ data }: { data: ChangeIntentsData }) {
  const now = data.generatedAt;
  const live = data.intents.filter((intent) => intent.state === "active" || intent.state === "scheduled");
  const past = data.intents.filter((intent) => intent.state === "revoked" || intent.state === "ended");
  return (
    <div className="pg-page">
      <ChangedValuesStyles />
      <section aria-labelledby="ec-attention-heading" id="ec-attention">
        <div className="rs-section-head">
          <h2 id="ec-attention-heading"><Icon name="alert" />Needs your attention</h2>
        </div>
        <AlertList calm="Nothing needs you. Changes follow your automatic rules as usual." items={intentAlerts(data)} />
      </section>
      <StatTiles tiles={intentTiles(data)} />
      <section aria-labelledby="ec-approved-heading" id="ec-approved">
        <div className="rs-section-head">
          <div>
            <h2 id="ec-approved-heading"><Icon name="pause" />Approved now</h2>
            <p className="rs-sub">Automatic rules leave only these settings alone, until the approval ends.</p>
          </div>
          <Badge tone={live.length ? "soon" : "fine"}>{live.length ? `${live.length} in force or waiting` : "None"}</Badge>
        </div>
        {live.length === 0
          ? <p className="ui-calm"><Icon name="check-circle" />Nothing is approved right now.</p>
          : <ul className="pg-cards change-intent-list">{live.map((intent) => <IntentCard intent={intent} key={intent.id} now={now} />)}</ul>}
      </section>
      <section aria-labelledby="ec-approve-heading" className="pg-panel" id="ec-approve">
        <div className="rs-section-head">
          <div>
            <h2 id="ec-approve-heading"><Icon name="check" />Approve an emergency change</h2>
            <p className="rs-sub">Pick an open change and the settings to keep for a while.</p>
          </div>
          <Badge tone="neutral">{`${openChangeCount(data).toLocaleString("en-GB")} open`}</Badge>
        </div>
        <ApproveIntentForm changes={data.changes} now={now} openCount={openChangeCount(data)} people={data.people} />
      </section>
      {past.length > 0 ? (
        <section aria-labelledby="ec-ended-heading" id="ec-ended">
          <div className="rs-section-head">
            <div>
              <h2 id="ec-ended-heading"><Icon name="clock" />Ended</h2>
              <p className="rs-sub">When an approval ends, KEEL checks the setting again.</p>
            </div>
            <Badge tone="neutral">{String(past.length)}</Badge>
          </div>
          <EndedIntents intents={past} now={now} />
        </section>
      ) : null}
    </div>
  );
}
