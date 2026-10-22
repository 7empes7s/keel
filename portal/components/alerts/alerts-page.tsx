"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState, type MouseEvent } from "react";

import { AlertRecord } from "@/components/alerts/alert-record";
import { DetailsSheet } from "@/components/baselines/details-sheet";
import { BaselinesStyles } from "@/components/baselines/styles";
import { ConfirmSheet } from "@/components/incidents/confirm-sheet";
import { SelectableList, type Grouping, type ListGroup } from "@/components/list/selectable-list";
import { Icon, type IconName } from "@/components/shell/icons";
import { RecordGroup, TechnicalDetails } from "@/components/technical-details";
import { Badge } from "@/components/ui/badge";
import { Person } from "@/components/ui/person";
import { Verdict } from "@/components/verdict";
import { alertCall, alertCallWords, type AlertAction } from "@/lib/alert-calls";
import {
  FILTER_WORDS,
  HISTORY_ICONS,
  SEVERITY,
  SEVERITY_ORDER,
  STATE_GROUPS,
  STATE_GROUP_ORDER,
  STATE_WORDS,
  actionable,
  alertCounts,
  alertMatches,
  alertService,
  alertTitle,
  alertTone,
  alertsVerdict,
  bulkDetail,
  causeSentence,
  changeLink,
  deadlineSentence,
  deadlineWords,
  escalationWords,
  historyLabel,
  inboxOrder,
  isActive,
  isOverdue,
  isWaiting,
  parseAlertFilter,
  stateGroup,
  type AlertFilter,
  type AlertItem,
  type AlertState,
  type StateGroup,
} from "@/lib/alerts-view";
import { ago, formatTimestamp, fromNow } from "@/lib/presentation";
import { serviceOrder } from "@/lib/services";
import type { EngineRef } from "@/lib/sentences";
import { toast } from "@/lib/toast";
import { pushUrl } from "@/lib/url-history";
import { usePoll } from "@/lib/use-poll";
import { readList, useViewState } from "@/lib/use-view-state";

// Alerts (portal audit, one design): a status pill and a verdict whose one amber action
// acknowledges the overdue alerts; four tiles that set `state=` in the address; the
// alerts in a SelectableList grouped by state (default), service, severity or owner,
// with Acknowledge for several at once and Resolve or Mute under More. A row opens its
// panel (`open=<alertId>`, Back closes it): the cause in words, a link to the change,
// the history as a timeline, Acknowledge with a note, Resolve with a reason, and Mute.
// Ids stay in Technical details.

type Step = "resolve" | "mute";

const ownerRef = (alert: AlertItem): EngineRef | null => (alert.owner ? { kind: "principal", id: alert.owner.id, name: alert.owner.name, readable: true } : null);
const plural = (count: number) => `${count} ${count === 1 ? "alert" : "alerts"}`;

export function AlertsPage({ alerts, now, canRespond, canMute }: {
  alerts: AlertItem[];
  now: string;
  canRespond: boolean;
  canMute: boolean;
}) {
  const router = useRouter();
  const view = useViewState();
  const pathname = usePathname() ?? "/alerts";
  const params = useSearchParams();
  const filter = parseAlertFilter(params?.get("state"));
  const openId = view.get("open");
  const step = (["resolve", "mute"] as const).find((value) => value === view.get("do")) ?? null;
  const picked = readList(view.get("pick"));
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  // Live: read the alerts again every 10 seconds while the tab is visible.
  usePoll(() => router.refresh(), 10_000);

  // What this page changed, until the server's next read says where each alert stands.
  const [changed, setChanged] = useState<Record<string, AlertState>>({});
  useEffect(() => { setChanged({}); }, [alerts]);
  const items = useMemo(() => alerts.map((alert) => {
    const state = changed[alert.id];
    if (!state || state === alert.state) return alert;
    return { ...alert, state, acknowledgedAt: state === "acknowledged" ? alert.acknowledgedAt ?? now : alert.acknowledgedAt, acknowledgedByName: state === "acknowledged" ? alert.acknowledgedByName ?? "you" : alert.acknowledgedByName };
  }), [alerts, changed, now]);

  const counts = useMemo(() => alertCounts(items, now), [items, now]);
  const verdict = useMemo(() => alertsVerdict(items, now), [items, now]);
  const ordered = useMemo(() => inboxOrder(items), [items]);
  const shown = useMemo(() => ordered.filter((alert) => alertMatches(alert, filter, now)), [ordered, filter, now]);
  const opened = items.find((alert) => alert.id === openId) ?? null;
  const pickedAlerts = items.filter((alert) => picked.includes(alert.id));
  const overdueIds = items.filter((alert) => isOverdue(alert, now)).map((alert) => alert.id);

  useEffect(() => { setNote(""); }, [openId]);

  const href = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params?.toString() ?? "");
    for (const [key, value] of Object.entries(changes)) if (value) next.set(key, value); else next.delete(key);
    const text = next.toString();
    return text ? `${pathname}?${text}` : pathname;
  };
  const openHref = (id: string, action: Step | null = null) => href({ open: id, do: action, pick: null });
  const follow = (event: MouseEvent, to: string) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    pushUrl(to);
  };
  const closeAll = () => view.set({ open: null, do: null, pick: null });
  const back = () => (picked.length || !opened ? closeAll() : view.set({ do: null }));

  // One call per alert; one toast that names what did not change.
  async function run(action: AlertAction, ids: string[], text?: string): Promise<string | null> {
    const chosen = items.filter((alert) => ids.includes(alert.id) && actionable(action, alert));
    if (chosen.length === 0) {
      toast({ tone: "warning", title: "Nothing to change", detail: action === "acknowledge" ? "The chosen alerts are already acknowledged or closed." : "The chosen alerts are already in that state." });
      return null;
    }
    setBusy(true);
    try {
      const failed: { alert: AlertItem; why: string }[] = [];
      const next: Record<string, AlertState> = {};
      for (const alert of chosen) {
        const result = await alertCall(alert.id, action, text);
        const why = alertCallWords(result);
        if (why) failed.push({ alert, why });
        else if (result.state) next[alert.id] = result.state as AlertState;
      }
      setChanged((current) => ({ ...current, ...next }));
      const done = chosen.length - failed.length;
      const verb = { acknowledge: "acknowledged", resolve: "resolved", mute: "muted", unmute: "unmuted" }[action];
      if (failed.length === chosen.length) {
        const why = failed[0].why;
        toast({ tone: "warning", title: "Not changed", detail: why });
        router.refresh();
        return why;
      }
      if (failed.length) toast({ tone: "warning", title: `${done} of ${chosen.length} alerts ${verb}`, detail: `Not changed: ${failed.map((entry) => alertTitle(entry.alert)).join(", ")}.` });
      else toast({ title: chosen.length === 1 ? `Alert ${verb}` : `${plural(done)} ${verb}`, detail: chosen.length === 1 ? alertTitle(chosen[0]) : undefined });
      // Read every alert back from what Keel recorded.
      router.refresh();
      return null;
    } finally {
      setBusy(false);
    }
  }

  const verdictAction = canRespond && overdueIds.length
    ? { label: overdueIds.length === 1 ? "Acknowledge the overdue one" : "Acknowledge the overdue ones", onClick: () => void run("acknowledge", overdueIds), busy }
    : null;

  const tiles: { key: AlertFilter; label: string; icon: IconName; value: number; small: string; tone?: "urgent" | "soon" }[] = [
    { key: "waiting", label: "Needs someone", icon: "bell", value: counts.waiting, small: counts.waiting ? "Nobody has acknowledged them" : "Nothing is waiting", tone: counts.waiting ? "soon" : undefined },
    { key: "overdue", label: "Past deadline", icon: "clock", value: counts.overdue, small: counts.overdue ? "Missed the time to acknowledge" : "Every deadline is met", tone: counts.overdue ? "urgent" : undefined },
    { key: "acknowledged", label: "Acknowledged", icon: "check", value: counts.acknowledged, small: counts.acknowledged ? "Someone is on it" : "None in hand right now" },
    { key: "resolved", label: "Resolved this week", icon: "check-circle", value: counts.resolvedWeek, small: "Closed in the last 7 days" },
  ];

  const groupings = useMemo<Grouping<AlertItem>[]>(() => [
    { key: "state", label: "State", groupsOf: (list) => groupBy(list, (alert) => stateGroup(alert), (key, group) => ({ label: STATE_GROUPS[key as StateGroup].label, icon: STATE_GROUPS[key as StateGroup].icon, about: STATE_GROUPS[key as StateGroup].about + ` · ${plural(group.length)}` }), (key) => STATE_GROUP_ORDER.indexOf(key as StateGroup)) },
    // Microsoft's services in the portal's order (Entra ID first), not by name.
    { key: "service", label: "Service", groupsOf: (list) => groupBy(list, (alert) => alertService(alert).name, (key, group) => ({ label: key, icon: alertService(group[0]).icon, about: plural(group.length) }), (key) => serviceOrder(list.map(alertService).find((service) => service.name === key)?.code)) },
    { key: "severity", label: "Severity", groupsOf: (list) => groupBy(list, (alert) => alert.severity, (key, group) => ({ label: SEVERITY[key as AlertItem["severity"]].label, icon: SEVERITY[key as AlertItem["severity"]].icon, about: plural(group.length) }), (key) => SEVERITY_ORDER.indexOf(key as AlertItem["severity"])) },
    { key: "owner", label: "Owner", groupsOf: (list) => groupBy(list, (alert) => alert.owner?.name ?? "No owner", (key, group) => ({ label: key, icon: "bell", about: plural(group.length) }), (key) => (key === "No owner" ? 1 : 0)) },
  ], []);

  const renderRow = (alert: AlertItem) => {
    const severity = SEVERITY[alert.severity];
    const state = STATE_WORDS[alert.state];
    const due = deadlineWords(alert, now);
    const service = alertService(alert);
    return (
      <div className="al-row" data-state={stateGroup(alert)}>
        <span aria-hidden="true" className="al-kind" data-tone={alertTone(alert) ?? undefined} title={service.name}><Icon name={service.icon} /></span>
        <span className="al-row-name">
          <Link className="al-row-link" href={openHref(alert.id)} onClick={(event) => follow(event, openHref(alert.id))}>{alertTitle(alert)}</Link>
          <small>{causeSentence(alert)}</small>
        </span>
        <span className="al-row-mid">
          <span className="al-row-badges">
            <Badge icon={severity.icon} tone={isActive(alert) ? severity.tone : "neutral"}>{severity.label}</Badge>
            <Badge icon={state.icon} tone={state.tone}>{state.label}</Badge>
          </span>
          <small className="al-due" data-tone={due.tone ?? undefined}>{due.text}</small>
        </span>
        <span className="al-row-who">
          {alert.owner ? <Person person={ownerRef(alert)} /> : <span className="al-nobody"><Icon name="bell" />No owner</span>}
        </span>
      </div>
    );
  };

  const sheetOpen = Boolean(opened || step);

  return (
    <div className="al-page">
      <Verdict action={verdictAction} text={verdict.text} tone={verdict.tone} />
      <div data-layer="explanation">
        <section aria-label="Alerts at a glance" className="al-tiles">
          {tiles.map((tile) => (
            <Link aria-current={filter === tile.key || undefined} className="al-tile" data-tone={tile.tone} href={href({ state: filter === tile.key ? null : tile.key, open: null, do: null, pick: null, closed: null })} key={tile.key}>
              <span className="al-tile-label"><Icon name={tile.icon} />{tile.label}</span>
              <b className="al-tile-count">{tile.value}</b>
              <small>{tile.small}</small>
            </Link>
          ))}
        </section>

        {filter ? (
          <p className="al-filter-note" role="status">
            Showing {FILTER_WORDS[filter]} only: {shown.length} of {items.length}.
            <Link className="al-inline-link" href={href({ state: null, closed: null })}>Show everything</Link>
          </p>
        ) : null}

        <section aria-labelledby="al-list-heading" className="al-section">
          <h2 className="visually-hidden" id="al-list-heading">Alerts</h2>
          {items.length === 0 ? (
            <p className="sel-empty">No alerts yet. When a check finds a change, it shows here.</p>
          ) : shown.length === 0 ? (
            <p className="sel-empty">No alert matches this filter.</p>
          ) : (
            <SelectableList
              action={{
                label: (count) => `Acknowledge ${plural(count)}`,
                detail: (_count, ids) => bulkDetail("acknowledge", items.filter((alert) => ids.includes(alert.id))),
                run: (ids) => void run("acknowledge", ids),
              }}
              closedByDefault={filter ? [] : ["resolved", "muted"]}
              getId={(alert) => alert.id}
              groupings={groupings}
              items={shown}
              key={filter ?? "all"}
              label="Alerts"
              matches={(alert, text) => `${alertTitle(alert)} ${causeSentence(alert)} ${STATE_WORDS[alert.state].label} ${SEVERITY[alert.severity].label} ${alert.owner?.name ?? "no owner"}`.toLowerCase().includes(text)}
              more={[
                { label: "Resolve…", run: (ids) => pushUrl(href({ do: "resolve", pick: ids.join(","), open: null })) },
                ...(canMute ? [{ label: "Mute…", run: (ids: string[]) => pushUrl(href({ do: "mute", pick: ids.join(","), open: null })) }] : []),
              ]}
              noun={{ one: "alert", many: "alerts" }}
              renderRow={renderRow}
              rowName={(alert) => alertTitle(alert)}
              toneOf={alertTone}
            />
          )}
        </section>

        <TechnicalDetails summary="Technical details for these alerts">
          {ordered.map((alert) => (
            <RecordGroup key={alert.id} note={`alert · ${alert.control} / ${alert.condition}`} title={alertTitle(alert)}>
              <AlertRecord alert={alert} />
            </RecordGroup>
          ))}
        </TechnicalDetails>
      </div>

      {sheetOpen ? <BaselinesStyles /> : null}

      {opened && !step ? (
        <DetailsSheet
          footer={canRespond && isActive(opened) || canMute ? (
            <div className="al-sheet-actions">
              {canRespond && isWaiting(opened) ? <button aria-busy={busy || undefined} className="btn btn-primary" disabled={busy} form="al-ack" type="submit">Acknowledge</button> : null}
              {canRespond && isActive(opened) ? <Link className="btn" href={openHref(opened.id, "resolve")} onClick={(event) => follow(event, openHref(opened.id, "resolve"))}>Resolve</Link> : null}
              {canMute && opened.state !== "suppressed" ? <Link className="btn" href={openHref(opened.id, "mute")} onClick={(event) => follow(event, openHref(opened.id, "mute"))}><Icon name="pause" />Mute</Link> : null}
              {canMute && opened.state === "suppressed" ? <button className="btn" disabled={busy} onClick={() => void run("unmute", [opened.id])} type="button"><Icon name="play" />Unmute</button> : null}
            </div>
          ) : undefined}
          key={opened.id}
          kicker={<span className="al-sheet-kicker"><Badge icon={SEVERITY[opened.severity].icon} tone={isActive(opened) ? SEVERITY[opened.severity].tone : "neutral"}>{SEVERITY[opened.severity].label}</Badge><Badge icon={STATE_WORDS[opened.state].icon} tone="neutral">{STATE_WORDS[opened.state].label}</Badge></span>}
          onClose={closeAll}
          title={alertTitle(opened)}
        >
          <AlertPanel alert={opened} canRespond={canRespond} note={note} now={now} onAcknowledge={() => void run("acknowledge", [opened.id], note)} setNote={setNote} />
        </DetailsSheet>
      ) : null}

      {step === "resolve" && (opened || pickedAlerts.length) ? (
        <ConfirmSheet
          confirmLabel={opened ? "Resolve alert" : `Resolve ${plural(pickedAlerts.filter(isActive).length)}`}
          effect={opened ? "The alert closes now. If the change is still there, the next check opens it again, and its history is kept." : bulkDetail("resolve", pickedAlerts)}
          kicker={opened ? alertTitle(opened) : `${plural(pickedAlerts.length)} selected`}
          onClose={back}
          onConfirm={async (reason) => {
            const failed = await run("resolve", opened ? [opened.id] : picked, reason);
            if (!failed) closeAll();
            return failed;
          }}
          placeholder="For example: checked with the owner, the change was planned"
          reasonLabel="Why is it resolved?"
          title={opened ? "Resolve this alert?" : "Resolve these alerts?"}
        />
      ) : null}

      {step === "mute" && canMute && (opened || pickedAlerts.length) ? (
        <ConfirmSheet
          confirmLabel={opened ? "Mute alert" : `Mute ${plural(pickedAlerts.filter((alert) => alert.state !== "suppressed").length)}`}
          effect={opened ? "Keel keeps recording it but tells nobody until someone unmutes it." : bulkDetail("mute", pickedAlerts)}
          kicker={opened ? alertTitle(opened) : `${plural(pickedAlerts.length)} selected`}
          onClose={back}
          onConfirm={async (reason) => {
            const failed = await run("mute", opened ? [opened.id] : picked, reason);
            if (!failed) closeAll();
            return failed;
          }}
          placeholder="For example: a known change while the migration runs"
          reasonLabel="Why mute it?"
          title={opened ? "Mute this alert?" : "Mute these alerts?"}
        />
      ) : null}
    </div>
  );
}

function AlertPanel({ alert, now, canRespond, note, setNote, onAcknowledge }: {
  alert: AlertItem;
  now: string;
  canRespond: boolean;
  note: string;
  setNote: (value: string) => void;
  onAcknowledge: () => void;
}) {
  const link = changeLink(alert);
  const deadline = deadlineSentence(alert, now, ago, fromNow);
  const escalation = escalationWords(alert.escalationError);
  const back = alert.occurrence - 1;
  return (
    <div className="al-panel">
      <section className="al-panel-cause">
        <p>{causeSentence(alert)}</p>
        <Link className="btn btn-sm" href={link.href}><Icon name="link" />{link.label}</Link>
      </section>

      <dl className="al-facts">
        <div>
          <dt><Icon name="bell" />Owner</dt>
          <dd>
            {alert.owner ? <Person person={ownerRef(alert)} /> : <span>No owner. It waits for whoever acknowledges it.</span>}
            <Link className="al-inline-link" href="/notifications">Set owners and deadlines</Link>
          </dd>
        </div>
        <div>
          <dt><Icon name="clock" />Deadline</dt>
          <dd data-tone={isOverdue(alert, now) ? "urgent" : undefined}>{deadline ?? (alert.state === "acknowledged" && alert.acknowledgedAt ? `Acknowledged by ${alert.acknowledgedByName ?? "someone"} ${ago(alert.acknowledgedAt, now)}. It stays open until the change goes away.` : "None: it is closed.")}</dd>
        </div>
        <div>
          <dt><Icon name="calendar" />Opened</dt>
          <dd>
            <span>
              <time dateTime={alert.firstOpenedAt} title={formatTimestamp(alert.firstOpenedAt)}>{ago(alert.firstOpenedAt, now)}</time>
              {back > 0 ? `. It has come back ${back === 1 ? "once" : `${back} times`}.` : null}
            </span>
          </dd>
        </div>
      </dl>

      {escalation ? (
        <p className="al-note" data-tone="urgent" role="note"><Icon name="alert" /><span>{escalation} <Link className="al-inline-link" href="/notifications">Set a channel</Link></span></p>
      ) : null}

      {canRespond && isWaiting(alert) ? (
        <form className="al-ack" id="al-ack" onSubmit={(event) => { event.preventDefault(); onAcknowledge(); }}>
          <label className="filter-field">
            <span>Note (optional)</span>
            <textarea maxLength={1000} name="note" onChange={(event) => setNote(event.target.value)} placeholder="For example: looking into it with the network team" rows={2} value={note} />
          </label>
        </form>
      ) : null}

      <section aria-labelledby="al-history-heading" className="al-history">
        <h3 id="al-history-heading">What happened</h3>
        <ol className="al-timeline">
          {[...alert.history].reverse().map((entry) => (
            <li key={entry.id}>
              <span aria-hidden="true" className="al-timeline-dot"><Icon name={HISTORY_ICONS[entry.reason] ?? "info"} /></span>
              <span className="al-timeline-body">
                <b>{historyLabel(entry)}</b>
                <small>
                  <time dateTime={entry.at} title={formatTimestamp(entry.at)}>{ago(entry.at, now)}</time>
                  {entry.actorName ? `, by ${entry.actorName}` : ""}
                </small>
                {entry.note ? <q>{entry.note}</q> : null}
              </span>
            </li>
          ))}
        </ol>
      </section>

      <TechnicalDetails>
        <AlertRecord alert={alert} />
      </TechnicalDetails>
    </div>
  );
}

function groupBy<T>(items: T[], key: (item: T) => string, meta: (key: string, list: T[]) => Omit<ListGroup<T>, "items" | "key">, rank?: (key: string) => number): ListGroup<T>[] {
  const map = new Map<string, T[]>();
  for (const item of items) map.set(key(item), [...(map.get(key(item)) ?? []), item]);
  const groups = [...map.entries()].map(([groupKey, list]) => ({ key: groupKey, ...meta(groupKey, list), items: list }));
  return rank ? groups.sort((a, b) => rank(a.key) - rank(b.key) || a.label.localeCompare(b.label)) : groups.sort((a, b) => a.label.localeCompare(b.label));
}
