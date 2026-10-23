"use client";

import { useMemo, useState, type FormEvent } from "react";

import { DetailsSheet } from "@/components/baselines/details-sheet";
import { OptionPicker } from "@/components/pickers/option-picker";
import { Icon } from "@/components/shell/icons";
import { OWN_DEFAULT_STANDARD, ownCheckSentence, settingValueWords } from "@/lib/compliance-view";
import { typeName } from "@/lib/protect-view";
import { toast } from "@/lib/toast";
import type { OwnCheck, OwnCheckChoices } from "@/lib/types";

type Value = OwnCheck["expected"];

/** What was typed, read as the kind of value the setting holds in the newest backup. */
export function readValue(text: string, seen: Value[]): Value {
  const kinds = new Set(seen.filter((value) => value !== null).map((value) => typeof value));
  const trimmed = text.trim();
  if (kinds.has("boolean") || (!kinds.size && /^(true|false)$/i.test(trimmed))) return /^(true|on|yes)$/i.test(trimmed);
  if ((kinds.has("number") || !kinds.size) && trimmed !== "" && Number.isFinite(Number(trimmed))) return Number(trimmed);
  return text;
}

// Write your own check: pick a kind of setting Keel backs up, one of its settings and
// the value it should have, and the standard it belongs to (one of the tenant's own). The choices come from the
// newest backup, so only settings that exist can be picked. Saving checks it at once.
export function OwnCheckSheet({ choices, standards, onDone, onClose }: {
  choices: OwnCheckChoices | null;
  standards: string[];
  onDone: () => void;
  onClose: () => void;
}) {
  const types = choices?.types ?? [];
  const [standard, setStandard] = useState(standards[0] ?? OWN_DEFAULT_STANDARD);
  const [resourceType, setResourceType] = useState<string | null>(null);
  const [field, setField] = useState<string | null>(null);
  const [operator, setOperator] = useState<OwnCheck["operator"]>("equals");
  const [typed, setTyped] = useState("");
  const [appliesTo, setAppliesTo] = useState<OwnCheck["appliesTo"]>("every");
  const [severity, setSeverity] = useState<OwnCheck["severity"]>("medium");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const type = types.find((entry) => entry.resourceType === resourceType) ?? null;
  const setting = type?.fields.find((entry) => entry.field === field) ?? null;
  const seen = setting?.values ?? [];
  const isSwitch = seen.length > 0 && seen.every((value) => typeof value === "boolean");
  const expected = readValue(typed, seen);
  const sentence = type && setting && typed.trim() !== "" ? ownCheckSentence({ resourceType: type.resourceType, field: setting.field, operator, expected, appliesTo }) : null;
  const typeOptions = useMemo(() => types.map((entry) => ({ value: entry.resourceType, label: typeName(entry.resourceType), hint: entry.count === 1 ? "1 in the newest backup" : `${entry.count} in the newest backup` })), [types]);
  const fieldOptions = useMemo(() => (type?.fields ?? []).map((entry) => ({ value: entry.field, label: entry.field, hint: entry.values.length ? `Seen: ${entry.values.map(settingValueWords).join(", ")}` : undefined })), [type]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (!standard.trim()) { setError("Name the standard this check belongs to."); return; }
    if (!type || !setting) { setError("Pick what to check and which setting."); return; }
    if (typed.trim() === "") { setError("Say what the setting should be."); return; }
    setBusy(true);
    try {
      const response = await fetch("/api/actions/compliance/own-check", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ standard: standard.trim(), name: name.trim() || sentence, resourceType: type.resourceType, field: setting.field, operator, expected, appliesTo, severity }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { detail?: string };
        setError(response.status === 403 ? "You need the configuration permission to write a check." : body.detail ? `Not saved: ${body.detail}.` : "Not saved. Try again in a moment.");
        return;
      }
      const body = (await response.json()) as { verdict: string | null };
      const result = body.verdict === "pass" ? "it passes" : body.verdict === "fail" ? "it does not pass" : body.verdict === "not-applicable" ? "there is nothing of that kind to check" : "it could not be checked yet";
      toast({ tone: body.verdict === "fail" ? "warning" : undefined, title: "Check saved", detail: `Checked against the newest backup: ${result}.` });
      onDone();
    } catch {
      setError("Keel could not be reached.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <DetailsSheet
      footer={<>
        <button aria-busy={busy || undefined} className="btn btn-primary" disabled={busy || !types.length} form="cp-own-check" type="submit">Save and check</button>
        <button className="btn" onClick={onClose} type="button">Cancel</button>
        <p className="bl-help">Keel checks it after every backup, with its own checks. It only reads backups; it never changes Microsoft 365.</p>
      </>}
      kicker={<span className="cp-sheet-kicker"><Icon name="plus" />Your own check</span>}
      onClose={onClose}
      title="Write your own check"
    >
      {!types.length ? (
        <p className="cp-muted">There is no complete backup to pick settings from yet. Run a backup, then come back.</p>
      ) : (
        <form className="cp-form" id="cp-own-check" onSubmit={submit}>
          <fieldset disabled={busy}>
            <legend>Standard</legend>
            <label className="filter-field"><span>Belongs to</span><input autoComplete="off" list="cp-own-standards" maxLength={80} name="standard" onChange={(event) => setStandard(event.target.value)} value={standard} /></label>
            <datalist id="cp-own-standards">{standards.map((entry) => <option key={entry} value={entry} />)}</datalist>
          </fieldset>
          <fieldset disabled={busy}>
            <legend>What to check</legend>
            <OptionPicker label="Kind" onChange={(value) => { setResourceType(value); setField(null); setTyped(""); }} options={typeOptions} placeholder="Choose a kind of setting" value={resourceType} />
            {type ? <OptionPicker label="Setting" onChange={(value) => { setField(value); setTyped(""); }} options={fieldOptions} placeholder="Choose a setting" value={field} /> : null}
          </fieldset>
          {setting ? (
            <fieldset disabled={busy}>
              <legend>What it should be</legend>
              <label className="filter-field"><span>Must be</span><select name="operator" onChange={(event) => setOperator(event.target.value as OwnCheck["operator"])} value={operator}><option value="equals">Set to</option><option value="not-equals">Set to anything but</option></select></label>
              {isSwitch ? (
                <label className="filter-field"><span>Value</span><select name="expected" onChange={(event) => setTyped(event.target.value)} value={typed}><option value="">Choose…</option><option value="true">On</option><option value="false">Off</option></select></label>
              ) : (
                <label className="filter-field"><span>Value</span><input autoComplete="off" list="cp-own-values" maxLength={200} name="expected" onChange={(event) => setTyped(event.target.value)} value={typed} /></label>
              )}
              <datalist id="cp-own-values">{seen.filter((value) => value !== null).map((value) => <option key={String(value)} value={String(value)} />)}</datalist>
              <label className="filter-field"><span>Applies to</span><select name="appliesTo" onChange={(event) => setAppliesTo(event.target.value as OwnCheck["appliesTo"])} value={appliesTo}><option value="every">Every one of them</option><option value="any">At least one of them</option></select></label>
              <label className="filter-field"><span>How serious</span><select name="severity" onChange={(event) => setSeverity(event.target.value as OwnCheck["severity"])} value={severity}><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select></label>
            </fieldset>
          ) : null}
          {setting ? (
            <fieldset disabled={busy}>
              <legend>Name</legend>
              <label className="filter-field"><span>Shown on the Compliance page</span><input autoComplete="off" maxLength={200} name="name" onChange={(event) => setName(event.target.value)} placeholder={sentence ?? ""} value={name} /></label>
            </fieldset>
          ) : null}
          {sentence ? <p className="cp-callout"><Icon name="check-circle" />{sentence}</p> : null}
          {error ? <p className="cp-error" role="alert">{error}</p> : null}
        </form>
      )}
    </DetailsSheet>
  );
}
