"use client";

import Link from "next/link";
import { useState, type ClipboardEvent, type FormEvent, type KeyboardEvent } from "react";

import { DetailsSheet } from "@/components/baselines/details-sheet";
import { Icon } from "@/components/shell/icons";
import { Badge } from "@/components/ui/badge";
import { Person } from "@/components/ui/person";
import { SCUBA_LIST_INFO, scubaListEntryProblem, scubaListsMissing, scubaListResultWords, splitListEntries } from "@/lib/compliance-view";
import { ago } from "@/lib/presentation";
import { toast } from "@/lib/toast";
import type { ScubaList, ScubaListName, ScubaListsView } from "@/lib/types";

const MAX_ENTRIES = 500;

// ScubaGear lists: what CISA's ScubaGear reads from its config file, kept per tenant.
// Two rules need a list only the tenant can give (sensitive users, partner domains);
// the sign-in and admin role rules leave out the emergency accounts registered under
// Emergency access. A list not set comes first, in amber, with the rule it holds back.
export function ScubaListsCard({ view, now, editHref }: { view: ScubaListsView; now: string; editHref: string | null }) {
  const missing = scubaListsMissing(view);
  const accounts = view.emergencyAccounts.length;
  const emergency = <EmergencyRow key="emergency" view={view} />;
  return (
    <section aria-labelledby="cp-scuba-heading" className="cp-section cp-scuba">
      <div className="cp-scuba-head">
        <h2 id="cp-scuba-heading">ScubaGear lists</h2>
        {editHref ? <Link className="btn btn-sm" href={editHref}><Icon name="settings" />Edit lists</Link> : null}
      </div>
      {missing.length ? (
        <p className="cp-callout" data-tone="soon" role="status">
          <Icon name="clock" />
          <span><b>{missing.length === 1 ? "1 list is not set" : `${missing.length} lists are not set`}</b>, so {missing.length === 1 ? "1 CISA rule could not be checked" : `${missing.length} CISA rules could not be checked`}. Only you know who and what to list.</span>
        </p>
      ) : null}
      <ul className="cp-scuba-rows">
        {/* What is not set comes first; the rest keep their order. */}
        {view.lists.filter((list) => !list.entries.length).map((list) => <ListRow key={list.list} list={list} now={now} />)}
        {accounts ? null : emergency}
        {view.lists.filter((list) => list.entries.length).map((list) => <ListRow key={list.list} list={list} now={now} />)}
        {accounts ? emergency : null}
      </ul>
    </section>
  );
}

function EmergencyRow({ view }: { view: ScubaListsView }) {
  const accounts = view.emergencyAccounts.length;
  return (
    <li className="cp-scuba-row" data-tone={accounts ? "fine" : "soon"}>
      <span aria-hidden="true" className="cp-kind" data-tone={accounts ? "fine" : "soon"}><Icon name="alert" /></span>
      <span className="cp-scuba-name">
        <b>Emergency accounts</b>
        <small>Left out of {view.signInRules.length} sign-in rules and allowed a permanent admin role ({view.roleRules.join(", ")})</small>
      </span>
      <span className="cp-scuba-state">
        <Badge tone={accounts ? "fine" : "soon"}>{accounts ? `${accounts} from Emergency access` : "None registered"}</Badge>
        <small><Link className="cp-inline-link" href="/readiness">Manage on Emergency access</Link></small>
      </span>
    </li>
  );
}

function ListRow({ list, now }: { list: ScubaList; now: string }) {
  const info = SCUBA_LIST_INFO[list.list];
  const set = list.entries.length > 0;
  return (
    <li className="cp-scuba-row" data-tone={set ? "fine" : "soon"}>
      <span aria-hidden="true" className="cp-kind" data-tone={set ? "fine" : "soon"}><Icon name={info.icon} /></span>
      <span className="cp-scuba-name">
        <b>{info.label}</b>
        <small>{info.purpose} ({list.policyId})</small>
      </span>
      <span className="cp-scuba-state">
        <Badge tone={set ? "fine" : "soon"}>{set ? `${list.entries.length} ${list.entries.length === 1 ? info.one : info.many}` : "Not set"}</Badge>
        <small>
          {list.changedAt ? <>Changed {ago(list.changedAt, now)}{list.changedBy ? <> by <Person person={list.changedBy} /></> : null}</> : "Its rule could not be checked until you set it"}
        </small>
      </span>
    </li>
  );
}

/** Edit the lists: one box per list, entries as chips, saved together. */
export function ScubaListsSheet({ view, onDone, onClose }: { view: ScubaListsView; onDone: () => void; onClose: () => void }) {
  const [drafts, setDrafts] = useState<Record<ScubaListName, string[]>>(() => Object.fromEntries(view.lists.map((list) => [list.list, [...list.entries]])) as Record<ScubaListName, string[]>);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changed = view.lists.filter((list) => drafts[list.list].join("\n") !== list.entries.join("\n"));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (!changed.length) { onClose(); return; }
    setBusy(true);
    const results: string[] = [];
    try {
      for (const list of changed) {
        const response = await fetch("/api/actions/compliance/scuba-lists", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ list: list.list, entries: drafts[list.list] }),
        });
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { detail?: string };
          const name = SCUBA_LIST_INFO[list.list].label;
          setError(response.status === 403 ? "You need the configuration permission to change these lists." : body.detail ? `${name} not saved: ${body.detail}.` : `${name} not saved. Try again in a moment.`);
          return;
        }
        const body = (await response.json()) as { verdict: string | null; reason: string | null };
        results.push(`${SCUBA_LIST_INFO[list.list].label}: ${scubaListResultWords(body.verdict, drafts[list.list].length)}`);
      }
      toast({ title: changed.length === 1 ? "List saved" : "Lists saved", detail: results.join(" ") });
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
        <button aria-busy={busy || undefined} className="btn btn-primary" disabled={busy || !changed.length} form="cp-scuba-lists" type="submit">{changed.length ? "Save and check" : "No changes"}</button>
        <button className="btn" onClick={onClose} type="button">Cancel</button>
        <p className="bl-help">Kept in Keel only. Keel never changes Microsoft 365 from these lists.</p>
      </>}
      kicker={<span className="cp-sheet-kicker"><Icon name="settings" />CISA ScubaGear</span>}
      onClose={onClose}
      title="ScubaGear lists"
    >
      <form className="cp-form" id="cp-scuba-lists" onSubmit={submit}>
        {view.lists.map((list) => (
          <ListEditor
            disabled={busy}
            entries={drafts[list.list]}
            key={list.list}
            list={list}
            onChange={(entries) => setDrafts((current) => ({ ...current, [list.list]: entries }))}
          />
        ))}
        <fieldset>
          <legend>Emergency accounts</legend>
          <p className="cp-muted">Sign-in rules may leave these accounts out, and they may hold an admin role permanently. They are the accounts registered on Emergency access, so you name them once.</p>
          {view.emergencyAccounts.length ? (
            <ul className="cp-scuba-chips">
              {view.emergencyAccounts.map((account) => <li className="cp-scuba-chip" data-readonly="" key={account.accountId}><Icon name="person" />{account.label}</li>)}
            </ul>
          ) : (
            <p className="cp-callout" data-tone="soon"><Icon name="clock" />No emergency account is registered, so a sign-in rule that leaves anyone out does not count.</p>
          )}
          <p><Link className="cp-inline-link" href="/readiness">Manage emergency accounts</Link></p>
        </fieldset>
        {error ? <p className="cp-error" role="alert">{error}</p> : null}
      </form>
    </DetailsSheet>
  );
}

function ListEditor({ list, entries, onChange, disabled }: { list: ScubaList; entries: string[]; onChange: (entries: string[]) => void; disabled: boolean }) {
  const info = SCUBA_LIST_INFO[list.list];
  const [typed, setTyped] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const inputId = `cp-scuba-${list.list}`;

  function add(text: string) {
    const parts = splitListEntries(text);
    if (!parts.length) return;
    const bad = parts.find((part) => scubaListEntryProblem(list.list, part));
    if (bad) { setProblem(scubaListEntryProblem(list.list, bad)); return; }
    const next = [...new Set([...entries, ...parts])].sort();
    if (next.length > MAX_ENTRIES) { setProblem(`A list holds at most ${MAX_ENTRIES} entries.`); return; }
    setProblem(null);
    setTyped("");
    onChange(next);
  }
  function onKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" || event.key === ",") { event.preventDefault(); add(typed); }
  }
  function onPaste(event: ClipboardEvent<HTMLInputElement>) {
    const text = event.clipboardData.getData("text");
    if (/[\s,;]/.test(text.trim())) { event.preventDefault(); add(text); }
  }

  return (
    <fieldset disabled={disabled}>
      <legend>{info.label} <Badge tone={entries.length ? "fine" : "soon"}>{entries.length ? `${entries.length} ${entries.length === 1 ? info.one : info.many}` : "Not set"}</Badge></legend>
      <p className="cp-muted">{info.help}</p>
      {entries.length ? (
        <ul aria-label={info.label} className="cp-scuba-chips">
          {entries.map((entry) => (
            <li className="cp-scuba-chip" key={entry}>
              <span>{entry}</span>
              <button aria-label={`Remove ${entry}`} className="cp-scuba-remove" onClick={() => onChange(entries.filter((other) => other !== entry))} type="button"><Icon name="close" /></button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="cp-scuba-add">
        <label className="filter-field" htmlFor={inputId}>
          <span>Add {info.one}</span>
          <input
            aria-describedby={problem ? `${inputId}-problem` : undefined}
            aria-invalid={problem ? true : undefined}
            autoComplete="off"
            id={inputId}
            inputMode={list.list === "sensitive-users" ? "email" : "url"}
            maxLength={2000}
            onChange={(event) => { setTyped(event.target.value); setProblem(null); }}
            onKeyDown={onKey}
            onPaste={onPaste}
            placeholder={info.example}
            value={typed}
          />
        </label>
        <button className="btn" disabled={!typed.trim()} onClick={() => add(typed)} type="button"><Icon name="plus" />Add</button>
      </div>
      {problem ? <p className="cp-error" id={`${inputId}-problem`} role="alert">{problem}</p> : null}
    </fieldset>
  );
}
