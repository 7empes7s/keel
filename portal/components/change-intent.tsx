"use client";

import { useMemo, useState } from "react";

import { RecordField, TechnicalDetails } from "@/components/technical-details";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { WINDOW_HOURS, type ChangeIntent, type IntentCandidate, type IntentTransition } from "@/lib/change-intents-view";
import { ago, formatTimestamp, fromNow, resourceLabel, words } from "@/lib/presentation";
import { toast } from "@/lib/toast";

// Roadmap task-93: an approved emergency change. KEEL keeps showing the change and does
// not roll back exactly the approved fields until the window ends; any other change to
// the same resource is handled as usual. When the window ends KEEL checks the resource
// again and acts on what it finds, never by undoing the approval blindly.

function fieldList(transitions: IntentTransition[]): string {
  const names = transitions.map((transition) => words(transition.field).toLowerCase());
  if (names.length <= 1) return names[0] ?? "no field";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

function personName(person: { name: string | null; readable: boolean } | null): string {
  if (!person) return "someone";
  return person.readable ? person.name ?? "someone" : "a person no longer readable";
}

function sideText(side: { present: boolean; value: unknown }): string {
  return side.present ? JSON.stringify(side.value) : "(absent)";
}

const SETTLED_WORDS: Record<string, string> = {
  "matches-baseline": "the setting was back as the baseline has it, so nothing was rolled back.",
  drifted: "it was still changed, so its policies acted on it as usual.",
  "awaiting-detection": "it had not been checked for changes since, so the next check decides.",
  unknown: "there was no baseline or no backup of this type to compare with, so nothing was rolled back.",
};

/** One sentence for the intent's state, in words. */
export function intentStateSentence(intent: ChangeIntent, now: string): string {
  const fields = fieldList(intent.transitions);
  switch (intent.state) {
    case "active": return `KEEL will not roll back the ${fields} change until ${formatTimestamp(intent.windowEnd)} (${fromNow(intent.windowEnd, now)}).`;
    case "scheduled": return `Approved ahead: the ${fields} change may be made from ${formatTimestamp(intent.windowStart)} (${fromNow(intent.windowStart, now)}).`;
    case "revoked": return `Revoked ${ago(intent.revokedAt, now)} by ${personName(intent.revokedBy)}${intent.revokeReason ? `: ${intent.revokeReason}` : ""}.`;
    default: return `Ended ${ago(intent.windowEnd, now)}.`;
  }
}

export function IntentCard({ intent, now, canRevoke = true }: { intent: ChangeIntent; now: string; canRevoke?: boolean }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const live = intent.state === "active" || intent.state === "scheduled";

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
      toast({ title: "Approval revoked", detail: "KEEL checked the resource again and acted on what it found." });
      window.location.reload();
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className={`item-card change-intent is-${intent.state}`}>
      <h3 className="change-intent-name">{resourceLabel(intent.naturalKey)}</h3>
      <p className="change-intent-sentence">{intentStateSentence(intent, now)}</p>
      <ul className="policy-facts">
        <li>Approved by {personName(intent.approver)} for {personName(intent.owner)}, <time dateTime={intent.approvedAt} title={formatTimestamp(intent.approvedAt)}>{ago(intent.approvedAt, now)}</time>. Reason: {intent.reason}</li>
        {intent.externalChangeId ? <li>Change ticket {intent.externalChangeId}.</li> : null}
        <li>Any other change to {resourceLabel(intent.naturalKey)} is still rolled back as its policies say.</li>
        {intent.settlement ? <li className="change-intent-settled">When it ended, KEEL checked again: {SETTLED_WORDS[intent.settlement.currentState] ?? SETTLED_WORDS.unknown}</li> : null}
      </ul>
      {live && canRevoke ? (
        <div className="form-actions change-intent-revoke">
          <input aria-label={`Why revoke the approval for ${resourceLabel(intent.naturalKey)}`} onChange={(event) => setReason(event.target.value)} placeholder="Why end it now?" value={reason} />
          <ConfirmButton
            confirmLabel="Revoke"
            description={<p>KEEL stops holding back the roll back of this change and checks {resourceLabel(intent.naturalKey)} again now.</p>}
            disabled={busy || reason.trim().length === 0}
            onConfirm={revoke}
            size="sm"
            title={`Revoke the approval for ${resourceLabel(intent.naturalKey)}?`}
          >
            Revoke
          </ConfirmButton>
        </div>
      ) : null}
      <TechnicalDetails>
        <RecordField label="Emergency change ID" usage={<>use with <code>POST /api/change-intents/&lt;id&gt;/revoke</code></>} value={intent.id} />
        <RecordField label="Decision digest" usage="carried by a mirrored change record" value={intent.decisionDigest} />
        <RecordField copy={false} label="Resource" value={`${intent.naturalKey} · ${intent.resourceType}`} />
        <RecordField copy={false} label="Approved transitions" value={intent.transitions.map((transition) => `${transition.field}: ${sideText(transition.before)} -> ${sideText(transition.after)}`).join("\n")} />
        <RecordField copy={false} label="Window" value={`${intent.windowStart} to ${intent.windowEnd} (end excluded)`} />
        <RecordField label="Owner principal ID" value={intent.owner.id} />
        <RecordField label="Approver principal ID" value={intent.approver.id} />
        {intent.sourceDriftId ? <RecordField label="Approved from drift ID" value={intent.sourceDriftId} /> : null}
        {intent.externalChangeId ? <RecordField label="External change ID" value={intent.externalChangeId} /> : null}
        <RecordField copy={false} label="State" value={intent.state} />
        {intent.revokedAt ? <RecordField copy={false} label="Revoked" value={`${intent.revokedAt} by ${intent.revokedBy?.id ?? "?"}`} /> : null}
        {intent.settlement ? <RecordField copy={false} label="Settlement" value={`${intent.settledAt} · ${intent.settlement.currentState}${intent.settlement.driftId ? ` · drift ${intent.settlement.driftId}` : ""}${intent.settlement.snapshotId ? ` · snapshot ${intent.settlement.snapshotId}` : ""}`} /> : null}
        <RecordField copy={false} label="Approved at" value={intent.approvedAt} />
      </TechnicalDetails>
    </li>
  );
}

/** Approve an emergency change from one open change, field by field. */
export function ApproveIntentForm({ changes, people }: { changes: IntentCandidate[]; people: { id: string; name: string }[] }) {
  const [driftId, setDriftId] = useState(changes[0]?.driftId ?? "");
  const change = useMemo(() => changes.find((candidate) => candidate.driftId === driftId) ?? null, [changes, driftId]);
  const [fields, setFields] = useState<string[]>([]);
  const [owner, setOwner] = useState("");
  const [hours, setHours] = useState<number>(4);
  const [ticket, setTicket] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  if (changes.length === 0) return <p className="empty-state">No open change can be approved. A change to an existing setting shows here once KEEL detects it.</p>;

  async function submit() {
    setBusy(true);
    try {
      const response = await fetch("/api/change-intents", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ driftId, fields, ownerPrincipalId: owner, windowHours: hours, externalChangeId: ticket.trim() || null, reason }),
      });
      if (!response.ok) {
        const { error } = (await response.json().catch(() => ({}))) as { error?: string };
        const detail = error === "owner-is-approver" ? "The person who made the change cannot approve it." : error === "approver-not-authorized" ? "You cannot approve changes." : "The approval was not recorded. Check the fields and try again.";
        toast({ tone: "warning", title: "Not approved", detail });
        return;
      }
      toast({ title: "Emergency change approved", detail: "KEEL keeps showing the change and will not roll back these fields until the window ends." });
      window.location.reload();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="change-intent-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <label className="filter-field">
        <span>Change</span>
        <select onChange={(event) => { setDriftId(event.target.value); setFields([]); }} value={driftId}>
          {changes.map((candidate) => <option key={candidate.driftId} value={candidate.driftId}>{resourceLabel(candidate.naturalKey)}, detected {formatTimestamp(candidate.detectedAt)}</option>)}
        </select>
      </label>
      <fieldset className="change-intent-fields">
        <legend>Fields to approve</legend>
        {change?.transitions.map((transition) => (
          <label className="checkbox" key={transition.field}>
            <input checked={fields.includes(transition.field)} onChange={(event) => setFields(event.target.checked ? [...fields, transition.field] : fields.filter((field) => field !== transition.field))} type="checkbox" />
            {words(transition.field)}
          </label>
        ))}
      </fieldset>
      <label className="filter-field">
        <span>Who made or owns the change</span>
        <select onChange={(event) => setOwner(event.target.value)} required value={owner}>
          <option value="">Choose a person</option>
          {people.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
        </select>
      </label>
      <label className="filter-field">
        <span>For how long</span>
        <select onChange={(event) => setHours(Number(event.target.value))} value={hours}>
          {WINDOW_HOURS.map((value) => <option key={value} value={value}>{value < 24 ? `${value} hour${value === 1 ? "" : "s"}` : `${value / 24} day${value === 24 ? "" : "s"}`}</option>)}
        </select>
      </label>
      <label className="filter-field">
        <span>Change ticket (optional)</span>
        <input onChange={(event) => setTicket(event.target.value)} placeholder="For example CHG0031337" value={ticket} />
      </label>
      <label className="filter-field">
        <span>Reason</span>
        <input onChange={(event) => setReason(event.target.value)} placeholder="Why is this change needed now?" required value={reason} />
      </label>
      <div className="form-actions">
        <button aria-busy={busy} className="btn btn-secondary" disabled={busy || fields.length === 0 || !owner || reason.trim().length === 0} type="submit">Approve emergency change</button>
      </div>
    </form>
  );
}
