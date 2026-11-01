"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { BaselinesStyles } from "@/components/baselines/styles";
import { ActiveFilters, NoMatches, type ActiveFilter } from "@/components/list/active-filters";
import { SelectableList, type Grouping, type ListGroup } from "@/components/list/selectable-list";
import { NewRuleSheet } from "@/components/policies/new-rule-sheet";
import { RuleRecord } from "@/components/policies/rule-record";
import { Icon, type IconName } from "@/components/shell/icons";
import { RecordField, RecordGroup, TechnicalDetails } from "@/components/technical-details";
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
  kindWords,
  lastActionWords,
  parseFilters,
  RULE_STATE_FILTERS,
  ruleInState,
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
  watchedType,
} from "@/lib/policy-view";
import { kindOrder } from "@/lib/type-groups";
import type { Policy } from "@/lib/policies";
import { addsWords, tileCounts, tileParam, withoutTile, type FilterTile } from "@/lib/filter-set";
import { ago, formatTimestamp } from "@/lib/presentation";
import { personLabel } from "@/lib/sentences";
import { toast } from "@/lib/toast";
import { useLiveSearchParams, useViewState } from "@/lib/use-view-state";

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
  const params = useLiveSearchParams();
  const get = (key: string) => params?.get(key) ?? null;
  const filters = useMemo(() => parseFilters(get), [params]); // eslint-disable-line react-hooks/exhaustive-deps
  const creating = Boolean(view.get("new"));
  const [busy, setBusy] = useState<string | null>(null);

  const counts = useMemo(() => ruleCounts(policies), [policies]);
  const verdict = useMemo(() => rulesVerdict(policies, halted, now), [policies, halted, now]);
  const shown = useMemo(() => policies.filter((policy) => ruleMatches(policy, filters)), [policies, filters]);
  const filtering = Boolean(filters.states.length || filters.what);
  // What each state tile holds under the "what" filter, and what it would add.
  const stateTiles = useMemo<FilterTile<Policy>[]>(() => RULE_STATE_FILTERS.map((key) => ({ key, test: (policy: Policy) => ruleInState(policy, key) })), []);
  const tileTotals = useMemo(() => new Map(tileCounts(policies, stateTiles, filters.states, filters.what ? [(policy: Policy) => ruleKind(policy) === filters.what] : []).map((entry) => [entry.key, entry])), [policies, stateTiles, filters]);
  const activeFilters: ActiveFilter[] = [
    ...filters.states.map((key) => ({ key: `state:${key}`, label: key === "paused" ? "Paused or stopped" : key === "running" ? "Running" : "Off", clear: { state: withoutTile(filters.states, key) } })),
    ...(filters.what ? [{ key: "what", label: RULE_KINDS[filters.what].label, clear: { what: null } }] : []),
  ];

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
    { key: "running", label: "Running", icon: "check-circle", value: counts.running, small: counts.running ? "Acting on new changes" : "No rule is acting right now", changes: { state: tileParam(stateTiles, filters.states, "running") }, active: filters.states.includes("running") },
    { key: "paused", label: "Paused or stopped", icon: "pause", value: counts.paused + counts.stopped, small: pausedWords(counts.paused, counts.stopped), changes: { state: tileParam(stateTiles, filters.states, "paused") }, tone: counts.stopped ? "urgent" : counts.paused ? "soon" : undefined, active: filters.states.includes("paused") },
    { key: "off", label: "Off", icon: "hide", value: counts.off, small: counts.undoOff ? `${counts.undoOff === 1 ? "1 undo rule turns" : `${counts.undoOff} undo rules turn`} on after a preview` : "Turned on when needed", changes: { state: tileParam(stateTiles, filters.states, "off") }, active: filters.states.includes("off") },
    { key: "actions", label: "Actions this week", icon: "automation", value: counts.actionsWeek, small: counts.actionsWeek ? "Across every rule, the last 7 days" : "Nothing was undone in the last 7 days", changes: { state: null, what: null }, active: false },
  ];

  const groupings = useMemo<Grouping<Policy>[]>(() => [
    { key: "what", label: "What it does", groupsOf: (items) => groupBy(items, (item) => ruleKind(item), (key, list) => ({ label: RULE_KINDS[key as RuleKind].label, icon: RULE_KINDS[key as RuleKind].icon, about: `${RULE_KINDS[key as RuleKind].about} · ${rules(list.length)}` }), (key) => RULE_KIND_ORDER.indexOf(key as RuleKind)) },
    { key: "state", label: "State", groupsOf: (items) => groupBy(items, (item) => ruleState(item), (key, list) => ({ label: RULE_STATES[key as RuleState].plural, icon: RULE_STATES[key as RuleState].icon, about: rules(list.length) }), (key) => RULE_STATE_ORDER.indexOf(key as RuleState)) },
    // Service by service, and inside each by kind (users, groups, roles, then policies
    // and settings); rules that watch anything come last.
    { key: "kind", label: "Type of thing", groupsOf: (items) => groupBy(items, (item) => kindWords(item), (key, list) => ({ label: capital(key), icon: "cloud", about: rules(list.length) }), (key) => { const type = watchedType(items.find((item) => kindWords(item) === key)!); return type ? kindOrder(type) : Number.MAX_SAFE_INTEGER; }) },
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
          {tiles.map((tile) => {
            const adds = tile.key === "actions" ? null : addsWords(tileTotals.get(tile.key), filters.states.length);
            return (
              <Link aria-current={tile.active || undefined} className="po-tile" data-tone={tile.tone} href={href({ ...tile.changes, new: null })} key={tile.key} title={tile.key === "actions" ? "Show every rule" : tile.active ? "Picked: click to remove it from the view" : "Click to add these to the view"}>
                <span className="po-tile-label"><Icon name={tile.icon} />{tile.label}{tile.active ? <Icon className="tile-check" name="check" /> : null}</span>
                <b className="po-tile-count">{tile.value}</b>
                <small>{tile.small}</small>
                {adds ? <small className="tile-adds">{adds}</small> : null}
              </Link>
            );
          })}
        </section>

        <ActiveFilters filters={activeFilters} noun={{ one: "rule", many: "rules" }} shown={shown.length} total={policies.length} />

        <section aria-labelledby="po-rules-heading" className="po-section">
          <h2 className="visually-hidden" id="po-rules-heading">Rules</h2>
          {policies.length === 0 ? (
            <div className="po-empty">
              <p className="sel-empty">No automatic rules yet. Keel only reports changes; nothing acts on its own.</p>
              {canEdit ? <Link className="btn" href={href({ new: "1" })}><Icon name="plus" />New rule</Link> : null}
            </div>
          ) : shown.length === 0 ? (
            <NoMatches filters={activeFilters} noun={{ one: "rule", many: "rules" }} />
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
          <RecordField copy={false} label="Automation stop file" value={haltFile ?? "/var/lib/keel/AUTOMATION_DISABLED"} />
          <RecordField copy={false} label="Stop file state" value={halted ? `present since ${haltedAt ?? "unknown"}` : "absent"} />
          <RecordField copy={false} label="Read with" value="GET /api/policies" />
          {policies.map((policy) => (
            <RecordGroup key={policy.id} note={`automatic rule · ${policy.action}`} title={policy.name}>
              <RuleRecord policy={policy} />
            </RecordGroup>
          ))}
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
