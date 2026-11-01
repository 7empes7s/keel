"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, type FormEvent } from "react";

import { DetailsSheet } from "@/components/baselines/details-sheet";
import { distinctPeople } from "@/lib/people-choices";
import { OptionPicker } from "@/components/pickers/option-picker";
import { Segmented, type ChoiceOption } from "@/components/pickers/segmented";
import { Icon } from "@/components/shell/icons";
import { plainKind, typeService } from "@/lib/baselines-view";
import { createRule, editRule, type NewRule } from "@/lib/policy-change";
import { RULE_KINDS, RULE_KIND_ORDER, rateWords, ruleKind, ruleSentence, type RuleKind } from "@/lib/policy-view";
import type { Policy } from "@/lib/policies";
import type { PrincipalView } from "@/lib/principals";
import { RESOURCE_TYPE_LABELS } from "@/lib/presentation";
import { toast } from "@/lib/toast";

// New rule: a short guided sheet with today's policy fields and nothing more (the
// Policies spec: no automation builder here). What to watch, what to do, limits, the
// account it acts as (undo rules only) and a name. The check line is the rule's own
// sentence. An undo rule is created off (POST /api/policies refuses enabled undo rules)
// and lands on its page, where "Preview turning on" is the one action.
// The same sheet edits a rule (pass `policy`): what to watch, limits and name. What it
// does and the account it acts as are fixed; a different action is a new rule. Saving
// an undo rule that is on turns it off until it is previewed again.
// The hourly limit starts at a real 50 (not a placeholder), so what the form shows is
// what is saved; emptying the box is the only way to save "No limit".

const ANY = "";
const CHANGES: ChoiceOption<string>[] = [{ value: ANY, label: "Any change" }, { value: "added", label: "Added" }, { value: "modified", label: "Changed" }, { value: "removed", label: "Removed" }];
const RISKS: ChoiceOption<string>[] = [{ value: ANY, label: "Any risk" }, { value: "cosmetic", label: "Low risk" }, { value: "access-affecting", label: "Affects access", hint: "Changes that affect who can reach what" }, { value: "tenant-lockout", label: "Lockout", hint: "Changes that could lock out admins" }];
const CEILINGS: ChoiceOption<NewRule["maxBlastRadius"]>[] = [{ value: "cosmetic", label: "Low risk" }, { value: "access-affecting", label: "Affects access" }, { value: "tenant-lockout", label: "Lockout", hint: "Changes that could lock out admins" }];
const DOES: ChoiceOption<RuleKind>[] = RULE_KIND_ORDER.map((kind) => ({ value: kind, label: RULE_KINDS[kind].label, icon: RULE_KINDS[kind].icon }));
const DO_HELP: Record<RuleKind, string> = {
  alert: "Keel tells you and changes nothing.",
  approval: "An approver says yes first; then Keel undoes the change.",
  undo: "Created off. Keel shows what it would undo before you turn it on.",
};
const KINDS: ChoiceOption<string>[] = [
  { value: ANY, label: "Anything", icon: "cloud" },
  ...Object.keys(RESOURCE_TYPE_LABELS).map((type) => ({ value: type, label: plainKind(type), icon: typeService(type).icon, hint: typeService(type).name })).sort((a, b) => a.label.localeCompare(b.label)),
];

export const DEFAULT_PER_HOUR = "50";

/** The "Name like" part of a saved glob: the glob is `<kind or *>:<pattern>`. */
export function globPattern(policy: Pick<Policy, "resource_type" | "natural_key_glob">): string {
  const glob = policy.natural_key_glob;
  if (!glob) return "";
  const prefix = `${policy.resource_type || "*"}:`;
  return glob.startsWith(prefix) ? glob.slice(prefix.length) : glob;
}

export function NewRuleSheet({ onClose, policy = null }: { onClose: () => void; policy?: Policy | null }) {
  const router = useRouter();
  const editing = policy !== null;
  const [kind, setKind] = useState<string>(policy?.resource_type ?? ANY);
  const [change, setChange] = useState<string>(policy?.change_type ?? ANY);
  const [risk, setRisk] = useState<string>(policy?.blast_radius ?? ANY);
  const [pattern, setPattern] = useState(policy ? globPattern(policy) : "");
  const [does, setDoes] = useState<RuleKind>(policy ? ruleKind(policy) : "alert");
  const [ceiling, setCeiling] = useState<NewRule["maxBlastRadius"]>((policy?.max_blast_radius as NewRule["maxBlastRadius"] | undefined) ?? "cosmetic");
  const savedPerHour = policy ? (policy.max_actions_per_window == null ? "" : String(policy.max_actions_per_window)) : DEFAULT_PER_HOUR;
  const [perHour, setPerHour] = useState(savedPerHour);
  const [runAs, setRunAs] = useState<string | null>(null);
  const [name, setName] = useState(policy?.name ?? "");
  const [people, setPeople] = useState<PrincipalView[] | null | "unavailable">(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The accounts an undo rule may act as: those that hold the restorer role now.
  useEffect(() => {
    if (editing || does !== "undo" || people !== null) return;
    let cancelled = false;
    fetch("/api/principals")
      .then(async (response) => (response.ok ? ((await response.json()) as { principals: PrincipalView[] }).principals : "unavailable" as const))
      .catch(() => "unavailable" as const)
      .then((list) => { if (!cancelled) setPeople(list === "unavailable" ? list : list.filter((person) => !person.disabled_at && person.capabilities.includes("remediate"))); });
    return () => { cancelled = true; };
  }, [editing, does, people]);

  const draft = useMemo(() => ({
    action: RULE_KINDS[does].code,
    resource_type: kind || null,
    natural_key_glob: pattern.trim() ? `${kind || "*"}:${pattern.trim()}` : null,
    change_type: change || null,
    blast_radius: risk || null,
    max_actions_per_window: perHour ? Number(perHour) : null,
    // An edit that leaves the number as it was keeps the rule's own window.
    window_seconds: perHour ? (policy?.window_seconds && perHour === savedPerHour ? policy.window_seconds : 3600) : null,
  }), [does, kind, pattern, change, risk, perHour, policy, savedPerHour]);
  const offOnSave = editing && does === "undo" && policy.enabled;

  const peopleOptions: ChoiceOption<string>[] = Array.isArray(people)
    ? distinctPeople(people.map((person) => ({ id: person.id, name: person.display_name?.trim() || person.email.split("@")[0], email: person.email })))
      .map((person) => ({ value: person.id, label: person.name, hint: person.email ? `${person.email} · holds the restorer role` : "Holds the restorer role" }))
    : [];

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (perHour && Number(perHour) < 1) { setError("Actions an hour must be 1 or more, or empty for no limit."); return; }
    if (editing) { await save(); return; }
    if (does === "undo" && !runAs) { setError("Choose the account the rule acts as."); return; }
    setBusy(true);
    try {
      const result = await createRule({
        name: name.trim(), action: RULE_KINDS[does].code as NewRule["action"], maxBlastRadius: ceiling,
        resourceType: draft.resource_type, naturalKeyGlob: draft.natural_key_glob, changeType: draft.change_type, blastRadius: draft.blast_radius,
        maxActionsPerWindow: draft.max_actions_per_window, windowSeconds: draft.window_seconds, runAsPrincipalId: does === "undo" ? runAs : null,
      });
      if (!result.ok) { setError(result.reason); return; }
      toast({ title: `${name.trim()} created`, detail: does === "undo" ? "It is off until you preview and turn it on." : "It is on and watching for changes." });
      router.push(`/rules/${encodeURIComponent(result.id)}`);
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!policy) return;
    setBusy(true);
    try {
      const result = await editRule(policy.id, {
        name: name.trim(), maxBlastRadius: ceiling, resourceType: draft.resource_type, naturalKeyGlob: draft.natural_key_glob,
        changeType: draft.change_type, blastRadius: draft.blast_radius, maxActionsPerWindow: draft.max_actions_per_window, windowSeconds: draft.window_seconds,
      });
      if (!result.ok) { setError(result.reason); return; }
      toast({ title: `${name.trim()} saved`, detail: offOnSave ? "It is off until you preview and turn it on again." : undefined });
      onClose();
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const footerHelp = editing
    ? (offOnSave ? "Saving turns it off. Preview what it would undo, then turn it on again." : "Changes apply to the next change Keel sees.")
    : does === "undo" ? "Created off. Its page shows what it would undo before you turn it on." : "It starts watching for changes as soon as it is created.";

  return (
    <DetailsSheet
      footer={<>
        <button aria-busy={busy || undefined} className="btn btn-primary" disabled={busy || !name.trim()} form="po-new-rule" type="submit">{editing ? "Save changes" : "Create rule"}</button>
        <button className="btn" onClick={onClose} type="button">Cancel</button>
        <p className="bl-help">{footerHelp}</p>
      </>}
      kicker={<span className="po-sheet-kicker"><Icon name="automation" />Automatic rule</span>}
      onClose={onClose}
      title={editing ? `Edit ${policy.name}` : "New rule"}
    >
      <form className="po-form" id="po-new-rule" onSubmit={submit}>
        <fieldset disabled={busy}>
          <legend>1. What to watch</legend>
          <OptionPicker label="Kind of thing" onChange={setKind} options={KINDS} value={kind} />
          <Segmented label="Change" onChange={setChange} options={CHANGES} value={change} />
          <Segmented label="Risk" onChange={setRisk} options={RISKS} value={risk} />
          <label className="filter-field"><span>Name like (optional)</span><input autoComplete="off" name="pattern" onChange={(event) => setPattern(event.target.value)} placeholder="Admin*" value={pattern} /></label>
        </fieldset>
        <fieldset disabled={busy}>
          <legend>2. What to do</legend>
          {editing ? (
            <p className="po-check"><Icon name={RULE_KINDS[does].icon} />{RULE_KINDS[does].label}. To make it do something else, create a new rule and delete this one.</p>
          ) : (
            <>
              <div className="po-does"><Segmented label="What to do" onChange={setDoes} options={DOES} value={does} /></div>
              <p className="field-help">{DO_HELP[does]}</p>
            </>
          )}
        </fieldset>
        <fieldset disabled={busy}>
          <legend>3. Limits</legend>
          <Segmented label="Most risky it may touch" onChange={setCeiling} options={CEILINGS} value={ceiling} />
          <label className="filter-field"><span>Actions an hour</span><input inputMode="numeric" min={1} name="perHour" onChange={(event) => setPerHour(event.target.value.replace(/[^0-9]/g, ""))} placeholder="No limit" value={perHour} /></label>
          <p className="field-help">{perHour ? "When it reaches the limit it pauses itself until someone resumes it." : "No limit: it acts on every matching change. Enter a number to cap it."}
            {policy?.window_seconds && policy.window_seconds !== 3600 && perHour === savedPerHour ? ` Now ${rateWords(policy)}; a new number is counted per hour.` : ""}</p>
        </fieldset>
        {does === "undo" && !editing ? (
          <fieldset disabled={busy}>
            <legend>4. Acting as</legend>
            {people === "unavailable" ? <p className="field-help">Keel could not list accounts. Ask someone with the people permission to create this rule.</p>
              : people === null ? <p className="field-help">Looking up accounts that hold the restorer role…</p>
              : people.length === 0 ? <p className="field-help">No account holds the restorer role. Give one the role on the People page first.</p>
              : <OptionPicker label="Account" onChange={setRunAs} options={peopleOptions} placeholder="Choose an account" value={runAs} />}
            <p className="field-help">Undo rules never act with your own access: the rule acts as this account, which Keel checks again before every undo.</p>
          </fieldset>
        ) : null}
        <fieldset disabled={busy}>
          <legend>{does === "undo" && !editing ? "5. Name and check" : "4. Name and check"}</legend>
          <label className="filter-field"><span>Name</span><input autoComplete="off" maxLength={120} name="name" onChange={(event) => setName(event.target.value)} placeholder={does === "undo" ? "Undo low-risk changes" : does === "approval" ? "Ask before changing sign-in rules" : "Alert on lockout risk"} required value={name} /></label>
          <p className="po-check" role="status"><Icon name="check" />{ruleSentence(draft)}</p>
        </fieldset>
        {error ? <p className="po-error" role="alert"><Icon name="alert" />{error}</p> : null}
      </form>
    </DetailsSheet>
  );
}
