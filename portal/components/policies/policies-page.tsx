"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";

import { BaselinesStyles } from "@/components/baselines/styles";
import { SelectableList, type Grouping, type ListGroup } from "@/components/list/selectable-list";
import { NewRuleSheet } from "@/components/policies/new-rule-sheet";
import { RuleRecord } from "@/components/policies/rule-record";
import { Icon, type IconName } from "@/components/shell/icons";
import { RecordField, TechnicalDetails } from "@/components/technical-details";
import { Badge } from "@/components/ui/badge";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { Person } from "@/components/ui/person";
import { Verdict } from "@/components/verdict";
import { changeRule, type RuleChange } from "@/lib/policy-change";
import {
  RULE_KINDS,
  RULE_KIND_ORDER,
  RULE_STATES,
  RULE_STATE_ORDER,
  filterWords,
  kindWords,
  lastActionWords,
  parseFilters,
  riskTone,
  ruleCounts,
  ruleKind,
  ruleMatches,
  ruleSentence,
  ruleState,
  rulesVerdict,
  runAsRef,
  turnOffDetail,
  type RuleKind,
  type RuleState,
} from "@/lib/policy-view";
import type { Policy } from "@/lib/policies";
import { ago, formatTimestamp } from "@/lib/presentation";
import { personLabel } from "@/lib/sentences";
import { toast } from "@/lib/toast";
import { useViewState } from "@/lib/use-view-state";

// Policies (portal audit, one design): automatic rules as one grouped list. Four count
// tiles (Running, Paused or stopped, Off, Actions this week) are links that set a
// filter in the address; the rules sit in a SelectableList grouped by what they do,
// with Turn off for several at once. The one amber action is Resume, when a rule
// paused itself. "New rule" (`?new=1`) opens a guided sheet. Ids stay in one record
// at the foot of the page.

export function PoliciesPage({ canEdit, policies, halted, haltedAt = null, haltFile, now = new Date().toISOString() }: {
  canEdit: boolean;
  policies: Policy[];
  halted: boolean;
  haltedAt?: string | null;
  haltFile?: string;
  now?: string;
}) {
  const router = useRouter();
  const view = useViewState();
  const pathname = usePathname() ?? "/policies";
  const params = useSearchParams();
  const get = (key: string) => params?.get(key) ?? null;
  const filters = useMemo(() => parseFilters(get), [params]); // eslint-disable-line react-hooks/exhaustive-deps
  const creating = Boolean(view.get("new"));
  const [busy, setBusy] = useState<string | null>(null);

  const counts = useMemo(() => ruleCounts(policies), [policies]);
  const verdict = useMemo(() => rulesVerdict(policies, halted, now), [policies, halted, now]);
  const shown = useMemo(() => policies.filter((policy) => ruleMatches(policy, filters)), [policies, filters]);
  const filtering = Boolean(filters.state || filters.what);

  const href = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params?.toString() ?? "");
    for (const [key, value] of Object.entries(changes)) if (value) next.set(key, value); else next.delete(key);
    const text = next.toString();
    return text ? `${pathname}?${text}` : pathname;
  };

  async function change(policy: Policy, kind: RuleChange) {
    setBusy(policy.id);
    try {
      const result = await changeRule(policy.id, kind);
      if (!result.ok) {
        toast({ tone: "warning", title: "Not changed", detail: result.reason });
        return;
      }
      toast({ title: kind === "resume" ? `${policy.name} resumed` : kind === "turn-off" ? `${policy.name} turned off` : `${policy.name} turned on` });
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  // Turn several rules off: one call per rule, then one toast that names what failed.
  async function turnOff(ids: string[]) {
    const chosen = shown.filter((policy) => ids.includes(policy.id) && policy.enabled);
    if (chosen.length === 0) { toast({ tone: "warning", title: "Nothing to turn off", detail: "The chosen rules are already off." }); return; }
    setBusy("many");
    try {
      const failed: string[] = [];
      for (const policy of chosen) {
        const result = await changeRule(policy.id, "turn-off");
        if (!result.ok) failed.push(policy.name);
      }
      const done = chosen.length - failed.length;
      if (failed.length) toast({ tone: "warning", title: `${done} of ${chosen.length} rules turned off`, detail: `Not changed: ${failed.join(", ")}.` });
      else toast({ title: `${done === 1 ? "1 rule" : `${done} rules`} turned off` });
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  const resume = verdict.resume;
  const verdictAction = creating ? null
    : resume && canEdit ? { label: "Resume", onClick: () => void change(resume, "resume"), busy: busy === resume.id }
    : verdict.tone === "urgent" && !halted && canEdit ? { label: "Open People", href: "/principals" }
    : null;

  const tiles: { key: string; label: string; icon: IconName; value: number; small: string; changes: Record<string, string | null>; tone?: "urgent" | "soon"; active: boolean }[] = [
    { key: "running", label: "Running", icon: "check-circle", value: counts.running, small: counts.running ? "Acting on new changes" : "No rule is acting right now", changes: { state: filters.state === "running" ? null : "running", what: null }, active: filters.state === "running" },
    { key: "paused", label: "Paused or stopped", icon: "pause", value: counts.paused + counts.stopped, small: pausedWords(counts.paused, counts.stopped), changes: { state: filters.state === "paused" ? null : "paused", what: null }, tone: counts.stopped ? "urgent" : counts.paused ? "soon" : undefined, active: filters.state === "paused" },
    { key: "off", label: "Off", icon: "hide", value: counts.off, small: counts.undoOff ? `${counts.undoOff === 1 ? "1 undo rule turns" : `${counts.undoOff} undo rules turn`} on after a preview` : "Turned on when needed", changes: { state: filters.state === "off" ? null : "off", what: null }, active: filters.state === "off" },
    { key: "actions", label: "Actions this week", icon: "automation", value: counts.actionsWeek, small: counts.actionsWeek ? "Across every rule, the last 7 days" : "Nothing was undone in the last 7 days", changes: { state: null, what: null }, active: false },
  ];

  const groupings = useMemo<Grouping<Policy>[]>(() => [
    { key: "what", label: "What it does", groupsOf: (items) => groupBy(items, (item) => ruleKind(item), (key, list) => ({ label: RULE_KINDS[key as RuleKind].label, icon: RULE_KINDS[key as RuleKind].icon, about: `${RULE_KINDS[key as RuleKind].about} · ${rules(list.length)}` }), (key) => RULE_KIND_ORDER.indexOf(key as RuleKind)) },
    { key: "state", label: "State", groupsOf: (items) => groupBy(items, (item) => ruleState(item), (key, list) => ({ label: RULE_STATES[key as RuleState].plural, icon: RULE_STATES[key as RuleState].icon, about: rules(list.length) }), (key) => RULE_STATE_ORDER.indexOf(key as RuleState)) },
    { key: "kind", label: "Kind of thing", groupsOf: (items) => groupBy(items, (item) => kindWords(item), (key, list) => ({ label: capital(key), icon: "cloud", about: rules(list.length) })) },
  ], []);

  const renderRow = (policy: Policy) => {
    const kind = ruleKind(policy);
    const state = ruleState(policy);
    const words = RULE_STATES[state];
    const person = runAsRef(policy);
    const rowBusy = busy !== null;
    return (
      <div className="po-row" data-state={state}>
        <span aria-hidden="true" className="po-kind" data-tone={riskTone(policy.max_blast_radius)}><Icon name={RULE_KINDS[kind].icon} /></span>
        <span className="po-row-name">
          <Link className="po-row-link" href={`/policies/${encodeURIComponent(policy.id)}`}>{policy.name}</Link>
          <small>{ruleSentence(policy)}</small>
        </span>
        <span className="po-row-mid">
          <Badge icon={words.icon} tone={words.tone}>{words.label}</Badge>
          <small>{lastActionWords(policy, now)}</small>
        </span>
        <span className="po-row-who">
          {person ? <Person person={person} /> : <span className="po-nobody"><Icon name="bell" />Acts as nobody</span>}
          {policy.actions_last_7_days ? <small>{policy.actions_last_7_days} {policy.actions_last_7_days === 1 ? "action" : "actions"} this week</small> : null}
        </span>
        <span className="po-row-acts">
          {kind === "alert" ? <Link className="btn btn-sm" href="/alerts">Open alerts</Link> : null}
          {canEdit && state === "paused" && resume?.id !== policy.id ? <button className="btn btn-sm" disabled={rowBusy} onClick={() => void change(policy, "resume")} type="button"><Icon name="play" />Resume</button> : null}
          {canEdit && state === "stopped" ? <Link className="btn btn-sm" href="/principals">Open People</Link> : null}
          {canEdit && state === "off" && kind === "undo" ? <Link className="btn btn-sm" href={`/policies/${encodeURIComponent(policy.id)}`}><Icon name="show" />Preview turning on</Link> : null}
          {canEdit && state === "off" && kind !== "undo" ? <button className="btn btn-sm" disabled={rowBusy} onClick={() => void change(policy, "turn-on")} type="button"><Icon name="play" />Turn on</button> : null}
          {canEdit && policy.enabled ? (
            <ConfirmButton confirmLabel="Turn off" description={<p>{policy.name} stops acting on new changes.{kind === "undo" ? " It needs a preview to turn back on." : ""}</p>} disabled={rowBusy} onConfirm={() => change(policy, "turn-off")} size="sm" title={`Turn off ${policy.name}?`}>
              <Icon name="pause" />Turn off
            </ConfirmButton>
          ) : null}
        </span>
      </div>
    );
  };

  return (
    <div className="po-page">
      <Verdict action={verdictAction} detail={verdict.detail} text={verdict.text} tone={verdict.tone} />
      <div data-layer="explanation">
        {halted ? (
          <div className="po-note" data-tone="urgent" role="status">
            <Icon name="alert" />
            <div>
              <b>Automation is stopped by an operator{haltedAt ? <> since <time dateTime={haltedAt} title={formatTimestamp(haltedAt)}>{ago(haltedAt, now)}</time></> : null}.</b>
              <p>Ask an operator to start it again. Until then no rule acts, whatever its state here.</p>
            </div>
          </div>
        ) : null}

        <section aria-label="Rules at a glance" className="po-tiles">
          {tiles.map((tile) => (
            <Link aria-current={tile.active || undefined} className="po-tile" data-tone={tile.tone} href={href({ ...tile.changes, new: null })} key={tile.key}>
              <span className="po-tile-label"><Icon name={tile.icon} />{tile.label}</span>
              <b className="po-tile-count">{tile.value}</b>
              <small>{tile.small}</small>
            </Link>
          ))}
        </section>

        {filtering ? (
          <p className="po-filter-note" role="status">
            Showing {filterWords(filters)} only: {shown.length} of {policies.length}.
            <Link className="po-inline-link" href={href({ state: null, what: null })}>Show everything</Link>
          </p>
        ) : null}

        <section aria-labelledby="po-rules-heading" className="po-section">
          <h2 className="visually-hidden" id="po-rules-heading">Rules</h2>
          {policies.length === 0 ? (
            <div className="po-empty">
              <p className="sel-empty">No automatic rules yet. Keel only reports changes; nothing acts on its own.</p>
              {canEdit ? <Link className="btn" href={href({ new: "1" })}><Icon name="plus" />New rule</Link> : null}
            </div>
          ) : shown.length === 0 ? (
            <p className="sel-empty">No rule matches this filter.</p>
          ) : (
            <SelectableList
              action={{
                label: (count) => `Turn off ${count === 1 ? "1 rule" : `${count} rules`}`,
                detail: (count, ids) => {
                  const chosen = shown.filter((policy) => ids.includes(policy.id));
                  return turnOffDetail(count, chosen.filter((policy) => policy.enabled && ruleKind(policy) === "undo").length, chosen.filter((policy) => !policy.enabled).length);
                },
                run: (ids) => void turnOff(ids),
              }}
              getId={(item) => item.id}
              groupings={groupings}
              items={shown}
              label="Automatic rules"
              matches={(item, text) => `${item.name} ${ruleSentence(item)} ${RULE_STATES[ruleState(item)].label} ${personLabel(runAsRef(item), "")}`.toLowerCase().includes(text)}
              noun={{ one: "rule", many: "rules" }}
              renderRow={renderRow}
              rowName={(item) => item.name}
              toneOf={(item) => (ruleState(item) === "stopped" ? "urgent" : ruleState(item) === "paused" ? "soon" : null)}
            />
          )}
        </section>

        <TechnicalDetails summary="Technical details for these rules">
          <RecordField copy={false} label="Automation stop file" value={`${haltFile ?? "/var/lib/keel/AUTOMATION_DISABLED"} · ${halted ? `present since ${haltedAt ?? "unknown"}` : "absent"}`} />
          <RecordField copy={false} label="Read with" value="GET /api/policies" />
          {policies.map((policy) => <RuleRecord key={policy.id} policy={policy} />)}
        </TechnicalDetails>
      </div>

      {creating ? <BaselinesStyles /> : null}
      {creating && canEdit ? <NewRuleSheet onClose={() => view.set({ new: null })} /> : null}
    </div>
  );
}

function pausedWords(paused: number, stopped: number): string {
  const parts = [paused ? `${paused} hit ${paused === 1 ? "its" : "their"} limit` : null, stopped ? `${stopped} ${stopped === 1 ? "needs" : "need"} repair` : null].filter(Boolean);
  return parts.length ? parts.join(", ") : "Nothing is waiting on you";
}

function rules(count: number): string {
  return `${count} ${count === 1 ? "rule" : "rules"}`;
}

function capital(text: string): string {
  return text.replace(/^./, (letter) => letter.toUpperCase());
}

function groupBy<T>(items: T[], key: (item: T) => string, meta: (key: string, list: T[]) => Omit<ListGroup<T>, "items" | "key">, rank?: (key: string) => number): ListGroup<T>[] {
  const map = new Map<string, T[]>();
  for (const item of items) map.set(key(item), [...(map.get(key(item)) ?? []), item]);
  const groups = [...map.entries()].map(([groupKey, list]) => ({ key: groupKey, ...meta(groupKey, list), items: list }));
  return rank ? groups.sort((a, b) => rank(a.key) - rank(b.key)) : groups.sort((a, b) => a.label.localeCompare(b.label));
}
