"use client";

import { useState, type FormEvent } from "react";

import { DetailsSheet } from "@/components/baselines/details-sheet";
import { ROLE_OPTIONS } from "@/components/people/person-sheet";
import { OptionPicker } from "@/components/pickers/option-picker";
import { Icon } from "@/components/shell/icons";
import { addPerson, untilEndOf } from "@/lib/people-change";
import { ROLES, type Role } from "@/lib/people-view";
import type { PrincipalView } from "@/lib/principals";
import { toast } from "@/lib/toast";
import { ReasonHint } from "@/components/reason-hint";
import { optionalReasonMessage } from "@/lib/written-reason";

// Add person: email, name, the first role and, for a temporary helper, an end date.
// Keel does not open the sign-in gate (Cloudflare Access); the help line says so.

export function AddPersonSheet({ initialRole = "viewer", onAdded, onClose }: {
  initialRole?: Role;
  onAdded: (person: PrincipalView | null) => void;
  onClose: () => void;
}) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>(initialRole);
  const [until, setUntil] = useState("");
  const [why, setWhy] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { setError("Enter the email address they sign in with."); return; }
    const weak = optionalReasonMessage(why);
    if (weak) { setError(weak); return; }
    setBusy(true);
    try {
      const result = await addPerson({ email: email.trim(), displayName: name.trim() || null, role, activeUntil: untilEndOf(until), reason: why.trim() || null });
      if (!result.ok) { setError(result.reason); return; }
      toast({ title: `${name.trim() || email.trim()} added as ${ROLES[role].label.toLowerCase()}`, detail: "Allow their email through your sign-in gate too." });
      onAdded(result.person);
    } finally {
      setBusy(false);
    }
  }

  return (
    <DetailsSheet
      footer={<>
        <button aria-busy={busy || undefined} className="btn btn-primary" disabled={busy || !email.trim()} form="pe-add-person" type="submit">Add person</button>
        <button className="btn" onClick={onClose} type="button">Cancel</button>
        <p className="bl-help">They can sign in once your sign-in gate lets their email through.</p>
      </>}
      kicker={<span className="pe-sheet-kicker"><Icon name="plus" />People</span>}
      onClose={onClose}
      title="Add person"
    >
      <form className="pe-form" id="pe-add-person" onSubmit={submit}>
        <fieldset disabled={busy}>
          <legend>Who</legend>
          <label className="filter-field"><span>Email</span><input autoComplete="off" inputMode="email" name="email" onChange={(event) => setEmail(event.target.value)} placeholder="name@company.com" required type="email" value={email} /></label>
          <label className="filter-field"><span>Name (optional)</span><input autoComplete="off" name="name" onChange={(event) => setName(event.target.value)} placeholder="Lee Chen" value={name} /></label>
        </fieldset>
        <fieldset disabled={busy}>
          <legend>First role</legend>
          <OptionPicker label="Role" onChange={setRole} options={ROLE_OPTIONS} value={role} />
          <p className="field-help">{ROLES[role].meaning}.</p>
          <label className="filter-field"><span>Until (optional)</span><input name="until" onChange={(event) => setUntil(event.target.value)} type="date" value={until} /></label>
          <label className="filter-field"><span>Why (optional)</span><input autoComplete="off" maxLength={500} name="why" onChange={(event) => setWhy(event.target.value)} placeholder="New service desk lead" value={why} /><ReasonHint value={why} /></label>
        </fieldset>
        {error ? <p className="pe-error" role="alert">{error}</p> : null}
      </form>
    </DetailsSheet>
  );
}
