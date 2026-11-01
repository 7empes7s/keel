"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";

import { DetailsSheet } from "@/components/baselines/details-sheet";
import { distinctPeople } from "@/lib/people-choices";
import { OptionPicker } from "@/components/pickers/option-picker";
import type { ChoiceOption } from "@/components/pickers/segmented";
import { Icon } from "@/components/shell/icons";
import { addDays, endOfDay, grantException } from "@/lib/compliance-change";
import { EXCEPTION_EFFECT, controlName, formatDay, grantLabel, ownerName } from "@/lib/compliance-view";
import type { PrincipalView } from "@/lib/principals";
import { toast } from "@/lib/toast";
import type { ComplianceFinding } from "@/lib/types";
import { reasonMessage } from "@/lib/written-reason";

export interface Granted { owner: string; ownerName: string; reason: string; expiresAt: string }

const PRESETS = [30, 90] as const;
const OTHER = "__other__";

// Grant or renew an exception on one or more failing controls: who owns it (a person in
// Keel, or a team typed in), why, and until when (30 or 90 days, or a date). One call per
// control; the engine re-checks the permission and that the end is in the future.
export function ExceptionSheet({ findings, today, onDone, onClose }: {
  findings: ComplianceFinding[];
  today: string;
  onDone: (granted: Record<string, Granted>) => void;
  onClose: () => void;
}) {
  const first = findings[0];
  const prior = findings.length === 1 ? first?.exception ?? null : null;
  const [people, setPeople] = useState<PrincipalView[] | null | "unavailable">(null);
  const [owner, setOwner] = useState<string | null>(null);
  const [typed, setTyped] = useState(prior?.owner ?? "");
  const [reason, setReason] = useState(prior?.reason ?? "");
  const [until, setUntil] = useState(addDays(today, 90));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // People who can own it: everyone enabled in Keel. Listing them needs the users
  // permission; without it, the owner is typed in.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/principals")
      .then(async (response) => (response.ok ? ((await response.json()) as { principals: PrincipalView[] }).principals : "unavailable" as const))
      .catch(() => "unavailable" as const)
      .then((list) => {
        if (cancelled) return;
        const humans = list === "unavailable" ? list : list.filter((person) => !person.disabled_at && !person.system_kind);
        setPeople(humans);
        const known = Array.isArray(humans) && prior?.owner ? humans.find((person) => person.email.toLowerCase() === prior.owner!.trim().toLowerCase()) : null;
        setOwner(known ? known.email : prior?.owner ? OTHER : null);
      });
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const options = useMemo<ChoiceOption<string>[]>(() => [
    ...(Array.isArray(people)
      ? distinctPeople(people.map((person) => ({ id: person.email, name: person.display_name?.trim() || person.email.split("@")[0], email: person.email })))
        .map((person) => ({ value: person.id, label: person.name, hint: person.email ? `${person.email} · in Keel` : "In Keel" }))
      : []),
    { value: OTHER, label: "Someone else or a team", hint: "Type their name or mailbox" },
  ], [people]);
  const typing = people === "unavailable" || owner === OTHER;
  const ownerValue = typing ? typed.trim() : owner ?? "";
  const ownerLabel = typing ? typed.trim() : options.find((option) => option.value === owner)?.label ?? "";
  const tomorrow = addDays(today, 1);
  const preset = PRESETS.find((days) => addDays(today, days) === until) ?? null;
  const verb = findings.length === 1 && first?.exception ? "Renew" : "Grant";
  const title = findings.length === 1 && first ? grantLabel(first) : `Grant an exception to ${findings.length} controls`;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (!ownerValue) { setError("Name who owns the exception."); return; }
    if (!reason.trim()) { setError("Say why the control may fail for now."); return; }
    const weak = reasonMessage(reason);
    if (weak) { setError(weak); return; }
    const expiresAt = endOfDay(until);
    if (!expiresAt || until < tomorrow) { setError("Pick an end date after today."); return; }
    setBusy(true);
    try {
      const granted: Record<string, Granted> = {};
      const failed: string[] = [];
      for (const finding of findings) {
        const result = await grantException({ evaluationId: finding.id, owner: ownerValue, reason: reason.trim(), expiresAt });
        if (result.ok) granted[finding.id] = { owner: ownerValue, ownerName: ownerLabel, reason: reason.trim(), expiresAt };
        else { failed.push(controlName(finding)); if (findings.length === 1) { setError(result.reason); return; } }
      }
      const done = Object.keys(granted).length;
      if (failed.length) toast({ tone: "warning", title: `Exception saved on ${done} of ${findings.length} controls`, detail: `Not saved: ${failed.join(", ")}.` });
      else toast({ title: done === 1 ? `Exception saved until ${formatDay(expiresAt)}` : `Exception saved on ${done} controls until ${formatDay(expiresAt)}`, detail: "The control still fails; it counts as accepted until then." });
      onDone(granted);
    } finally {
      setBusy(false);
    }
  }

  return (
    <DetailsSheet
      footer={<>
        <button aria-busy={busy || undefined} className="btn btn-primary" disabled={busy} form="cp-exception" type="submit">{verb} until {formatDay(endOfDay(until))}</button>
        <button className="btn" onClick={onClose} type="button">Cancel</button>
        <p className="bl-help">{EXCEPTION_EFFECT}</p>
      </>}
      kicker={<span className="cp-sheet-kicker"><Icon name="pause" />Exception</span>}
      onClose={onClose}
      title={title}
    >
      <form className="cp-form" id="cp-exception" onSubmit={submit}>
        <p className="cp-muted">
          {findings.length === 1 ? controlName(first) : findings.map(controlName).join("; ")}.
          {prior && findings.length === 1 ? ` The last one was owned by ${ownerName(first)}.` : ""}
        </p>
        <fieldset disabled={busy}>
          <legend>Who owns it</legend>
          {prior && !prior.owner && prior.ownerRef?.pseudonym ? (
            <p className="field-help">Names are hidden, so the current owner ({prior.ownerRef.name}) is not filled in. Choose or type the owner again.</p>
          ) : null}
          {people === null ? <p className="field-help">Looking up people in Keel…</p> : people !== "unavailable" ? (
            <OptionPicker label="Owner" onChange={setOwner} options={options} placeholder="Choose a person" value={owner} />
          ) : null}
          {typing ? (
            <label className="filter-field"><span>Owner{people === "unavailable" ? "" : " (name or mailbox)"}</span><input autoComplete="off" maxLength={320} name="owner" onChange={(event) => setTyped(event.target.value)} placeholder="Security team" value={typed} /></label>
          ) : null}
        </fieldset>
        <fieldset disabled={busy}>
          <legend>Why</legend>
          <label className="filter-field"><span>Reason (kept as evidence)</span><textarea maxLength={1000} name="reason" onChange={(event) => setReason(event.target.value)} placeholder="Two emergency accounts stay until the November cut-over." rows={3} value={reason} /></label>
        </fieldset>
        <fieldset disabled={busy}>
          <legend>Until</legend>
          <div className="cp-presets" role="group" aria-label="End after">
            {PRESETS.map((days) => (
              <button aria-pressed={preset === days} className="cp-preset" key={days} onClick={() => setUntil(addDays(today, days))} type="button">{days} days · {formatDay(endOfDay(addDays(today, days)))}</button>
            ))}
          </div>
          <label className="filter-field"><span>Or pick a date</span><input min={tomorrow} name="until" onChange={(event) => setUntil(event.target.value)} required type="date" value={until} /></label>
        </fieldset>
        {error ? <p className="cp-error" role="alert">{error}</p> : null}
      </form>
    </DetailsSheet>
  );
}
