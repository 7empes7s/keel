"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, type FormEvent } from "react";

import { DetailsSheet } from "@/components/baselines/details-sheet";
import { OptionPicker } from "@/components/pickers/option-picker";
import { Segmented, type ChoiceOption } from "@/components/pickers/segmented";
import { Icon } from "@/components/shell/icons";
import { plainKind, typeService } from "@/lib/baselines-view";
import { createRule, type NewRule } from "@/lib/policy-change";
import { RULE_KINDS, RULE_KIND_ORDER, ruleSentence, type RuleKind } from "@/lib/policy-view";
import type { PrincipalView } from "@/lib/principals";
import { RESOURCE_TYPE_LABELS } from "@/lib/presentation";
import { toast } from "@/lib/toast";

// New rule: a short guided sheet with today's policy fields and nothing more (the
// Policies spec: no automation builder here). What to watch, what to do, limits, the
// account it acts as (undo rules only) and a name. The check line is the rule's own
// sentence. An undo rule is created off (POST /api/policies refuses enabled undo rules)
// and lands on its page, where "Preview turning on" is the one action.

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

export function NewRuleSheet({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [kind, setKind] = useState<string>(ANY);
  const [change, setChange] = useState<string>(ANY);
  const [risk, setRisk] = useState<string>(ANY);
  const [pattern, setPattern] = useState("");
  const [does, setDoes] = useState<RuleKind>("alert");
  const [ceiling, setCeiling] = useState<NewRule["maxBlastRadius"]>("cosmetic");
  const [perHour, setPerHour] = useState("");
  const [runAs, setRunAs] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [people, setPeople] = useState<PrincipalView[] | null | "unavailable">(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The accounts an undo rule may act as: those that hold the restorer role now.
  useEffect(() => {
    if (does !== "undo" || people !== null) return;
    let cancelled = false;
    fetch("/api/principals")
      .then(async (response) => (response.ok ? ((await response.json()) as { principals: PrincipalView[] }).principals : "unavailable" as const))
      .catch(() => "unavailable" as const)
      .then((list) => { if (!cancelled) setPeople(list === "unavailable" ? list : list.filter((person) => !person.disabled_at && person.capabilities.includes("remediate"))); });
    return () => { cancelled = true; };
  }, [does, people]);

  const draft = useMemo(() => ({
    action: RULE_KINDS[does].code,
    resource_type: kind || null,
    natural_key_glob: pattern.trim() ? `${kind || "*"}:${pattern.trim()}` : null,
    change_type: change || null,
    blast_radius: risk || null,
    max_actions_per_window: perHour ? Number(perHour) : null,
    window_seconds: perHour ? 3600 : null,
  }), [does, kind, pattern, change, risk, perHour]);

  const peopleOptions: ChoiceOption<string>[] = Array.isArray(people) ? people.map((person) => ({ value: person.id, label: person.display_name?.trim() || person.email.split("@")[0], hint: "Holds the restorer role" })) : [];

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
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
      router.push(`/policies/${encodeURIComponent(result.id)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <DetailsSheet
      footer={<>
        <button aria-busy={busy || undefined} className="btn btn-primary" disabled={busy || !name.trim()} form="po-new-rule" type="submit">Create rule</button>
        <button className="btn" onClick={onClose} type="button">Cancel</button>
        <p className="bl-help">{does === "undo" ? "Created off. Its page shows what it would undo before you turn it on." : "It starts watching for changes as soon as it is created."}</p>
      </>}
      kicker={<span className="po-sheet-kicker"><Icon name="automation" />Automatic rule</span>}
      onClose={onClose}
      title="New rule"
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
          <Segmented label="What to do" onChange={setDoes} options={DOES} value={does} />
          <p className="field-help">{DO_HELP[does]}</p>
        </fieldset>
        <fieldset disabled={busy}>
          <legend>3. Limits</legend>
          <Segmented label="Most risky it may touch" onChange={setCeiling} options={CEILINGS} value={ceiling} />
          <label className="filter-field"><span>Actions an hour (optional)</span><input inputMode="numeric" min={1} name="perHour" onChange={(event) => setPerHour(event.target.value.replace(/[^0-9]/g, ""))} placeholder="50" value={perHour} /></label>
          <p className="field-help">When it reaches the limit it pauses itself until someone resumes it.</p>
        </fieldset>
        {does === "undo" ? (
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
          <legend>{does === "undo" ? "5. Name and check" : "4. Name and check"}</legend>
          <label className="filter-field"><span>Name</span><input autoComplete="off" maxLength={120} name="name" onChange={(event) => setName(event.target.value)} placeholder={does === "undo" ? "Undo low-risk changes" : does === "approval" ? "Ask before changing sign-in rules" : "Alert on lockout risk"} required value={name} /></label>
          <p className="po-check" role="status"><Icon name="check" />{ruleSentence(draft)}</p>
        </fieldset>
        {error ? <p className="po-error" role="alert"><Icon name="alert" />{error}</p> : null}
      </form>
    </DetailsSheet>
  );
}
