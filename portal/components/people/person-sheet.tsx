"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { DetailsSheet } from "@/components/baselines/details-sheet";
import { PersonRecord } from "@/components/people/person-record";
import { OptionPicker } from "@/components/pickers/option-picker";
import type { ChoiceOption } from "@/components/pickers/segmented";
import { Icon } from "@/components/shell/icons";
import { TechnicalDetails } from "@/components/technical-details";
import { Badge } from "@/components/ui/badge";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { changePerson, fromStartOf, untilEndOf, type PersonChange } from "@/lib/people-change";
import {
  LAST_ADMIN_WORDS,
  PERSON_STATES,
  ROLES,
  ROLE_ORDER,
  abilityGroups,
  accessLine,
  grantRoleWords,
  grantWhen,
  grantWindowWords,
  grantedByName,
  isLastAdmin,
  personName,
  personState,
  type Role,
} from "@/lib/people-view";
import type { PrincipalView } from "@/lib/principals";
import { toast } from "@/lib/toast";
import { ReasonHint } from "@/components/reason-hint";
import { optionalReasonMessage } from "@/lib/written-reason";

// One person's panel: what they can do grouped by the work, their roles (now, starting
// later, ended) with who gave each, a short form to add a role now or for a while, and
// Disable or Enable again in the footer. The last live admin's Remove and Disable are
// turned off with the reason shown under them, before any click.

export const ROLE_OPTIONS: ChoiceOption<Role>[] = ROLE_ORDER.map((role) => ({ value: role, label: ROLES[role].label, hint: ROLES[role].meaning }));

const WHEN_ORDER = { active: 0, scheduled: 1, ended: 2 } as const;

export function PersonSheet({ person, people, now, canRoles, canUsers, onClose }: {
  person: PrincipalView;
  people: PrincipalView[];
  now: string;
  canRoles: boolean;
  canUsers: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [role, setRole] = useState<Role>("viewer");
  const [from, setFrom] = useState("");
  const [until, setUntil] = useState("");
  const [why, setWhy] = useState("");
  const [error, setError] = useState<string | null>(null);
  const name = personName(person);
  const state = personState(person, now);
  const lastAdmin = isLastAdmin(person, people, now);
  const disabled = Boolean(person.disabled_at);
  const system = Boolean(person.system_kind);
  const today = now.slice(0, 10);
  const grants = [...person.role_grants].sort((a, b) => WHEN_ORDER[grantWhen(a, now)] - WHEN_ORDER[grantWhen(b, now)] || a.active_from.localeCompare(b.active_from));
  const groups = abilityGroups(person.capabilities);

  async function run(change: PersonChange, success: string): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const result = await changePerson(person.id, change);
      if (!result.ok) {
        toast({ tone: "warning", title: "Not changed", detail: result.reason });
        setError(result.reason);
        return false;
      }
      toast({ title: success });
      router.refresh();
      return true;
    } finally {
      setBusy(false);
    }
  }

  async function addRole(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const activeFrom = fromStartOf(from, today);
    const activeUntil = untilEndOf(until);
    if (activeUntil && activeUntil <= (activeFrom ?? now)) { setError("The end date must come after the start."); return; }
    const weak = optionalReasonMessage(why);
    if (weak) { setError(weak); return; }
    const done = await run({ kind: "grant", role, activeFrom, activeUntil, reason: why.trim() || null }, `${ROLES[role].label} added for ${name}`);
    if (done) { setFrom(""); setUntil(""); setWhy(""); }
  }

  const footer = system ? null : disabled ? (canUsers ? <>
    <button aria-busy={busy || undefined} className="btn btn-primary" disabled={busy} onClick={() => void run({ kind: "enable" }, `${name} can use Keel again`)} type="button"><Icon name="play" />Enable again</button>
    <p className="bl-help">Their roles still in date apply again at once.</p>
  </> : null) : <>
    {canRoles ? <button aria-busy={busy || undefined} className="btn btn-primary" disabled={busy} form="pe-add-role" type="submit">Add role</button> : null}
    {canUsers ? (
      <ConfirmButton cancelLabel="Keep access" confirmLabel="Disable" description={<p>{name} can no longer sign in to Keel. Their roles stay recorded, so Enable again lets them back with the same access.</p>} disabled={busy || lastAdmin} onConfirm={() => void run({ kind: "disable" }, `${name} disabled`)} title={`Disable ${name}?`} tone="danger">
        <Icon name="hide" />Disable
      </ConfirmButton>
    ) : null}
    {canUsers && lastAdmin ? <p className="bl-help pe-why-not">{LAST_ADMIN_WORDS}</p> : null}
  </>;

  return (
    <DetailsSheet footer={footer} kicker={<span className="pe-sheet-kicker"><Icon name="settings" />Person</span>} onClose={onClose} title={name}>
      <div className="pe-sheet">
        <p className="pe-sheet-who">
          <span className="pe-email">{person.email}</span>
          <Badge icon={PERSON_STATES[state].icon} tone={PERSON_STATES[state].tone}>{system ? "Set by Keel" : PERSON_STATES[state].label}</Badge>
        </p>
        <p>{accessLine(person, now)}</p>

        {groups.length ? (
          <section aria-label="What they can do" className="pe-abilities">
            {groups.map((group) => (
              <div className="pe-ability" key={group.label}>
                <b><Icon name={group.icon} />{group.label}</b>
                <ul>{group.lines.map((line) => <li key={line}>{line}</li>)}</ul>
              </div>
            ))}
          </section>
        ) : null}

        <section aria-labelledby="pe-roles-heading" className="pe-roles">
          <h3 id="pe-roles-heading">Roles</h3>
          {grants.length === 0 ? <p className="pe-none">{system ? "Keel sets what this account can do." : "No roles yet."}</p> : (
            <ul className="pe-grant-list">
              {grants.map((grant) => {
                const when = grantWhen(grant, now);
                const by = grantedByName(grant, people);
                const lockout = lastAdmin && when === "active" && grant.role === "admin";
                return (
                  <li className="pe-grant" data-when={when} key={grant.id}>
                    <span className="pe-grant-words">
                      <b>{grantRoleWords(grant)}</b>
                      <small>{grantWindowWords(grant, now)}{by ? ` · granted by ${by}` : ""}{grant.reason ? ` · ${grant.reason}` : ""}</small>
                      {lockout && canRoles ? <small className="pe-why-not">{LAST_ADMIN_WORDS}</small> : null}
                    </span>
                    {when === "active" ? <Badge icon={null} tone="fine">Now</Badge> : when === "scheduled" ? <Badge icon={null} tone="low">Starts later</Badge> : <Badge icon={null} tone="neutral">Ended</Badge>}
                    {canRoles && !disabled && when !== "ended" ? (
                      <ConfirmButton
                        cancelLabel="Keep the role"
                        confirmLabel={when === "scheduled" ? "Cancel the role" : "Remove role"}
                        description={<p>{when === "scheduled" ? `${name} will not get the ${ROLES[grant.role as Role]?.label.toLowerCase() ?? grant.role} role.` : `${name} loses the ${ROLES[grant.role as Role]?.label.toLowerCase() ?? grant.role} role now. The grant stays in the record.`}</p>}
                        disabled={busy || lockout}
                        onConfirm={() => void run({ kind: "revoke", grantId: grant.id }, when === "scheduled" ? "Role cancelled" : "Role removed")}
                        size="sm"
                        title={`${when === "scheduled" ? "Cancel" : "Remove"} ${grantRoleWords(grant).toLowerCase()} for ${name}?`}
                        tone="danger"
                      >
                        {when === "scheduled" ? "Cancel" : "Remove"}
                      </ConfirmButton>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {canRoles && !disabled && !system ? (
          <form className="pe-form" id="pe-add-role" onSubmit={addRole}>
            <fieldset disabled={busy}>
              <legend>Add a role</legend>
              <OptionPicker label="Role" onChange={setRole} options={ROLE_OPTIONS} value={role} />
              <p className="field-help">{ROLES[role].meaning}.</p>
              <div className="pe-dates">
                <label className="filter-field"><span>From (optional)</span><input min={today} name="from" onChange={(event) => setFrom(event.target.value)} type="date" value={from} /></label>
                <label className="filter-field"><span>Until (optional)</span><input min={today} name="until" onChange={(event) => setUntil(event.target.value)} type="date" value={until} /></label>
              </div>
              <label className="filter-field"><span>Why (optional)</span><input autoComplete="off" maxLength={500} name="why" onChange={(event) => setWhy(event.target.value)} placeholder="Covers approvals while Sam is away" value={why} /><ReasonHint value={why} /></label>
            </fieldset>
          </form>
        ) : null}
        {error ? <p className="pe-error" role="alert">{error}</p> : null}

        <TechnicalDetails><PersonRecord person={person} /></TechnicalDetails>
      </div>
    </DetailsSheet>
  );
}
