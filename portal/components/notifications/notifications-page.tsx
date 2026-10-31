"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useMemo, useState, type FormEvent, type MouseEvent } from "react";

import { DetailsSheet } from "@/components/baselines/details-sheet";
import { BaselinesStyles } from "@/components/baselines/styles";
import { type ListSort } from "@/components/list/list-paging";
import { ActiveFilters, NoMatches, type ActiveFilter } from "@/components/list/active-filters";
import { SelectableList, type Grouping, type ListGroup } from "@/components/list/selectable-list";
import { byTime } from "@/lib/paging";
import { OptionPicker } from "@/components/pickers/option-picker";
import { Segmented, type ChoiceOption } from "@/components/pickers/segmented";
import { Icon, type IconName } from "@/components/shell/icons";
import { RecordField, RecordGroup, TechnicalDetails, type RecordValue } from "@/components/technical-details";
import { ErrorNotice } from "@/components/ui/error-notice";
import { Badge } from "@/components/ui/badge";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { Verdict } from "@/components/verdict";
import { notificationCalls, type CallResult } from "@/lib/notification-calls";
import type { Channel, Delivery, EscalationRule, Subscription } from "@/lib/notifications";
import {
  CHANNEL_KINDS,
  CHANNEL_KIND_ORDER,
  HEALTH_ORDER,
  HEALTH_WORDS,
  OUTCOME_WORDS,
  RULE_EVENTS,
  WAIT_PRESETS,
  channelAbout,
  channelHealth,
  channelIcon,
  channelKind,
  channelKindLabel,
  channelName,
  channelSentence,
  clockWords,
  dayKey,
  dayLabel,
  deliveryBadge,
  deliveryHref,
  deliveryProblem,
  deliveryTime,
  deliveryTitle,
  durationWords,
  escalationOwner,
  escalationTarget,
  escalationTitle,
  eventWords,
  notificationCounts,
  notificationsVerdict,
  orderChannels,
  ruleSentence,
  severityWords,
  writeError,
  type ChannelKind,
} from "@/lib/notifications-view";
import { applyFilters, readPicked, tileParam, withoutTile, type FilterTile } from "@/lib/filter-set";
import { displayEnum, formatTimestamp } from "@/lib/presentation";
import { orderGroups } from "@/lib/selection";
import { toast } from "@/lib/toast";
import { pushUrl } from "@/lib/url-history";
import { useLiveSearchParams, useViewState } from "@/lib/use-view-state";
import { csvLine } from "@/lib/csv";

// Notifications (portal audit, pick A): three tabs. "Where alerts go" lists the channels
// with their health from the last send; "Who gets which alerts" lists the rules and,
// under them, the "when nobody responds" escalation rules; "Sent" lists every send,
// failures first, each linking to its alert. Tiles filter (`tab=`, `status=`), a channel
// or rule opens in a panel (`open=`, pushed so Back closes it), forms open in the same
// panel (`add=`). Ids stay in one record at the foot of the page.

export interface PersonChoice { id: string; name: string | null; email: string | null }

type Tab = "channels" | "rules" | "sent";
const TABS: ChoiceOption<Tab>[] = [
  { value: "channels", label: "Where alerts go" },
  { value: "rules", label: "Who gets which alerts" },
  { value: "sent", label: "Sent" },
];
// Sent can also be ordered by when it was sent; Name and Risk come with every list.
const SENT_SORTS: ListSort<Delivery>[] = [{ key: "when", label: "When sent", desc: true, compare: (a, b) => byTime(deliveryTime(a), deliveryTime(b)) }];

const PHONE_TABS: Record<Tab, string> = { channels: "Channels", rules: "Rules", sent: "Sent" };

const SEVERITIES: ChoiceOption<string>[] = [
  { value: "notice", label: "Notice", hint: "Every alert" },
  { value: "warning", label: "Warning", hint: "Warning or above" },
  { value: "critical", label: "Critical", hint: "Critical only" },
];

const STATUS_CHIPS: { value: string; label: string }[] = [
  { value: "delivered", label: "Delivered" },
  { value: "retrying", label: "Trying again" },
  { value: "failed", label: "Failed" },
];
// Outcomes add up: `status=failed,retrying` shows sends in either. Channel narrows.
const STATUS_TILES: FilterTile<Delivery>[] = STATUS_CHIPS.map((chip) => ({
  key: chip.value,
  test: (delivery: Delivery) => (chip.value === "retrying" ? !["delivered", "failed", "cancelled"].includes(delivery.status) : delivery.status === chip.value),
}));

export function NotificationsPage({ canConfiguration, channels, subscriptions, escalationRules = [], deliveries, deliveryLimit, people = [], now = new Date().toISOString() }: {
  canConfiguration: boolean;
  channels: Channel[];
  subscriptions: Subscription[];
  escalationRules?: EscalationRule[];
  deliveries: Delivery[];
  // How many sends the server read; a full read means older ones were left out.
  deliveryLimit?: number;
  people?: PersonChoice[];
  now?: string;
}) {
  const router = useRouter();
  const view = useViewState();
  const pathname = usePathname() ?? "/notifications";
  const params = useLiveSearchParams();
  const tab: Tab = !canConfiguration ? "sent" : view.get("tab") === "rules" ? "rules" : view.get("tab") === "sent" ? "sent" : "channels";
  const opened = view.get("open");
  const adding = view.get("add");
  const statusFilter = readPicked(STATUS_TILES, view.get("status"));
  const statusKey = statusFilter.join(",");
  const channelFilter = view.get("channel");

  // A test alert queued from this page shows under Sent at once; the next read replaces it.
  const [queued, setQueued] = useState<Delivery[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const allDeliveries = useMemo(() => {
    const known = new Set(deliveries.map((delivery) => delivery.id));
    return [...queued.filter((delivery) => !known.has(delivery.id)), ...deliveries];
  }, [deliveries, queued]);

  const channelById = useMemo(() => new Map(channels.map((channel) => [channel.id, channel])), [channels]);
  const counts = useMemo(() => notificationCounts({ channels, subscriptions, escalationRules, deliveries: allDeliveries }, now), [channels, subscriptions, escalationRules, allDeliveries, now]);
  const verdict = useMemo(() => notificationsVerdict({ channels: canConfiguration ? channels : null, subscriptions, deliveries: allDeliveries }, now), [canConfiguration, channels, subscriptions, allDeliveries, now]);
  const ordered = useMemo(() => orderChannels(channels, allDeliveries, now), [channels, allDeliveries, now]);
  const health = useMemo(() => new Map(channels.map((channel) => [channel.id, channelHealth(channel, allDeliveries, now)])), [channels, allDeliveries, now]);

  const href = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params?.toString() ?? "");
    for (const [key, value] of Object.entries(changes)) if (value) next.set(key, value); else next.delete(key);
    const text = next.toString();
    return text ? `${pathname}?${text}` : pathname;
  };
  const follow = (event: MouseEvent, changes: Record<string, string | null>, push = false) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    if (push) pushUrl(href(changes));
    else view.set(changes);
  };
  const openPanel = (event: MouseEvent, id: string) => follow(event, { open: id, add: null }, true);
  const closePanel = () => { setError(null); view.set({ open: null, add: null }); };
  const switchTab = (next: Tab) => view.set({ tab: next, open: null, add: null, status: null, channel: null, group: null, q: null, closed: null }, { tab: "channels" });

  function failed(result: CallResult) {
    setError(writeError(result.status, result.payload as { error?: string } | null));
    if (result.status === 404 || result.status === 409) router.refresh();
  }

  async function run(key: string, work: () => Promise<CallResult>, onOk: (result: CallResult) => void) {
    setBusy(key); setError(null);
    try {
      const result = await work();
      if (!result.ok) { failed(result); return false; }
      onOk(result);
      router.refresh();
      return true;
    } catch {
      setError(writeError(0, null));
      return false;
    } finally {
      setBusy(null);
    }
  }

  const sendTest = (channel: Channel) => run(`test:${channel.id}`, () => notificationCalls.testChannel(channel.id), (result) => {
    const delivery = (result.payload?.delivery ?? null) as Partial<Delivery> | null;
    if (delivery?.id) setQueued((current) => [{ ...(delivery as Delivery), channel_kind: channel.kind, created_at: delivery.created_at ?? now }, ...current]);
    const words = OUTCOME_WORDS.testQueued(channelName(channel));
    toast({ tone: "info", title: words.title, detail: words.detail, href: href({ tab: "sent", channel: channel.id, open: null, add: null, status: null }), hrefLabel: "Show under Sent" });
  });
  const turnOff = (channel: Channel) => run(`off:${channel.id}`, () => notificationCalls.turnChannelOff(channel.id), () => { const words = OUTCOME_WORDS.channelOff(channelName(channel)); toast({ tone: "info", title: words.title, detail: words.detail }); });
  const turnOn = (channel: Channel) => run(`on:${channel.id}`, () => notificationCalls.turnChannelOn(channel.id), () => toast({ tone: "success", title: OUTCOME_WORDS.channelOn(channelName(channel)).title }));
  const deleteRule = (rule: Subscription) => run(`delete:${rule.id}`, () => notificationCalls.deleteRule(rule.id), () => { toast({ tone: "info", title: OUTCOME_WORDS.ruleDeleted.title }); if (opened === rule.id) view.set({ open: null }); });
  const toggleEscalation = (rule: EscalationRule) => run(`esc:${rule.id}`, () => (rule.enabled ? notificationCalls.turnEscalationOff(rule.id) : notificationCalls.turnEscalationOn(rule.id)), () => toast({ tone: rule.enabled ? "info" : "success", title: (rule.enabled ? OUTCOME_WORDS.escalationOff : OUTCOME_WORDS.escalationOn).title }));

  async function testMany(ids: string[]) {
    const targets = ids.map((id) => channelById.get(id)).filter((channel): channel is Channel => Boolean(channel?.enabled));
    setBusy("test:many"); setError(null);
    let sent = 0;
    try {
      for (const channel of targets) {
        const result = await notificationCalls.testChannel(channel.id);
        if (result.ok) {
          sent += 1;
          const delivery = (result.payload?.delivery ?? null) as Partial<Delivery> | null;
          if (delivery?.id) setQueued((current) => [{ ...(delivery as Delivery), channel_kind: channel.kind, created_at: delivery.created_at ?? now }, ...current]);
        }
      }
      toast({ tone: sent ? "info" : "warning", title: sent ? `${sent} test ${sent === 1 ? "alert" : "alerts"} queued` : "No test was queued", detail: sent < targets.length ? `${targets.length - sent} could not be queued.` : undefined, href: href({ tab: "sent", open: null, add: null, status: null, channel: null }), hrefLabel: "Show under Sent" });
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function deleteMany(ids: string[]) {
    setBusy("delete:many"); setError(null);
    let removed = 0;
    try {
      for (const id of ids) if ((await notificationCalls.deleteRule(id)).ok) removed += 1;
      toast({ tone: "info", title: `${removed} ${removed === 1 ? "rule" : "rules"} deleted`, detail: removed < ids.length ? `${ids.length - removed} could not be deleted.` : undefined });
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  function exportCsv(ids: string[]) {
    const rows = allDeliveries.filter((delivery) => ids.includes(delivery.id));
    const lines = [["When", "What", "Sent to", "Outcome", "Tries", "Problem"].join(",")];
    for (const delivery of rows) {
      const channel = channelById.get(delivery.channel_id);
      lines.push(csvLine([deliveryTime(delivery) ?? "", deliveryTitle(delivery), channel ? channelName(channel) : channelKindLabel(delivery.channel_kind), deliveryBadge(delivery).label, delivery.attempts, deliveryProblem(delivery)?.sentence ?? ""], { always: true }));
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url; link.download = `keel-sent-alerts-${now.slice(0, 10)}.csv`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
    toast({ tone: "success", title: `${rows.length} ${rows.length === 1 ? "send" : "sends"} exported` });
  }

  // Tiles: each sets the tab (and the status filter) in the address.
  const clear = { open: null, add: null, status: null, channel: null, group: null, q: null, closed: null };
  const tiles: { key: string; label: string; icon: IconName; value: string; of?: string; small: string; changes: Record<string, string | null>; tone?: "urgent" | "soon"; active: boolean }[] = [
    { key: "channels", label: "Channels on", icon: "bell", value: String(counts.channelsOn), of: counts.channelsTotal !== counts.channelsOn ? `of ${counts.channelsTotal}` : undefined, small: counts.channelsTotal === 0 ? "None set up yet" : counts.offNames.length === 0 ? "All of them are on" : counts.offNames.length === 1 ? `${counts.offNames[0]} is turned off` : `${counts.offNames.length} are turned off`, changes: { ...clear, tab: null }, tone: counts.channelsTotal > 0 && counts.channelsOn === 0 ? "urgent" : undefined, active: tab === "channels" },
    { key: "rules", label: "Rules", icon: "filter", value: String(counts.rules), small: counts.escalationsOn ? `Plus ${counts.escalationsOn === 1 ? "1 rule" : `${counts.escalationsOn} rules`} for when nobody responds` : "None for when nobody responds", changes: { ...clear, tab: "rules" }, tone: counts.rules === 0 && counts.channelsTotal > 0 ? "soon" : undefined, active: tab === "rules" },
    { key: "sent", label: "Sent in 24 h", icon: "swap", value: String(counts.sentDay), small: "Each bar is 3 hours", changes: { ...clear, tab: "sent" }, active: tab === "sent" && !statusFilter.length },
    { key: "failed", label: "Failed", icon: "x-circle", value: String(counts.failedDay), small: counts.failedDay === 0 ? "Nothing failed in 24 hours" : counts.failingNames.length === 1 ? `${counts.failedDay === 1 ? "To" : "All to"} ${counts.failingNames[0]}` : `To ${counts.failingNames.length} channels`, changes: { ...clear, tab: "sent", channel: channelFilter || null, status: tab === "sent" ? tileParam(STATUS_TILES, statusFilter, "failed") : "failed" }, tone: counts.failedDay ? "urgent" : undefined, active: tab === "sent" && statusFilter.includes("failed") },
  ];
  const shownTiles = canConfiguration ? tiles : tiles.slice(2);

  // What opened: a channel, a rule, an escalation rule, or a form.
  const openChannel = opened ? channelById.get(opened) ?? null : null;
  const openRule = opened ? subscriptions.find((rule) => rule.id === opened) ?? null : null;
  const openEscalation = opened ? escalationRules.find((rule) => rule.id === opened) ?? null : null;
  const verdictChannel = verdict.channelId ? channelById.get(verdict.channelId) ?? null : null;
  const verdictAction = !canConfiguration || opened || adding ? null
    : verdict.action === "test" && verdictChannel ? { label: `Send test to ${channelName(verdictChannel)}`, onClick: () => void sendTest(verdictChannel), busy: busy === `test:${verdictChannel.id}` }
    : verdict.action === "add-channel" ? { label: "Add channel", href: href({ ...clear, tab: null, add: "channel" }) }
    : verdict.action === "add-rule" ? { label: "Add rule", href: href({ ...clear, tab: "rules", add: "rule" }) }
    : verdict.action === "turn-on" && verdictChannel ? { label: `Turn ${channelName(verdictChannel)} back on`, onClick: () => void turnOn(verdictChannel), busy: busy === `on:${verdictChannel.id}` }
    : null;

  const channelGroupings = useMemo<Grouping<Channel>[]>(() => [
    { key: "health", label: "Health", groupsOf: (items) => groupBy(items, (item) => health.get(item.id)?.state ?? "untested", (key) => ({ label: HEALTH_WORDS[key as keyof typeof HEALTH_WORDS].plural, icon: HEALTH_WORDS[key as keyof typeof HEALTH_WORDS].icon, about: HEALTH_WORDS[key as keyof typeof HEALTH_WORDS].about }), (key) => HEALTH_ORDER.indexOf(key as never)) },
    { key: "kind", label: "Kind", groupsOf: (items) => groupBy(items, (item) => item.kind, (key) => ({ label: channelKindLabel(key), icon: channelIcon(key), about: channelKind(key) ? CHANNEL_KINDS[key as ChannelKind].about : undefined }), (key) => CHANNEL_KIND_ORDER.indexOf(key as never)) },
  ], [health]);

  const ruleGroupings = useMemo<Grouping<Subscription>[]>(() => [
    { key: "to", label: "Send to", groupsOf: (items) => groupBy(items, (item) => item.channel_id, (key, list) => { const channel = channelById.get(key); return { label: channel ? channelName(channel) : "A channel that is no longer readable", icon: channel ? channelIcon(channel.kind) : "alert", about: `${list.length === 1 ? "1 rule" : `${list.length} rules`} send to it` }; }) },
    { key: "what", label: "Which alerts", groupsOf: (items) => groupBy(items, (item) => item.event_glob, (key) => ({ label: eventWords(key), icon: "filter" }), (key) => { const index = RULE_EVENTS.findIndex((event) => event.value === key); return index === -1 ? 99 : index; }) },
  ], [channelById]);

  const sentGroupings = useMemo<Grouping<Delivery>[]>(() => [
    { key: "day", label: "Day", groupsOf: (items) => groupBy(items, (item) => dayKey(deliveryTime(item)), (key, list) => ({ label: dayLabel(deliveryTime(list[0]), now), icon: "calendar", about: `${list.filter((item) => item.status === "failed").length || "no"} failed` }), (key) => -new Date(key === "unknown" ? 0 : key).valueOf()) },
    { key: "channel", label: "Channel", groupsOf: (items) => groupBy(items, (item) => item.channel_id, (key, list) => { const channel = channelById.get(key); return { label: channel ? channelName(channel) : channelKindLabel(list[0].channel_kind), icon: channelIcon(list[0].channel_kind) }; }) },
    { key: "status", label: "Outcome", groupsOf: (items) => groupBy(items, (item) => deliveryBadge(item).label, (key, list) => ({ label: key, icon: deliveryBadge(list[0]).icon }), (key) => ["Failed", "Trying again", "Waiting to send", "Sending", "Delivered", "Cancelled"].indexOf(key)) },
  ], [channelById, now]);

  const sentShown = useMemo(() => {
    const sorted = [...allDeliveries].sort((a, b) => new Date(deliveryTime(b) ?? 0).valueOf() - new Date(deliveryTime(a) ?? 0).valueOf());
    return applyFilters(sorted, STATUS_TILES, statusKey ? statusKey.split(",") : [], channelFilter ? [(delivery: Delivery) => delivery.channel_id === channelFilter] : []);
  }, [allDeliveries, statusKey, channelFilter]);
  const filterChannel = channelFilter ? channelById.get(channelFilter) ?? null : null;
  const sentFilters: ActiveFilter[] = [
    ...statusFilter.map((key) => ({ key: `status:${key}`, label: STATUS_CHIPS.find((chip) => chip.value === key)?.label ?? key, clear: { status: withoutTile(statusFilter, key) } })),
    ...(channelFilter ? [{ key: "channel", label: `To ${filterChannel ? channelName(filterChannel) : "one channel"}`, clear: { channel: null } }] : []),
  ];

  const renderChannel = (channel: Channel) => {
    const state = health.get(channel.id) ?? channelHealth(channel, allDeliveries, now);
    const name = channelName(channel);
    const isBusy = busy === `test:${channel.id}` || busy === `off:${channel.id}` || busy === `on:${channel.id}`;
    return (
      <div className="nf-row" data-state={state.state}>
        <span aria-hidden="true" className="nf-kind" data-tone={state.tone === "neutral" || state.tone === "fine" ? (state.tone === "fine" ? "fine" : undefined) : state.tone}><Icon name={channelIcon(channel.kind)} /></span>
        <span className="nf-row-name">
          <Link className="nf-row-link" href={href({ open: channel.id, add: null })} onClick={(event) => openPanel(event, channel.id)}>{name}</Link>
          <small>{channelAbout(channel)}</small>
        </span>
        <span className="nf-row-mid">
          <Badge icon={state.badge.icon} tone={state.badge.tone}>{state.badge.label}</Badge>
          <span className="nf-row-line">{state.line}</span>
        </span>
        {canConfiguration ? (
          <span className="nf-row-acts">
            {channel.enabled ? <>
              <button aria-busy={busy === `test:${channel.id}` || undefined} className="btn btn-sm" disabled={isBusy} onClick={() => void sendTest(channel)} type="button">Send test</button>
              <ConfirmButton confirmLabel="Turn off" description={<p>Alerts sent to {name} stop at once, including critical ones. Its history is kept, and rules that use it stay set up.</p>} disabled={isBusy} onConfirm={() => void turnOff(channel)} size="sm" title={`Turn off ${name}?`}>Turn off</ConfirmButton>
            </> : (
              <button aria-busy={busy === `on:${channel.id}` || undefined} className="btn btn-sm" disabled={isBusy} onClick={() => void turnOn(channel)} type="button"><Icon name="refresh" />Turn back on</button>
            )}
          </span>
        ) : null}
      </div>
    );
  };

  const renderRule = (rule: Subscription) => {
    const channel = channelById.get(rule.channel_id) ?? null;
    const target = channel ? health.get(channel.id) : null;
    const isBusy = busy === `delete:${rule.id}`;
    return (
      <div className="nf-row">
        <span aria-hidden="true" className="nf-kind"><Icon name="filter" /></span>
        <span className="nf-row-name">
          <Link className="nf-row-link" href={href({ open: rule.id, add: null })} onClick={(event) => openPanel(event, rule.id)}>{eventWords(rule.event_glob)}</Link>
          <small>{severityWords(rule.min_severity)}</small>
        </span>
        <span className="nf-row-mid">
          <span className="nf-to">{channel ? <><Icon name={channelIcon(channel.kind)} />{channelName(channel)}</> : <><Icon name="alert" />A channel that is no longer readable</>}</span>
          <span className="nf-row-line">{!channel ? "Pick another channel" : !channel.enabled ? `${channelName(channel)} is turned off, so nothing is sent` : target?.state === "failing" ? `${channelName(channel)} is failing` : target?.state === "retrying" ? `${channelName(channel)} is being retried` : `Sends to ${channelName(channel)}`}</span>
        </span>
        <span className="nf-row-acts">
          <Link className="btn btn-sm" href={href({ open: rule.id, add: null })} onClick={(event) => openPanel(event, rule.id)}>Edit</Link>
          <ConfirmButton confirmLabel="Delete rule" description={<p>{eventWords(rule.event_glob)} ({severityWords(rule.min_severity).toLowerCase()}) will no longer be sent to {channel ? channelName(channel) : "this channel"}. Add the rule again to restore it.</p>} disabled={isBusy} onConfirm={() => void deleteRule(rule)} size="sm" title="Delete this rule?" tone="danger">Delete</ConfirmButton>
        </span>
      </div>
    );
  };

  const renderDelivery = (delivery: Delivery) => {
    const channel = channelById.get(delivery.channel_id) ?? null;
    const badge = deliveryBadge(delivery);
    const problem = deliveryProblem(delivery);
    const link = deliveryHref(delivery);
    const when = deliveryTime(delivery);
    const title = deliveryTitle(delivery);
    const to = channel ? channelName(channel) : channelKindLabel(delivery.channel_kind);
    const line = delivery.status === "delivered"
      ? `${delivery.attempts > 1 ? `Delivered after ${delivery.attempts} tries` : "Arrived on the first try"}${delivery.provider_receipt?.semantics && delivery.channel_kind === "sms" ? " · Twilio accepted it" : ""}`
      : delivery.status === "failed"
        ? `${delivery.attempts > 1 ? `Gave up after ${delivery.attempts} tries${problem ? ` · ${problem.sentence}` : ""}` : problem ? problem.sentence : "Refused"}`
        : `${delivery.attempts ? `After ${delivery.attempts} ${delivery.attempts === 1 ? "try" : "tries"}` : "Waiting to send"}${delivery.next_attempt_at ? ` · next try ${fromNowShort(delivery.next_attempt_at, now)}` : ""}`;
    return (
      <div className="nf-row nf-sent" data-state={badge.tone}>
        <span aria-hidden="true" className="nf-kind" data-tone={badge.tone === "fine" ? "fine" : badge.tone === "neutral" ? undefined : badge.tone}><Icon name={badge.icon} /></span>
        <span className="nf-row-name">
          <span className="nf-when"><time dateTime={when ?? undefined} title={formatTimestamp(when)}>{clockWords(when) || "—"}</time></span>
          {link ? <Link className="nf-row-link" href={link}>{title}</Link> : <span className="nf-row-text">{title}</span>}
          <small>{displayEnum("severity", delivery.event.severity)} · to {to}</small>
        </span>
        <span className="nf-row-mid">
          <Badge icon={badge.icon} tone={badge.tone}>{badge.label}</Badge>
          <span className="nf-row-line">{line}</span>
        </span>
      </div>
    );
  };

  const escalationRows = escalationRules.map((rule) => {
    const target = escalationTarget(rule, channels);
    const owner = escalationOwner(rule);
    const isBusy = busy === `esc:${rule.id}`;
    return (
      <li className="nf-plain-row" data-off={!rule.enabled || undefined} key={rule.id}>
        <div className="nf-row">
          <span aria-hidden="true" className="nf-kind" data-tone={rule.enabled ? (target ? "soon" : "urgent") : undefined}><Icon name="clock" /></span>
          <span className="nf-row-name">
            <Link className="nf-row-link" href={href({ open: rule.id, add: null })} onClick={(event) => openPanel(event, rule.id)}>{escalationTitle(rule)}</Link>
            <small>{target ? `Also send to ${channelName(target)}` : "No channel to send to"}</small>
          </span>
          <span className="nf-row-mid">
            {rule.enabled ? (target?.enabled ? <Badge tone="fine">On</Badge> : <Badge tone="urgent" icon="alert">{target ? "Its channel is off" : "No channel"}</Badge>) : <Badge tone="neutral" icon="pause">Turned off</Badge>}
            <span className="nf-row-line">{owner ? `Owner ${owner}` : "No owner named"}{rule.control ? ` · ${displayEnum("eventKind", rule.control) === rule.control ? rule.control : displayEnum("eventKind", rule.control)} checks only` : ""}</span>
          </span>
          <span className="nf-row-acts">
            <button aria-busy={isBusy || undefined} className="btn btn-sm" disabled={isBusy} onClick={() => void toggleEscalation(rule)} type="button">{rule.enabled ? "Turn off" : <><Icon name="refresh" />Turn back on</>}</button>
          </span>
        </div>
      </li>
    );
  });

  return (
    <div className="nf-page">
      <Verdict action={verdictAction} detail={verdict.detail} text={verdict.text} tone={verdict.tone} />
      <div data-layer="explanation">
        <section aria-label="Notifications at a glance" className="nf-tiles" data-count={shownTiles.length}>
          {shownTiles.map((tile) => (
            <Link aria-current={tile.active || undefined} className="nf-tile" data-tone={tile.tone} href={href(tile.changes)} key={tile.key} onClick={(event) => follow(event, tile.changes)} title={tile.key === "failed" ? (tile.active ? "Picked: click to remove it from the view" : "Click to add these to the view") : undefined}>
              <span className="nf-tile-label"><Icon name={tile.icon} />{tile.label}{tile.active && tile.key === "failed" ? <Icon className="tile-check" name="check" /> : null}</span>
              <b className="nf-tile-count">{tile.value}{tile.of ? <small className="nf-tile-of"> {tile.of}</small> : null}</b>
              {tile.key === "sent" ? <Spark buckets={counts.buckets} /> : null}
              <small>{tile.small}</small>
            </Link>
          ))}
        </section>

        {canConfiguration ? (
          <div className="nf-tabs">
            <Segmented label="Show" onChange={switchTab} options={TABS.map((option) => ({ ...option, label: `${option.label} · ${option.value === "channels" ? counts.channelsTotal : option.value === "rules" ? counts.rules + counts.escalationsOn : allDeliveries.length}` }))} value={tab} />
            <Segmented hideLabel label="Show (short)" onChange={switchTab} options={TABS.map((option) => ({ value: option.value, label: PHONE_TABS[option.value] }))} value={tab} />
            {tab === "channels" ? <Link className="btn nf-add" href={href({ ...clear, tab: null, add: "channel" })} onClick={(event) => follow(event, { add: "channel", open: null }, true)}><Icon name="plus" />Add channel</Link> : null}
            {tab === "rules" ? <span className="nf-add-group"><Link className="btn nf-add" href={href({ ...clear, tab: "rules", add: "rule" })} onClick={(event) => follow(event, { add: "rule", open: null }, true)}><Icon name="plus" />Add rule</Link><Link className="btn nf-add" href={href({ ...clear, tab: "rules", add: "escalation" })} onClick={(event) => follow(event, { add: "escalation", open: null }, true)}><Icon name="plus" />Add escalation</Link></span> : null}
          </div>
        ) : null}

        {error && !opened && !adding ? <p className="nf-error" role="alert"><Icon name="alert" />{error}</p> : null}

        {tab === "channels" ? (
          <section aria-labelledby="nf-channels-heading" className="nf-section">
            <h2 className="visually-hidden" id="nf-channels-heading">Where alerts go</h2>
            {channels.length ? (
              <SelectableList
                action={{ label: (count) => `Send test to ${count === 1 ? "1 channel" : `${count} channels`}`, detail: (count, ids) => { const off = ids.filter((id) => !channelById.get(id)?.enabled).length; return `Queues one test alert to each${off ? `; ${off === 1 ? "1 turned-off channel is" : `${off} turned-off channels are`} skipped` : ""}. Each shows under Sent.`; }, run: (ids) => void testMany(ids) }}
                getId={(item) => item.id}
                groupings={channelGroupings}
                items={ordered}
                label="Where alerts go"
                matches={(item, text) => `${channelName(item)} ${channelKindLabel(item.kind)} ${channelAbout(item)}`.toLowerCase().includes(text)}
                noun={{ one: "channel", many: "channels" }}
                renderRow={renderChannel}
                rowName={channelName}
                toneOf={(item) => { const tone = health.get(item.id)?.tone; return tone === "neutral" ? null : tone; }}
              />
            ) : (
              <div className="nf-empty">
                <p>No channel is set up, so alerts go nowhere.</p>
                <Link className="btn" href={href({ ...clear, add: "channel" })} onClick={(event) => follow(event, { add: "channel" }, true)}><Icon name="plus" />Add the first channel</Link>
              </div>
            )}
          </section>
        ) : tab === "rules" ? (
          <section aria-labelledby="nf-rules-heading" className="nf-section">
            <h2 className="visually-hidden" id="nf-rules-heading">Who gets which alerts</h2>
            {subscriptions.length ? (
              <SelectableList
                action={{ label: (count) => `Delete ${count === 1 ? "1 rule" : `${count} rules`}`, detail: () => "They stop sending at once. Alerts that no rule matches go nowhere.", run: (ids) => void deleteMany(ids) }}
                getId={(item) => item.id}
                groupings={ruleGroupings}
                items={subscriptions}
                label="Who gets which alerts"
                matches={(item, text) => { const channel = channelById.get(item.channel_id); return `${eventWords(item.event_glob)} ${severityWords(item.min_severity)} ${channel ? channelName(channel) : ""}`.toLowerCase().includes(text); }}
                noun={{ one: "rule", many: "rules" }}
                renderRow={renderRule}
                rowName={(item) => `${eventWords(item.event_glob)} to ${channelById.get(item.channel_id) ? channelName(channelById.get(item.channel_id) as Channel) : "an unreadable channel"}`}
                toneOf={(item) => { const channel = channelById.get(item.channel_id); if (!channel || !channel.enabled) return "soon"; return health.get(channel.id)?.state === "failing" ? "urgent" : null; }}
              />
            ) : (
              <div className="nf-empty">
                <p>{channels.length ? "No rule is set up, so no alert is sent anywhere." : "Add a channel first, then a rule that sends alerts to it."}</p>
                {channels.length ? <Link className="btn" href={href({ ...clear, tab: "rules", add: "rule" })} onClick={(event) => follow(event, { add: "rule" }, true)}><Icon name="plus" />Add the first rule</Link> : null}
              </div>
            )}
            <section aria-labelledby="nf-escalation-heading" className="nf-escalation">
              <div className="nf-sub-head">
                <h3 id="nf-escalation-heading">When nobody responds</h3>
                <span className="nf-sub-count">{escalationRules.length === 1 ? "1 rule" : `${escalationRules.length} rules`}</span>
              </div>
              <p className="nf-plain">If an alert is not acknowledged in time, Keel also sends it to another channel and names an owner.</p>
              {escalationRules.length ? <ul className="nf-plain-rows">{escalationRows}</ul> : <p className="nf-plain nf-muted">No escalation rule yet. Add one so a critical alert nobody acknowledges reaches someone else.</p>}
            </section>
          </section>
        ) : (
          <section aria-labelledby="nf-sent-heading" className="nf-section">
            <h2 className="visually-hidden" id="nf-sent-heading">Sent</h2>
            <div className="nf-filters">
              <div className="picker-field">
                <span className="picker-label" id="nf-status-label">Outcome</span>
                <div aria-labelledby="nf-status-label" className="nf-chips" role="group">
                  <button aria-pressed={!statusFilter.length} className="nf-chip" onClick={() => view.set({ status: null })} type="button">All</button>
                  {STATUS_CHIPS.map((chip) => <button aria-pressed={statusFilter.includes(chip.value)} className="nf-chip" key={chip.value} onClick={() => view.set({ status: tileParam(STATUS_TILES, statusFilter, chip.value) })} type="button">{chip.label}</button>)}
                </div>
              </div>
            </div>
            <ActiveFilters extra={{ open: null }} filters={sentFilters} noun={{ one: "send", many: "sends" }} shown={sentShown.length} total={allDeliveries.length} />
            {allDeliveries.length ? (
              <SelectableList
                action={{ label: (count) => `Export ${count === 1 ? "1 send" : `${count} sends`}`, detail: () => "A spreadsheet file of these sends: when, what, where to, and the outcome.", run: exportCsv }}
                empty={sentFilters.length ? <NoMatches extra={{ open: null }} filters={sentFilters} noun={{ one: "send", many: "sends" }} /> : undefined}
                getId={(item) => item.id}
                groupings={sentGroupings}
                items={sentShown}
                label="Sent"
                matches={(item, text) => { const channel = channelById.get(item.channel_id); return `${deliveryTitle(item)} ${channel ? channelName(channel) : channelKindLabel(item.channel_kind)} ${deliveryBadge(item).label}`.toLowerCase().includes(text); }}
                noun={{ one: "send", many: "sends" }}
                partial={deliveryLimit && deliveries.length >= deliveryLimit ? `Only the newest ${deliveryLimit} sends are loaded. Older ones are left out.` : null}
                renderRow={renderDelivery}
                rowName={(item) => `${deliveryTitle(item)} at ${clockWords(deliveryTime(item))}`}
                sorts={SENT_SORTS}
                toneOf={(item) => { const tone = deliveryBadge(item).tone; return tone === "urgent" ? "urgent" : tone === "soon" ? "soon" : null; }}
              />
            ) : (
              <p className="sel-empty">No alert has been sent yet.{canConfiguration && channels.some((channel) => channel.enabled) ? " Send a test from a channel to prove it works." : ""}</p>
            )}
          </section>
        )}

        <TechnicalDetails summary="Technical details for channels, rules and sends">
          {channels.map((channel) => (
            <RecordGroup key={channel.id} note={`channel · ${channel.kind}`} title={channelName(channel)}>
              <ChannelRecordFields channel={channel} />
            </RecordGroup>
          ))}
          {subscriptions.map((rule) => {
            const channel = channels.find((item) => item.id === rule.channel_id) ?? null;
            return (
              <RecordGroup key={rule.id} note="alert rule" title={ruleSentence(rule, channel)}>
                <RecordField label="Subscription ID" value={rule.id} />
                <RecordField label="Channel ID" usage={channel ? channelName(channel) : "channel no longer exists"} value={rule.channel_id} />
                <RecordField copy={false} label="Event pattern" value={rule.event_glob} />
                <RecordField copy={false} label="Minimum severity" value={rule.min_severity} />
                <RecordField copy={false} label="Created" value={rule.created_at} />
              </RecordGroup>
            );
          })}
          {escalationRules.map((rule) => (
            <RecordGroup key={rule.id} note="escalation rule" title={escalationTitle(rule)}>
              <EscalationRecordFields rule={rule} />
            </RecordGroup>
          ))}
          {allDeliveries.map((delivery) => (
            <RecordGroup key={delivery.id} note={`send · ${delivery.channel_kind} · ${delivery.status}`} title={deliveryTitle(delivery)}>
              <RecordField label="Delivery ID" value={delivery.id} />
              <RecordField label="Channel ID" value={delivery.channel_id} />
              <RecordField copy={false} label="Status" value={delivery.status} />
              <RecordField copy={false} label="Attempts" value={delivery.attempts} />
              <RecordField copy={false} label="Event kind" value={delivery.event.kind} />
              <RecordField copy={false} label="Severity" value={delivery.event.severity} />
              {delivery.event.alertId ? <RecordField label="Alert ID" value={delivery.event.alertId} /> : null}
              <RecordField copy={false} label="Queued" value={delivery.created_at} />
              {delivery.delivered_at ? <RecordField copy={false} label="Delivered" value={delivery.delivered_at} /> : null}
              {delivery.next_attempt_at ? <RecordField copy={false} label="Next attempt" value={delivery.next_attempt_at} /> : null}
              {delivery.last_error ? <RecordField label="Last error" value={delivery.last_error} /> : null}
              <RecordField label="Event" value={delivery.event as RecordValue} />
              {delivery.provider_receipt ? <RecordField label="Provider reply" value={delivery.provider_receipt as RecordValue} /> : null}
            </RecordGroup>
          ))}
        </TechnicalDetails>
      </div>

      {openChannel || openRule || openEscalation || adding ? <BaselinesStyles /> : null}
      {openChannel ? (
        <ChannelPanel
          busy={busy}
          channel={openChannel}
          deliveries={allDeliveries}
          error={error}
          health={health.get(openChannel.id) ?? channelHealth(openChannel, allDeliveries, now)}
          href={href}
          now={now}
          onClose={closePanel}
          onTest={() => void sendTest(openChannel)}
          onTurnOff={() => void turnOff(openChannel)}
          onTurnOn={() => void turnOn(openChannel)}
          openPanel={openPanel}
          readOnly={!canConfiguration}
          rules={subscriptions.filter((rule) => rule.channel_id === openChannel.id)}
          switchTo={(changes) => { view.set(changes); }}
        />
      ) : null}
      {openRule ? (
        <RuleSheet
          busy={busy}
          channels={channels}
          error={error}
          onClose={closePanel}
          onDelete={() => void deleteRule(openRule)}
          onSave={(body) => run(`save:${openRule.id}`, () => notificationCalls.changeRule(openRule.id, body), () => { toast({ tone: "success", title: OUTCOME_WORDS.ruleChanged.title }); closePanel(); })}
          rule={openRule}
        />
      ) : null}
      {openEscalation ? (
        <DetailsSheet
          footer={canConfiguration ? <>
            <button aria-busy={busy === `esc:${openEscalation.id}` || undefined} className="btn" disabled={busy !== null} onClick={() => void toggleEscalation(openEscalation)} type="button">{openEscalation.enabled ? "Turn off" : "Turn back on"}</button>
            <p className="bl-help">Escalation rules are kept, never deleted, because an escalation that already happened points at its rule.</p>
          </> : undefined}
          kicker={<span>When nobody responds</span>}
          onClose={closePanel}
          title={escalationTitle(openEscalation)}
        >
          <EscalationBody channels={channels} rule={openEscalation} />
          {error ? <p className="nf-error" role="alert"><Icon name="alert" />{error}</p> : null}
        </DetailsSheet>
      ) : null}
      {adding === "channel" && canConfiguration ? (
        <ChannelSheet
          busy={busy}
          error={error}
          onClose={closePanel}
          onSave={async (kind, config, test) => {
            const ok = await run("add-channel", () => notificationCalls.addChannel(kind, config), (result) => {
              const channel = (result.payload?.channel ?? null) as Channel | null;
              toast({ tone: "success", title: OUTCOME_WORDS.channelAdded(channel ? channelName(channel) : channelKindLabel(kind)).title, detail: test ? "A test alert is on its way; it shows under Sent." : undefined });
              if (test && channel?.id) void notificationCalls.testChannel(channel.id).then(() => router.refresh());
            });
            if (ok) closePanel();
          }}
        />
      ) : null}
      {adding === "rule" && canConfiguration ? (
        <RuleSheet
          busy={busy}
          channels={channels}
          error={error}
          onClose={closePanel}
          onSave={async (body) => { const ok = await run("add-rule", () => notificationCalls.addRule(body), () => toast({ tone: "success", title: OUTCOME_WORDS.ruleAdded.title })); if (ok) closePanel(); }}
          rule={null}
        />
      ) : null}
      {adding === "escalation" && canConfiguration ? (
        <EscalationSheet
          busy={busy}
          channels={channels}
          error={error}
          onClose={closePanel}
          onSave={async (body) => { const ok = await run("add-escalation", () => notificationCalls.addEscalation(body), () => toast({ tone: "success", title: OUTCOME_WORDS.escalationAdded.title })); if (ok) closePanel(); }}
          people={people}
        />
      ) : null}
    </div>
  );
}

function ChannelRecordFields({ channel }: { channel: Channel }) {
  return <>
    <RecordField label="Channel ID" value={channel.id} />
    <RecordField copy={false} label="Kind" value={channel.kind} />
    <RecordField copy={false} label="State" value={channel.enabled ? "enabled" : "disabled"} />
    <RecordField label="Config" usage="secrets are never stored; a setting name points to where the server reads them" value={channel.config as RecordValue} />
    <RecordField copy={false} label="Created" value={channel.created_at} />
  </>;
}

function EscalationRecordFields({ rule }: { rule: EscalationRule }) {
  return <>
    <RecordField label="Escalation rule ID" value={rule.id} />
    <RecordField copy={false} label="State" value={rule.enabled ? "enabled" : "disabled"} />
    <RecordField copy={false} label="Minimum severity" value={rule.min_severity} />
    <RecordField copy={false} label="Acknowledge within (ms)" usage={durationWords(rule.ack_within_ms)} value={rule.ack_within_ms} />
    <RecordField copy={false} label="Control" value={rule.control ?? "any"} />
    <RecordField label="Escalates to channel ID" usage={rule.channel_kind ? `${rule.channel_kind}${rule.channel_enabled === false ? " · turned off" : ""}` : undefined} value={rule.escalate_channel_id} />
    <RecordField label="Owner (account ID)" usage={[rule.owner_name, rule.owner_email, rule.owner_disabled_at ? `disabled ${rule.owner_disabled_at}` : null].filter(Boolean).join(" · ") || undefined} value={rule.owner_principal_id} />
    <RecordField copy={false} label="Created" value={rule.created_at} />
  </>;
}

function fromNowShort(value: string, now: string): string {
  const milliseconds = new Date(value).valueOf() - new Date(now).valueOf();
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return "any moment";
  const minutes = Math.ceil(milliseconds / 60_000);
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  return `in ${hours} h`;
}

/** Eight bars, one per 3 hours of the last day, drawn to scale with a baseline. */
function Spark({ buckets }: { buckets: number[] }) {
  const max = Math.max(1, ...buckets);
  const width = 96;
  const height = 28;
  const gap = 3;
  const bar = (width - gap * (buckets.length - 1)) / buckets.length;
  return (
    <svg aria-label={`${buckets.reduce((sum, value) => sum + value, 0)} sent over the last 24 hours, in 3-hour steps`} className="nf-spark" role="img" viewBox={`0 0 ${width} ${height}`}>
      <line className="nf-spark-base" x1="0" x2={width} y1={height - 0.5} y2={height - 0.5} />
      {buckets.map((value, index) => {
        const h = value ? Math.max(2, (value / max) * (height - 4)) : 1;
        return <rect className="nf-spark-bar" data-empty={!value || undefined} height={h} key={index} rx="1" width={bar} x={index * (bar + gap)} y={height - 1 - h} />;
      })}
    </svg>
  );
}

function ChannelPanel({ channel, health, rules, deliveries, now, busy, error, readOnly, href, openPanel, switchTo, onClose, onTest, onTurnOff, onTurnOn }: {
  channel: Channel;
  health: ReturnType<typeof channelHealth>;
  rules: Subscription[];
  deliveries: Delivery[];
  now: string;
  busy: string | null;
  error: string | null;
  readOnly: boolean;
  href: (changes: Record<string, string | null>) => string;
  openPanel: (event: MouseEvent, id: string) => void;
  switchTo: (changes: Record<string, string | null>) => void;
  onClose: () => void;
  onTest: () => void;
  onTurnOff: () => void;
  onTurnOn: () => void;
}) {
  const name = channelName(channel);
  const own = deliveries.filter((delivery) => delivery.channel_id === channel.id).sort((a, b) => new Date(deliveryTime(b) ?? 0).valueOf() - new Date(deliveryTime(a) ?? 0).valueOf());
  const recent = own.slice(0, 5);
  const isBusy = busy !== null;
  const settingKey = channel.kind === "pagerduty" ? "routingKeyRef" : channel.kind === "sms" ? "authTokenRef" : "endpointRef";
  const setting = typeof channel.config?.[settingKey] === "string" && String(channel.config[settingKey]).startsWith("env:") ? String(channel.config[settingKey]).slice(4) : null;
  return (
    <DetailsSheet
      footer={!readOnly ? <>
        {channel.enabled ? <>
          <button aria-busy={busy === `test:${channel.id}` || undefined} className="btn btn-primary" disabled={isBusy} onClick={onTest} type="button"><Icon name="swap" />Send test</button>
          {health.state === "failing" ? <Link className="btn" href={href({ add: "channel", open: null })} onClick={(event) => { if (event.metaKey || event.ctrlKey) return; event.preventDefault(); switchTo({ add: "channel", open: null }); }}><Icon name="plus" />Add a new {channelKindLabel(channel.kind)} channel</Link> : null}
          <ConfirmButton confirmLabel="Turn off" description={<p>Alerts sent to {name} stop at once, including critical ones. Its history is kept, and rules that use it stay set up.</p>} disabled={isBusy} onConfirm={onTurnOff} title={`Turn off ${name}?`}><Icon name="pause" />Turn off</ConfirmButton>
          <p className="bl-help">A test alert goes only to this channel and shows under Sent. Turning off keeps its history; rules that use it stop sending until you pick another channel.</p>
        </> : <>
          <button aria-busy={busy === `on:${channel.id}` || undefined} className="btn btn-primary" disabled={isBusy} onClick={onTurnOn} type="button"><Icon name="refresh" />Turn back on</button>
          <p className="bl-help">Rules that send to it start sending again at once. Channels are never deleted, so what was sent stays on record.</p>
        </>}
      </> : undefined}
      kicker={<span className="nf-sheet-kicker"><Badge icon={health.badge.icon} tone={health.badge.tone}>{health.badge.label}</Badge><span>{channelKindLabel(channel.kind)}</span></span>}
      onClose={onClose}
      title={name}
    >
      <div className="nf-sheet">
        <p className="nf-plain">{channelSentence(channel)}</p>
        {health.problem ? (
          <ErrorNotice
            error={health.latest?.last_error ?? null}
            id="channel-error"
            title={health.problem.sentence}
            todo={health.problem.whatToDo}
            tone={health.state === "failing" ? "urgent" : "soon"}
          />
        ) : null}
        {error ? <p className="nf-error" role="alert"><Icon name="alert" />{error}</p> : null}
        <section className="nf-sheet-sect">
          <h3>Rules that use it</h3>
          {rules.length ? (
            <ul className="nf-links">
              {rules.map((rule) => <li key={rule.id}><Link href={href({ tab: "rules", open: rule.id, add: null })} onClick={(event) => { if (event.metaKey || event.ctrlKey) return; event.preventDefault(); switchTo({ tab: "rules", open: rule.id, add: null }); }}>{eventWords(rule.event_glob)} · {severityWords(rule.min_severity).toLowerCase()}</Link></li>)}
            </ul>
          ) : <p className="nf-plain nf-muted">No rule sends to it yet{readOnly ? "." : <>. <Link className="nf-inline-link" href={href({ tab: "rules", add: "rule", open: null })} onClick={(event) => { if (event.metaKey || event.ctrlKey) return; event.preventDefault(); switchTo({ tab: "rules", add: "rule", open: null }); }}>Add a rule</Link></>}</p>}
        </section>
        <section className="nf-sheet-sect">
          <h3>Recent sends</h3>
          {recent.length ? (
            <ul className="nf-mini">
              {recent.map((delivery) => {
                const badge = deliveryBadge(delivery);
                const when = deliveryTime(delivery);
                return (
                  <li key={delivery.id}>
                    <span className="nf-mini-main"><Icon name={badge.icon} /><time dateTime={when ?? undefined} title={formatTimestamp(when)}>{when ? `${dayLabel(when, now) === "Today" ? "" : `${dayLabel(when, now)} `}${clockWords(when)}` : "Unknown time"}</time> · {deliveryTitle(delivery)}</span>
                    <span className="nf-mini-state" data-tone={badge.tone}>{badge.label}</span>
                  </li>
                );
              })}
            </ul>
          ) : <p className="nf-plain nf-muted">Nothing has been sent through it yet.</p>}
          {own.length ? <Link className="nf-inline-link" href={href({ tab: "sent", channel: channel.id, open: null, add: null, status: null })} onClick={(event) => { if (event.metaKey || event.ctrlKey) return; event.preventDefault(); switchTo({ tab: "sent", channel: channel.id, open: null, add: null, status: null }); }}>All sends to {name}</Link> : null}
        </section>
        {setting ? <p className="nf-plain nf-muted">Its secret is read from the server setting <code>{setting}</code> each time Keel sends; Keel never stores the value.</p> : null}
        <TechnicalDetails>
          <ChannelRecordFields channel={channel} />
          {health.latest ? <RecordField label="Last send ID" value={health.latest.id} /> : null}
          {health.latest?.last_error ? <RecordField label="Last error" value={health.latest.last_error} /> : null}
          {health.latest?.provider_receipt ? <RecordField label="Last provider reply" value={health.latest.provider_receipt as RecordValue} /> : null}
        </TechnicalDetails>
      </div>
    </DetailsSheet>
  );
}

function fieldText(form: FormData, key: string): string {
  return String(form.get(key) ?? "").trim();
}

const KIND_OPTIONS: ChoiceOption<ChannelKind>[] = CHANNEL_KIND_ORDER.map((kind) => ({ value: kind, label: CHANNEL_KINDS[kind].label, icon: CHANNEL_KINDS[kind].icon, hint: CHANNEL_KINDS[kind].about }));

function ChannelSheet({ busy, error, onClose, onSave }: {
  busy: string | null;
  error: string | null;
  onClose: () => void;
  onSave: (kind: ChannelKind, config: Record<string, string>, test: boolean) => void;
}) {
  const [kind, setKind] = useState<ChannelKind>("email");
  const [test, setTest] = useState(true);
  const settingHelp = "The name of a setting on the Keel server that holds the secret address or key, written as env:KEEL_INTEGRATION_NAME (only names that start with KEEL_INTEGRATION_ are read). Ask whoever runs the server to add it. Keel keeps the name only.";
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (key: string) => fieldText(form, key);
    const config: Record<string, string> = kind === "email"
      ? { to: text("to"), from: text("from"), ...(text("subject") ? { subject: text("subject") } : {}) }
      : kind === "teams" || kind === "slack" ? { endpointRef: text("endpointRef") }
      : kind === "pagerduty" ? { routingKeyRef: text("routingKeyRef"), region: text("region") || "us" }
      : kind === "sms" ? { provider: "twilio", accountSid: text("accountSid"), authTokenRef: text("authTokenRef"), from: text("from"), to: text("to") }
      : { url: text("url") };
    onSave(kind, config, test);
  }
  return (
    <DetailsSheet kicker={<span>Where alerts go</span>} onClose={onClose} title="Add a channel">
      <form className="nf-form" id="nf-add-channel" onSubmit={submit}>
        <fieldset disabled={busy !== null}>
          <OptionPicker label="Kind" onChange={setKind} options={KIND_OPTIONS} value={kind} />
          <p className="nf-plain nf-muted">{CHANNEL_KINDS[kind].help}</p>
          <div className="nf-fields">
            {kind === "teams" || kind === "slack" ? <>
              <label className="filter-field"><span>Server setting that holds the {kind === "teams" ? "workflow" : "Slack"} address</span><input autoComplete="off" name="endpointRef" pattern="env:KEEL_INTEGRATION_[A-Z0-9_]+" placeholder={kind === "teams" ? "env:KEEL_INTEGRATION_TEAMS_WEBHOOK" : "env:KEEL_INTEGRATION_SLACK_WEBHOOK"} required /></label>
              <p className="field-help">{settingHelp}{kind === "teams" ? " Use a Teams Workflows address; old Office 365 connector addresses are not supported." : ""}</p>
            </> : kind === "pagerduty" ? <>
              <label className="filter-field"><span>Server setting that holds the integration key</span><input autoComplete="off" name="routingKeyRef" pattern="env:KEEL_INTEGRATION_[A-Z0-9_]+" placeholder="env:KEEL_INTEGRATION_PAGERDUTY_KEY" required /></label>
              <p className="field-help">{settingHelp}</p>
              <label className="filter-field"><span>PagerDuty region</span><select defaultValue="us" name="region"><option value="us">United States</option><option value="eu">Europe</option></select></label>
            </> : kind === "sms" ? <>
              <label className="filter-field"><span>Twilio account SID</span><input autoComplete="off" name="accountSid" pattern="AC[0-9a-fA-F]{32}" required /></label>
              <label className="filter-field"><span>Server setting that holds the Twilio auth token</span><input autoComplete="off" name="authTokenRef" pattern="env:KEEL_INTEGRATION_[A-Z0-9_]+" placeholder="env:KEEL_INTEGRATION_TWILIO_TOKEN" required /></label>
              <p className="field-help">{settingHelp}</p>
              <label className="filter-field"><span>Send from</span><input autoComplete="off" name="from" placeholder="+15551230000" required type="tel" /></label>
              <label className="filter-field"><span>Send to</span><input autoComplete="off" name="to" placeholder="+15551239999" required type="tel" /></label>
            </> : kind === "email" ? <>
              <label className="filter-field"><span>Send to</span><input autoComplete="off" name="to" placeholder="secops@contoso.com" required type="email" /></label>
              <label className="filter-field"><span>Send from</span><input autoComplete="off" name="from" placeholder="keel@contoso.com" required type="email" /></label>
              <label className="filter-field"><span>Subject (optional)</span><input autoComplete="off" name="subject" /></label>
            </> : <>
              <label className="filter-field"><span>Web address</span><input autoComplete="off" name="url" placeholder="https://hooks.contoso.com/keel" required type="url" /></label>
              <p className="field-help">Keel posts each alert to this address as a message. It must answer within 10 seconds.</p>
            </>}
          </div>
          <label className="nf-check"><input checked={test} onChange={(event) => setTest(event.target.checked)} type="checkbox" /><span>Send a test after saving</span></label>
          {error ? <p className="nf-error" role="alert"><Icon name="alert" />{error}</p> : null}
          <div className="nf-form-actions">
            <button className="btn" onClick={onClose} type="button">Cancel</button>
            <button aria-busy={busy === "add-channel" || undefined} className="btn btn-primary" type="submit">Add channel</button>
          </div>
        </fieldset>
      </form>
    </DetailsSheet>
  );
}

function RuleSheet({ rule, channels, busy, error, onClose, onSave, onDelete }: {
  rule: Subscription | null;
  channels: Channel[];
  busy: string | null;
  error: string | null;
  onClose: () => void;
  onSave: (body: { channelId: string; eventGlob: string; minSeverity: string }) => void;
  onDelete?: () => void;
}) {
  const usable = channels.filter((channel) => channel.enabled || channel.id === rule?.channel_id);
  const [channelId, setChannelId] = useState<string | null>(rule?.channel_id ?? usable[0]?.id ?? null);
  const [eventGlob, setEventGlob] = useState(rule?.event_glob ?? "*");
  const [severity, setSeverity] = useState(rule?.min_severity ?? "warning");
  const channelOptions: ChoiceOption<string>[] = usable.map((channel) => ({ value: channel.id, label: channelName(channel), icon: channelIcon(channel.kind), hint: channel.enabled ? channelAbout(channel) : "Turned off" }));
  const eventOptions: ChoiceOption<string>[] = RULE_EVENTS.some((event) => event.value === eventGlob) ? RULE_EVENTS : [...RULE_EVENTS, { value: eventGlob, label: eventWords(eventGlob), hint: "Not an alert Keel sends today" }];
  const chosen = channels.find((channel) => channel.id === channelId) ?? null;
  const isBusy = busy !== null;
  return (
    <DetailsSheet
      footer={<>
        <button aria-busy={busy === "add-rule" || busy === `save:${rule?.id}` || undefined} className="btn btn-primary" disabled={isBusy || !channelId} form="nf-rule-form" type="submit">{rule ? "Save rule" : "Add rule"}</button>
        {rule && onDelete ? <ConfirmButton confirmLabel="Delete rule" description={<p>{eventWords(rule.event_glob)} will no longer be sent to {chosen ? channelName(chosen) : "this channel"}. Add the rule again to restore it.</p>} disabled={isBusy} onConfirm={onDelete} title="Delete this rule?" tone="danger">Delete</ConfirmButton> : null}
        <p className="bl-help">{chosen ? ruleSentence({ event_glob: eventGlob, min_severity: severity }, chosen) : "Pick a channel to send to."}{rule ? " Changes apply to the next alert." : ""}</p>
      </>}
      kicker={<span>Who gets which alerts</span>}
      onClose={onClose}
      title={rule ? "Edit rule" : "Add a rule"}
    >
      <form className="nf-form" id="nf-rule-form" onSubmit={(event) => { event.preventDefault(); if (channelId) onSave({ channelId, eventGlob, minSeverity: severity }); }}>
        <fieldset disabled={isBusy}>
          {usable.length ? <OptionPicker label="Send to" onChange={setChannelId} options={channelOptions} value={channelId} /> : <p className="nf-error" role="alert"><Icon name="alert" />No channel is on. Add or turn on a channel first.</p>}
          <OptionPicker label="Which alerts" onChange={setEventGlob} options={eventOptions} value={eventGlob} />
          <Segmented label="Rated at least" onChange={setSeverity} options={SEVERITIES} value={severity} />
          <p className="nf-plain nf-muted">{severity === "notice" ? "Every alert, whatever its severity." : severity === "warning" ? "Warning and critical alerts; notices are left out." : "Critical alerts only."}</p>
          {error ? <p className="nf-error" role="alert"><Icon name="alert" />{error}</p> : null}
        </fieldset>
      </form>
    </DetailsSheet>
  );
}

function EscalationBody({ rule, channels }: { rule: EscalationRule; channels: Channel[] }) {
  const target = escalationTarget(rule, channels);
  const owner = escalationOwner(rule);
  return (
    <div className="nf-sheet">
      <p className="nf-plain">{rule.min_severity === "notice" ? "Any alert" : rule.min_severity === "critical" ? "A critical alert" : "A warning or critical alert"} that nobody acknowledges within {durationWords(rule.ack_within_ms)} is {target ? `also sent to ${channelName(target)}` : "meant to be sent on, but no channel is set"}{owner ? `, and ${owner} is named as its owner` : ""}.</p>
      {!target ? <div className="nf-note" data-tone="urgent"><Icon name="alert" /><div><b>No channel to send to.</b><p>Turn this rule off and add one with a channel, so an escalation has somewhere to go.</p></div></div> : !target.enabled ? <div className="nf-note" data-tone="urgent"><Icon name="alert" /><div><b>{channelName(target)} is turned off.</b><p>Turn it back on, or add a rule with another channel.</p></div></div> : null}
      <TechnicalDetails>
        <EscalationRecordFields rule={rule} />
      </TechnicalDetails>
    </div>
  );
}

function EscalationSheet({ channels, people, busy, error, onClose, onSave }: {
  channels: Channel[];
  people: PersonChoice[];
  busy: string | null;
  error: string | null;
  onClose: () => void;
  onSave: (body: { minSeverity: string; ackWithinMs: number; channelId: string; ownerPrincipalId: string | null }) => void;
}) {
  const usable = channels.filter((channel) => channel.enabled);
  const [severity, setSeverity] = useState("critical");
  const [wait, setWait] = useState(WAIT_PRESETS[1].value);
  const [channelId, setChannelId] = useState<string | null>(usable[0]?.id ?? null);
  const [owner, setOwner] = useState<string | null>(null);
  const channelOptions: ChoiceOption<string>[] = usable.map((channel) => ({ value: channel.id, label: channelName(channel), icon: channelIcon(channel.kind), hint: channelAbout(channel) }));
  const peopleOptions: ChoiceOption<string>[] = [{ value: "", label: "No owner" }, ...people.map((person) => ({ value: person.id, label: personName(person), hint: person.email ?? undefined }))];
  const chosen = usable.find((channel) => channel.id === channelId) ?? null;
  const isBusy = busy !== null;
  return (
    <DetailsSheet
      footer={<>
        <button aria-busy={busy === "add-escalation" || undefined} className="btn btn-primary" disabled={isBusy || !channelId} form="nf-escalation-form" type="submit">Add escalation</button>
        <p className="bl-help">{chosen ? `If ${severity === "notice" ? "any alert" : severity === "critical" ? "a critical alert" : "a warning or critical alert"} is not acknowledged in ${durationWords(Number(wait))}, Keel also sends it to ${channelName(chosen)}.` : "Pick a channel to send to."}</p>
      </>}
      kicker={<span>When nobody responds</span>}
      onClose={onClose}
      title="Add an escalation rule"
    >
      <form className="nf-form" id="nf-escalation-form" onSubmit={(event) => { event.preventDefault(); if (channelId) onSave({ minSeverity: severity, ackWithinMs: Number(wait), channelId, ownerPrincipalId: owner || null }); }}>
        <fieldset disabled={isBusy}>
          <Segmented label="For alerts rated at least" onChange={setSeverity} options={SEVERITIES} value={severity} />
          <Segmented label="Not acknowledged within" onChange={setWait} options={WAIT_PRESETS} value={wait} />
          {usable.length ? <OptionPicker label="Also send to" onChange={setChannelId} options={channelOptions} value={channelId} /> : <p className="nf-error" role="alert"><Icon name="alert" />No channel is on. Add or turn on a channel first.</p>}
          {people.length ? <OptionPicker label="Owner (optional)" onChange={(value) => setOwner(value || null)} options={peopleOptions} value={owner ?? ""} /> : null}
          <p className="nf-plain nf-muted">The owner is named in the escalation so the people who receive it know who to call.</p>
          {error ? <p className="nf-error" role="alert"><Icon name="alert" />{error}</p> : null}
        </fieldset>
      </form>
    </DetailsSheet>
  );
}

function personName(person: PersonChoice): string {
  const name = person.name?.trim();
  if (name) return name;
  const local = (person.email ?? "").split("@")[0];
  const words = local.split(/[^A-Za-z]+/).filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1).toLowerCase());
  return words.join(" ") || "Someone";
}

function groupBy<T>(items: T[], key: (item: T) => string, meta: (key: string, list: T[]) => Omit<ListGroup<T>, "items" | "key">, rank?: (key: string) => number): ListGroup<T>[] {
  const map = new Map<string, T[]>();
  for (const item of items) map.set(key(item), [...(map.get(key(item)) ?? []), item]);
  const groups = [...map.entries()].map(([groupKey, list]) => ({ key: groupKey, ...meta(groupKey, list), items: list }));
  return rank ? groups.sort((a, b) => rank(a.key) - rank(b.key)) : orderGroups(groups, () => null);
}

