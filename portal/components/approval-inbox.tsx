"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";

import { ActiveFilters, NoMatches, type ActiveFilter } from "@/components/list/active-filters";
import { type ListSort } from "@/components/list/list-paging";
import { SelectableList, type Grouping, type ListGroup } from "@/components/list/selectable-list";
import { byTime } from "@/lib/paging";
import { Segmented } from "@/components/pickers/segmented";
import { Icon } from "@/components/shell/icons";
import { RecordField, RecordGroup, ReferenceFields, TechnicalDetails, type RecordValue } from "@/components/technical-details";
import { displayAccount, refUsage } from "@/lib/record-refs";
import { Badge } from "@/components/ui/badge";
import { Person } from "@/components/ui/person";
import { Verdict } from "@/components/verdict";
import { decideRequest } from "@/lib/approval-decision";
import type { ApprovalPreview, ApprovalRequestRecord } from "@/lib/approval-inbox";
import {
  KIND_ORDER,
  KIND_WORDS,
  approvalCounts,
  approvalKind,
  approvalTitle,
  approvalsVerdict,
  approveOutcome,
  decisionError,
  expiringSoon,
  hoursLeft,
  impactBadge,
  outcomeBadge,
  peopleList,
  requestTone,
  sortWaiting,
  subjectLinks,
  timeLeft,
  type WaitingSort,
} from "@/lib/approval-view";
import { addsWords, applyFilters, tileCounts, type FilterTile } from "@/lib/filter-set";
import { ago, formatTimestamp } from "@/lib/presentation";
import { orderGroups } from "@/lib/selection";
import { personLabel } from "@/lib/sentences";
import { toast } from "@/lib/toast";
import { pushUrl } from "@/lib/url-history";
import { usePoll } from "@/lib/use-poll";
import { readList, useViewState } from "@/lib/use-view-state";

// Approvals (portal audit, pick B): one card per request, opened in place. Four tiles
// filter the list (`soon=`, `effects=`, `show=decided&week=`), the open request sits
// where it is in the list as a wide card with what will change, who asked and the
// decision along the bottom (`open=`, so Back closes it). Reject asks for its reason in
// the card; several requests can be rejected with one reason, Approve stays one at a
// time. Ids stay in one record under each list.

// Requests can also be ordered by when they were asked for and when they expire.
const REQUEST_SORTS: ListSort<ApprovalRequestRecord>[] = [
  { key: "asked", label: "When asked", desc: true, compare: (a, b) => byTime(a.createdAt, b.createdAt) },
  { key: "expires", label: "Expires", compare: (a, b) => byTime(a.expiresAt ?? "9999-12-31T00:00:00Z", b.expiresAt ?? "9999-12-31T00:00:00Z") },
];
const NOUN = { one: "request", many: "requests" };
// How a decided request ended. Several can be picked; they add up.
const OUTCOME_KEYS = ["approved", "rejected", "expired"];
const OUTCOME_LABELS: Record<string, string> = { approved: "Approved", rejected: "Rejected", expired: "Expired" };

/**
 * Q45: a restore whose dry run carries content effects needs a separate approval of
 * them, whether the dry run was made in the portal or with the command line.
 */
export function contentEffectsLink(request: ApprovalRequestRecord): { href: string; label: string; count: number } | null {
  const plan = request.references?.plan;
  if (request.action !== "restore" || !plan?.readable || !plan.contentEffects) return null;
  return {
    href: `/approvals/content-effects/${encodeURIComponent(plan.id)}`,
    label: "Review the content changes",
    count: plan.contentEffects,
  };
}

export function ContentEffectsNote({ request, primary = false }: { request: ApprovalRequestRecord; primary?: boolean }) {
  const link = contentEffectsLink(request);
  if (!link) return null;
  return (
    <div className="approval-content-effects ap-note" data-tone="soon">
      <Icon name="page" />
      <p>
        {link.count === 1
          ? "1 change in this restore affects kept or shared content. It needs its own approval"
          : `${link.count} changes in this restore affect kept or shared content. They need their own approval`}
        {" "}by someone other than the person who asked, or the restore is refused.
        {" "}<Link className={primary ? "btn btn-primary btn-sm" : "ap-inline-link"} href={link.href}>{link.label}</Link>
      </p>
    </div>
  );
}

function RequestRecordFields({ request }: { request: ApprovalRequestRecord }) {
  const people = request.references?.people ?? {};
  return (
    <RecordGroup note={`approval request · ${request.action} · ${request.status}`} title={approvalTitle(request)}>
      <RecordField label="Request ID" usage={<>use with <code>POST /api/approvals/&lt;id&gt;/approve</code></>} value={request.id} />
      <RecordField copy={false} label="Action code" value={request.action} />
      <RecordField copy={false} label="Status" value={request.status} />
      <RecordField copy={false} label="Carried out by" usage={request.executor === "cli" ? "an operator runs it with the command line" : "Keel queues the job once approved"} value={request.executor ?? "worker"} />
      <RecordField label="Requested by (account ID)" usage={refUsage(people.requested_by)} value={displayAccount(request.requestedBy, people.requested_by)} />
      {request.justification ? <RecordField copy={false} label="Why it was asked for" value={request.justification} /> : null}
      <RecordField copy={false} label="Approvals needed" value={request.requiredApprovals ?? 1} />
      {request.signoffs?.length ? request.signoffs.map((person, index) => (
        <RecordField key={person.id} label={`Sign-off ${index + 1} (account ID)`} usage={refUsage(person)} value={person.id} />
      )) : null}
      {request.decidedBy ? <RecordField label="Decided by (account ID)" usage={refUsage(people.decided_by)} value={request.decidedBy} /> : null}
      {request.reason ? <RecordField copy={false} label="Decision reason" value={request.reason} /> : null}
      <RecordField copy={false} label="Created" value={request.createdAt} />
      <RecordField copy={false} label="Expires" value={request.expiresAt} />
      {request.decidedAt ? <RecordField copy={false} label="Decided" value={request.decidedAt} /> : null}
      <RecordField label="Params" value={(request.params ?? {}) as RecordValue} />
      <ReferenceFields references={request.references} skipPeople={["requested_by", "decided_by"]} />
    </RecordGroup>
  );
}

/** "12 settings (Entra ID 9, Exchange Online 3)" */
function previewScope(preview: ApprovalPreview): string {
  const total = `${preview.total} ${preview.total === 1 ? "setting" : "settings"}`;
  if (preview.services.length <= 1) return preview.services[0] ? `${total} in ${preview.services[0].name}` : total;
  return `${total} (${preview.services.map((service) => `${service.name} ${service.count}`).join(", ")})`;
}

function WhatWillChange({ request, kindWord }: { request: ApprovalRequestRecord; kindWord: string }) {
  const preview = request.preview ?? null;
  const links = subjectLinks(request);
  const setup = request.references?.baseline;
  return (
    <section aria-label="What will change" className="ap-what">
      <h4>What will change{preview ? <span> · {previewScope(preview)}</span> : null}</h4>
      {preview ? (
        <ul className="ap-changes">
          {preview.changes.map((change) => (
            <li key={`${change.kind}:${change.name}`}>
              <span className="ap-change-name"><b>{change.name}</b><small>{change.kind}</small></span>
              {change.fields.length ? (
                <ul className="ap-fields">
                  {change.fields.map((field) => (
                    <li key={field.field}>
                      <span className="ap-field">{field.field}</span>
                      <span className="ap-values"><span className="ap-now">{field.now}</span><Icon name="chevron" /><span className="ap-after">{field.after}</span></span>
                    </li>
                  ))}
                  {change.moreFields ? <li className="ap-more-fields">{change.moreFields} more {change.moreFields === 1 ? "setting goes" : "settings go"} back too</li> : null}
                </ul>
              ) : <span className="ap-change-line">{change.line}</span>}
            </li>
          ))}
        </ul>
      ) : setup?.readable ? (
        <p className="ap-plain">Keel will check the tenant against “{setup.name ?? "this setup"}” from now on. Changes are counted from it, and undo changes put settings back as it holds them.</p>
      ) : (
        <p className="ap-plain">{request.references?.plan?.readable === false ? "The preview of this restore is no longer readable." : `Keel has no preview of ${kindWord} to show here.`}</p>
      )}
      {preview?.more ? <p className="ap-plain">{preview.more} more {preview.more === 1 ? "setting is" : "settings are"} in the full preview.</p> : null}
      {links.length ? (
        <p className="ap-links">
          {links.map((link) => <Link className="btn btn-sm" href={link.href} key={link.href}><Icon name={link.icon} />{link.label}</Link>)}
        </p>
      ) : null}
    </section>
  );
}

function Progress({ request, viewerId }: { request: ApprovalRequestRecord; viewerId: string | null }) {
  const required = request.requiredApprovals ?? 1;
  if (required <= 1) return null;
  const signed = request.signoffs ?? [];
  const mine = viewerId !== null && signed.some((person) => person.id === viewerId);
  const left = Math.max(0, required - signed.length);
  return (
    <div className="ap-progress">
      <div className="ap-progress-head">
        <b>Needs {required} approvals</b>
        <Badge icon={null} tone={signed.length >= required ? "fine" : "soon"}>{signed.length} of {required}</Badge>
      </div>
      <span aria-label={`${signed.length} of ${required} approvals recorded`} className="ap-meter" role="img"><i style={{ width: `${Math.min(100, (signed.length / required) * 100)}%` }} /></span>
      <ul className="ap-who-rows">
        {signed.map((person) => (
          <li key={person.id}><Person person={person} /><small><Icon name="check" />approved</small></li>
        ))}
        {left > 0 ? <li><span className="person"><span aria-hidden="true" className="person-avatar" data-initials="?" data-system="" /><span className="person-name">{mine ? "Another approver" : "You, or another approver"}</span></span><small>waiting</small></li> : null}
      </ul>
    </div>
  );
}

function RejectSheet({ count, noun, who, onCancel, onConfirm, busy }: {
  count: number;
  noun: string;
  who: string;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
  busy: boolean;
}) {
  const [reason, setReason] = useState("");
  const [touched, setTouched] = useState(false);
  const missing = reason.trim().length === 0;
  return (
    <div aria-label="Why reject" className="ap-reject" role="group">
      <b>Why reject {count === 1 ? `this ${noun}` : `these ${count} requests`}?</b>
      <label className="ap-reject-field" data-bad={touched && missing ? "" : undefined}>
        <span>Reason ({who} {count === 1 ? "sees" : "see"} it)</span>
        <textarea
          aria-describedby={touched && missing ? "ap-reject-error" : undefined}
          aria-invalid={touched && missing ? true : undefined}
          disabled={busy}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Why this should not happen"
          rows={2}
          value={reason}
        />
        {touched && missing ? <span className="ap-field-error" id="ap-reject-error" role="alert"><Icon name="alert" />Write a reason to reject.</span> : null}
      </label>
      <div className="ap-reject-actions">
        <button className="btn" disabled={busy} onClick={onCancel} type="button">Keep {count === 1 ? "it" : "them"} waiting</button>
        <button
          aria-busy={busy || undefined}
          className="btn btn-danger"
          disabled={busy}
          onClick={() => { setTouched(true); if (!missing) onConfirm(reason.trim()); }}
          type="button"
        >
          Reject {count === 1 ? "the request" : `${count} requests`}
        </button>
      </div>
    </div>
  );
}

type Busy = { id: string; decision: "approve" | "reject" } | null;

export function ApprovalInbox({
  pending,
  awaitingContentEffects = [],
  history,
  now = new Date().toISOString(),
  viewerId = null,
  notice = null,
}: {
  // A page-wide note shown under the verdict, such as "Names hidden".
  notice?: ReactNode;
  pending: ApprovalRequestRecord[];
  awaitingContentEffects?: ApprovalRequestRecord[];
  history: ApprovalRequestRecord[];
  now?: string;
  viewerId?: string | null;
}) {
  const router = useRouter();
  const view = useViewState();
  const pathname = usePathname() ?? "/approvals";
  const params = useSearchParams();
  const show = view.get("show") === "decided" ? "decided" : "waiting";
  const sort: WaitingSort = view.get("sort") === "newest" ? "newest" : "expiring";
  const soonOnly = view.get("soon") === "1";
  const effectsOnly = view.get("effects") === "1";
  const weekOnly = view.get("week") === "1";
  // Decided outcomes add up: `outcome=approved,expired` shows either.
  const outcomes = readList(view.get("outcome")).filter((value) => OUTCOME_KEYS.includes(value));
  const query = view.get("q").toLowerCase();
  const opened = view.get("open");

  const [busy, setBusy] = useState<Busy>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [bulk, setBulk] = useState<string[] | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const counts = useMemo(() => approvalCounts({ pending, awaitingContentEffects, history }, now), [pending, awaitingContentEffects, history, now]);
  const waiting = useMemo(() => sortWaiting([...pending, ...awaitingContentEffects], sort), [pending, awaitingContentEffects, sort]);
  // The two waiting tiles add up: Expiring soon and Waiting on content changes show either.
  const waitTiles = useMemo<FilterTile<ApprovalRequestRecord>[]>(() => [
    { key: "soon", test: (request) => expiringSoon(request, now) },
    { key: "effects", test: (request) => request.status !== "pending" },
  ], [now]);
  const waitPicked = [soonOnly ? "soon" : null, effectsOnly ? "effects" : null].filter((key): key is string => Boolean(key));
  const shown = useMemo(() => applyFilters(waiting, waitTiles, [...(soonOnly ? ["soon"] : []), ...(effectsOnly ? ["effects"] : [])]), [waiting, waitTiles, soonOnly, effectsOnly]);
  const waitCounts = new Map(tileCounts(waiting, waitTiles, waitPicked).map((entry) => [entry.key, entry]));
  const soonest = useMemo(() => sortWaiting(pending, "expiring")[0] ?? null, [pending]);
  const decided = useMemo(() => {
    const since = new Date(now).valueOf() - 7 * 24 * 3_600_000;
    return history.filter((request) => (!outcomes.length || outcomes.includes(request.status))
      && (!weekOnly || new Date(request.decidedAt ?? request.expiresAt ?? 0).valueOf() >= since)
      && (!query || matchText(request).includes(query)));
  }, [history, outcomes.join(","), weekOnly, query, now]); // eslint-disable-line react-hooks/exhaustive-deps

  // New requests appear without a reload: the page re-reads quietly, and a request that
  // was not on screen before is marked so it fades in.
  usePoll(() => router.refresh(), 5_000);
  const known = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  useLayoutEffect(() => {
    const ids = waiting.map((request) => request.id);
    const seen = known.current;
    if (seen) {
      const added = ids.filter((id) => !seen.has(id));
      if (added.length) setFresh(new Set(added));
    }
    known.current = new Set(ids);
  }, [waiting]);

  const href = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params?.toString() ?? "");
    for (const [key, value] of Object.entries(changes)) if (value) next.set(key, value); else next.delete(key);
    const text = next.toString();
    return text ? `${pathname}?${text}` : pathname;
  };
  // Filters replace the address; opening a request pushes it, so Back closes it.
  const follow = (event: MouseEvent, changes: Record<string, string | null>, push = false) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    if (push) pushUrl(href(changes));
    else view.set(changes);
  };
  const openRequest = (event: MouseEvent, id: string) => follow(event, { open: id }, true);
  const closeRequest = () => { setRejecting(null); view.set({ open: null }); };

  async function decide(request: ApprovalRequestRecord, decision: "approve" | "reject", reason = "") {
    setBusy({ id: request.id, decision });
    setErrors((current) => ({ ...current, [request.id]: "" }));
    try {
      const result = await decideRequest(request.id, decision, reason);
      if (!result.ok) {
        setErrors((current) => ({ ...current, [request.id]: decisionError(result.status, result.payload as { error?: string; handoff?: string } | null) }));
        if (result.status === 409 || result.status === 404) router.refresh();
        return;
      }
      if (decision === "approve") {
        const outcome = approveOutcome(request, (result.payload ?? {}) as Parameters<typeof approveOutcome>[1]);
        toast({ tone: outcome.pending ? "info" : "success", title: outcome.title, detail: outcome.detail, href: outcome.href, hrefLabel: outcome.hrefLabel });
      } else {
        toast({ tone: "info", title: "Request rejected", detail: approvalTitle(request) });
      }
      setRejecting(null);
      router.refresh();
    } catch {
      setErrors((current) => ({ ...current, [request.id]: decisionError(0, null) }));
    } finally {
      setBusy(null);
    }
  }

  async function rejectMany(ids: string[], reason: string) {
    const targets = pending.filter((request) => ids.includes(request.id));
    setBusy({ id: "bulk", decision: "reject" });
    const failed: string[] = [];
    try {
      for (const request of targets) {
        const result = await decideRequest(request.id, "reject", reason);
        if (!result.ok) failed.push(approvalTitle(request));
      }
      if (failed.length < targets.length) toast({ tone: "info", title: `${targets.length - failed.length} ${targets.length - failed.length === 1 ? "request" : "requests"} rejected`, detail: failed.length ? `${failed.length} could not be: ${failed.join("; ")}` : undefined });
      else toast({ tone: "warning", title: "Nothing was rejected", detail: "Keel could not record the decisions. The list will refresh." });
      setBulk(null);
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  const groupings = useMemo<Grouping<ApprovalRequestRecord>[]>(() => [
    {
      key: "kind", label: "Kind",
      groupsOf: (items) => groupBy(items, (item) => approvalKind(item), (key) => ({ label: KIND_WORDS[key as keyof typeof KIND_WORDS].plural, icon: KIND_WORDS[key as keyof typeof KIND_WORDS].icon, about: KIND_WORDS[key as keyof typeof KIND_WORDS].about }), (key) => KIND_ORDER.indexOf(key as never)),
    },
    {
      key: "who", label: "Who asked",
      groupsOf: (items) => groupBy(items, (item) => personLabel(item.references?.people.requested_by), (key, list) => ({ label: key, icon: "settings", about: `${list.length === 1 ? "1 request" : `${list.length} requests`} from them` })),
    },
    {
      key: "expires", label: "Expires",
      groupsOf: (items) => groupBy(items, (item) => expiryBucket(item, now), (key) => EXPIRY_BUCKETS[key as keyof typeof EXPIRY_BUCKETS], (key) => Object.keys(EXPIRY_BUCKETS).indexOf(key)),
    },
  ], [now]);

  const verdict = approvalsVerdict(counts, soonest, now);
  const waitFilters: ActiveFilter[] = [
    ...(soonOnly ? [{ key: "soon", label: "Expiring within 4 hours", clear: { soon: null } }] : []),
    ...(effectsOnly ? [{ key: "effects", label: "Waiting on content changes", clear: { effects: null } }] : []),
  ];
  const decidedFilters: ActiveFilter[] = [
    ...outcomes.map((value) => ({ key: `outcome:${value}`, label: OUTCOME_LABELS[value], clear: { outcome: outcomes.filter((entry) => entry !== value).join(",") || null } })),
    ...(weekOnly ? [{ key: "week", label: "Decided in the last 7 days", clear: { week: null } }] : []),
    ...(query ? [{ key: "q", label: `Find: “${view.get("q").trim()}”`, clear: { q: null } }] : []),
  ];
  const toggleOutcome = (value: string) => {
    const next = outcomes.includes(value) ? outcomes.filter((entry) => entry !== value) : [...outcomes, value];
    return OUTCOME_KEYS.filter((key) => next.includes(key)).join(",") || null;
  };

  const clear = { show: null, soon: null, effects: null, week: null, outcome: null, open: null };
  const tiles: { key: string; label: string; icon: "inbox" | "clock" | "page" | "check-circle"; value: string; small: string; changes: Record<string, string | null>; tone?: "urgent" | "soon"; active: boolean }[] = [
    { key: "waiting", label: "Waiting for you", icon: "inbox", value: String(counts.waiting), small: "Restores, undo changes and switches", changes: clear, active: show === "waiting" && !soonOnly && !effectsOnly },
    { key: "soon", label: "Expiring within 4 hours", icon: "clock", value: String(counts.expiringSoon), small: counts.expiringSoon ? "Decide, or they must be asked again" : "Nothing expires soon", changes: { show: null, week: null, outcome: null, open: null, soon: soonOnly ? null : "1" }, tone: counts.expiringSoon ? "urgent" : undefined, active: show === "waiting" && soonOnly },
    { key: "effects", label: "Waiting on content changes", icon: "page", value: String(counts.contentEffects), small: counts.contentEffects ? "Approved, but kept content changes too" : "No restore waits on content changes", changes: { show: null, week: null, outcome: null, open: null, effects: effectsOnly ? null : "1" }, tone: counts.contentEffects ? "soon" : undefined, active: show === "waiting" && effectsOnly },
    { key: "decided", label: "Decided this week", icon: "check-circle", value: String(counts.decidedThisWeek.approved + counts.decidedThisWeek.rejected + counts.decidedThisWeek.expired), small: `${counts.decidedThisWeek.approved} approved · ${counts.decidedThisWeek.rejected} rejected · ${counts.decidedThisWeek.expired} expired`, changes: { ...clear, show: "decided", week: weekOnly && show === "decided" ? null : "1" }, active: show === "decided" && weekOnly },
  ];

  const renderRequest = (request: ApprovalRequestRecord) => {
    const kind = approvalKind(request);
    const words = KIND_WORDS[kind];
    const isOpen = opened === request.id;
    const tone = requestTone(request, now);
    const impact = impactBadge(request);
    const awaitingEffects = request.status !== "pending";
    const asked = request.references?.people.requested_by;
    const mine = viewerId !== null && request.requestedBy === viewerId;
    const title = approvalTitle(request);
    const left = hoursLeft(request, now);
    const expiryTone = left !== null && left <= 4 ? "urgent" : "neutral";
    const required = request.requiredApprovals ?? 1;
    const signed = request.signoffs?.length ?? 0;
    const line = awaitingEffects
      ? `Approved by ${personLabel(request.references?.people.decided_by)}; waiting on content changes`
      : required > 1 ? `Needs ${required} approvals · ${signed} of ${required} recorded` : request.executor === "cli" ? "Planned from the command line" : words.about;
    const isBusy = busy?.id === request.id;
    const freshClass = fresh.has(request.id) ? " approval-new" : "";

    if (!isOpen) {
      return (
        <div className={`ap-row${freshClass}`} data-kind={kind}>
          <span aria-hidden="true" className="ap-kind" data-tone={tone === "fine" ? undefined : tone}><Icon name={words.icon} /></span>
          <span className="ap-row-name">
            <Link className="ap-row-link" href={href({ open: request.id })} onClick={(event) => openRequest(event, request.id)}>{title}</Link>
            <small>{words.label} · <Person person={asked} /> · {ago(request.createdAt, now)}</small>
          </span>
          <span className="ap-row-mid">
            {impact ? <Badge icon={impact.icon} tone={impact.tone}>{impact.label}</Badge> : awaitingEffects ? <Badge tone="soon" icon="page">Content changes</Badge> : kind === "setup" ? <Badge tone="low">Changes what counts as a change</Badge> : <Badge tone="neutral" icon={null}>{words.label}</Badge>}
            <span className="ap-row-line">{line}</span>
          </span>
          <span className="ap-row-acts">
            {!awaitingEffects ? <span className="ap-left" data-tone={expiryTone}>{timeLeft(request, now)}</span> : null}
            <Link aria-expanded={false} className="btn btn-sm" href={href({ open: request.id })} onClick={(event) => openRequest(event, request.id)}>Open</Link>
          </span>
        </div>
      );
    }

    const who = personLabel(asked);
    const help = mine
      ? "You asked for this, so someone else must decide it."
      : awaitingEffects
        ? "The restore is approved. It runs once its content changes are approved too."
        : required > 1 && signed + 1 >= required
          ? `Your approval is the last one, so ${words.verb} starts right away. Reject asks you why; ${who} sees the reason.`
          : required > 1
            ? `Your approval is recorded and ${required - signed - 1 === 1 ? "one more approver" : `${required - signed - 1} more approvers`} must agree before ${words.verb} starts. Reject asks you why; ${who} sees the reason.`
            : request.executor === "cli"
              ? `Approving starts nothing here: an operator runs ${words.verb} from the command line. Reject asks you why; ${who} sees the reason.`
              : `Nothing changes until you approve. Keel runs ${words.verb} right after. Reject asks you why; ${who} sees the reason.`;
    return (
      <article aria-label={title} className={`ap-card${freshClass}`} data-kind={kind}>
        <header className="ap-card-head">
          <span aria-hidden="true" className="ap-kind" data-tone={tone === "fine" ? undefined : tone}><Icon name={words.icon} /></span>
          <div className="ap-card-title">
            <h3>{title}</h3>
            <small>{words.label}{request.preview?.services.length ? ` · ${request.preview.services.map((service) => service.name).join(", ")}` : ""} · <Person person={asked} /> asked {ago(request.createdAt, now)}</small>
          </div>
          <div className="ap-card-badges">
            {impact ? <Badge icon={impact.icon} tone={impact.tone}>{impact.label}</Badge> : null}
            {awaitingEffects ? <Badge tone="soon" icon="page">Waiting on content changes</Badge> : <Badge icon="clock" tone={expiryTone === "urgent" ? "urgent" : "neutral"} title={`Expires ${formatTimestamp(request.expiresAt)}`}>Expires {timeLeft(request, now).replace(" left", "").replace(/^(\d+ (?:min|h|days?))$/, "in $1")}</Badge>}
          </div>
          <button aria-expanded className="icon-button ap-collapse" onClick={closeRequest} title="Collapse" type="button"><Icon name="up" /><span className="visually-hidden">Collapse</span></button>
        </header>
        <div className="ap-card-body">
          <WhatWillChange kindWord={words.verb} request={request} />
          <aside className="ap-who">
            <h4>Why</h4>
            {request.justification ? <blockquote className="ap-quote">“{request.justification}”</blockquote> : <p className="ap-plain">{who} gave no reason.</p>}
            <Progress request={request} viewerId={viewerId} />
            {awaitingEffects ? (
              <p className="ap-plain">Approved by <Person person={request.references?.people.decided_by} /> {ago(request.decidedAt, now)}.</p>
            ) : (
              <p className="ap-plain">Expires <time dateTime={request.expiresAt ?? undefined}>{formatTimestamp(request.expiresAt)}</time>. After that it has to be asked for again.</p>
            )}
            <ContentEffectsNote primary={awaitingEffects} request={request} />
          </aside>
        </div>
        {errors[request.id] ? <p className="ap-error" role="alert"><Icon name="alert" />{errors[request.id]}</p> : null}
        {!awaitingEffects ? (
          <footer className="ap-card-foot">
            <p className="ap-help">{help}</p>
            {!mine ? (
              <span className="ap-decide">
                <button
                  aria-busy={(isBusy && busy?.decision === "reject") || undefined}
                  aria-expanded={rejecting === request.id}
                  className="btn"
                  disabled={isBusy}
                  onClick={() => setRejecting((current) => (current === request.id ? null : request.id))}
                  type="button"
                >
                  <Icon name="x-circle" />Reject…
                </button>
                <button
                  aria-busy={(isBusy && busy?.decision === "approve") || undefined}
                  className="btn btn-primary"
                  disabled={isBusy}
                  onClick={() => void decide(request, "approve")}
                  type="button"
                >
                  <Icon name="check" />Approve
                </button>
              </span>
            ) : null}
          </footer>
        ) : null}
        {rejecting === request.id ? (
          <RejectSheet busy={isBusy} count={1} noun={words.label.toLowerCase()} onCancel={() => setRejecting(null)} onConfirm={(reason) => void decide(request, "reject", reason)} who={who} />
        ) : null}
      </article>
    );
  };

  return (
    <div className="ap-page">
      <Verdict
        action={show === "waiting" && !opened && soonest ? { label: counts.expiringSoon ? "Review the one expiring first" : "Review the oldest", href: href({ open: soonest.id }) } : null}
        detail={verdict.detail}
        text={verdict.text}
        tone={verdict.tone}
      />
      {notice}
      <div data-layer="explanation">
        <section aria-label="Requests by state" className="ap-tiles">
          {tiles.map((tile) => (
            <Link
              aria-current={tile.active || undefined}
              className="ap-tile"
              data-tone={tile.tone}
              href={href(tile.changes)}
              key={tile.key}
              onClick={(event) => follow(event, tile.changes)}
              title={tile.key === "soon" || tile.key === "effects" ? (tile.active ? "Picked: click to remove it from the view" : "Click to add these to the view") : undefined}
            >
              <span className="ap-tile-label"><Icon name={tile.icon} />{tile.label}{tile.active && (tile.key === "soon" || tile.key === "effects") ? <Icon className="tile-check" name="check" /> : null}</span>
              <b className="ap-tile-count">{tile.value}</b>
              {tile.key === "decided" ? <Meter counts={counts.decidedThisWeek} /> : null}
              <small>{tile.small}</small>
              {show === "waiting" && (tile.key === "soon" || tile.key === "effects") && addsWords(waitCounts.get(tile.key), waitPicked.length) ? <small className="tile-adds">{addsWords(waitCounts.get(tile.key), waitPicked.length)}</small> : null}
            </Link>
          ))}
        </section>

        <div className="ap-toolbar">
          <Segmented
            label="Show"
            onChange={(value) => view.set({ show: value, soon: null, effects: null, week: null, outcome: null, open: null, q: null }, { show: "waiting" })}
            options={[{ value: "waiting", label: `Waiting · ${counts.waiting}` }, { value: "decided", label: `Decided · ${history.length}` }]}
            value={show}
          />
          {show === "waiting" ? (
            <Segmented
              label="Sort"
              onChange={(value) => view.set({ sort: value }, { sort: "expiring" })}
              options={[{ value: "expiring", label: "Expiring soonest" }, { value: "newest", label: "Newest" }]}
              value={sort}
            />
          ) : (
            <div className="picker-field">
              <span className="picker-label" id="ap-outcome-label">Outcome</span>
              <div aria-labelledby="ap-outcome-label" className="ap-chips" role="group">
                <button aria-pressed={!outcomes.length} className="ap-chip" onClick={() => view.set({ outcome: null, open: null })} type="button">All</button>
                {OUTCOME_KEYS.map((value) => (
                  <button aria-pressed={outcomes.includes(value)} className="ap-chip" key={value} onClick={() => view.set({ outcome: toggleOutcome(value), open: null })} type="button">{OUTCOME_LABELS[value]}</button>
                ))}
              </div>
            </div>
          )}
        </div>

        {show === "waiting" ? (
          <section aria-labelledby="ap-waiting-heading" className="ap-section">
            <h2 className="visually-hidden" id="ap-waiting-heading">Waiting for a decision</h2>
            <ActiveFilters extra={{ open: null }} filters={waitFilters} noun={NOUN} shown={shown.length} total={waiting.length} />
            {bulk ? (
              <RejectSheet busy={busy?.id === "bulk"} count={bulk.length} noun="request" onCancel={() => setBulk(null)} onConfirm={(reason) => void rejectMany(bulk, reason)} who={peopleList(uniquePeople(pending.filter((request) => bulk.includes(request.id)))) || "The people who asked"} />
            ) : null}
            {waiting.length ? (
              <SelectableList
                action={{
                  label: (count) => `Reject ${count === 1 ? "1 request" : `${count} requests`}…`,
                  detail: (count, ids) => {
                    const effects = ids.filter((id) => awaitingContentEffects.some((request) => request.id === id)).length;
                    const base = count === 1 ? "Asks you why; the person who asked sees it." : "One reason for all of them; each person who asked sees it. Approve stays one request at a time.";
                    return effects ? `${base} ${effects === 1 ? "1 approved restore waiting on content changes" : `${effects} approved restores waiting on content changes`} cannot be rejected here.` : base;
                  },
                  run: (ids) => { const targets = ids.filter((id) => pending.some((request) => request.id === id)); if (targets.length) { setRejecting(null); setBulk(targets); } },
                }}
                empty={waitFilters.length ? <NoMatches extra={{ open: null }} filters={waitFilters} noun={NOUN} /> : undefined}
                getId={(item) => item.id}
                groupings={groupings}
                items={shown}
                label="Waiting for a decision"
                matches={(item, text) => matchText(item).includes(text)}
                noun={NOUN}
                renderRow={renderRequest}
                rowName={approvalTitle}
                sorts={REQUEST_SORTS}
                toneOf={(item) => requestTone(item, now)}
              />
            ) : (
              <p className="sel-empty">Nothing is waiting for a decision.</p>
            )}
          </section>
        ) : (
          <section aria-labelledby="ap-decided-heading" className="ap-section">
            <h2 className="visually-hidden" id="ap-decided-heading">Decided and expired</h2>
            <label className="picker-field ap-find">
              <span className="picker-label">Find</span>
              <span className="sel-find-box">
                <Icon name="search" />
                <input className="bare-input" onChange={(event) => view.set({ q: event.target.value })} placeholder="Find a request or a person" type="search" value={view.get("q")} />
              </span>
            </label>
            <ActiveFilters extra={{ open: null }} filters={decidedFilters} noun={NOUN} shown={decided.length} total={history.length} />
            {decided.length ? (
              <ul className="activity-list ap-history">
                {decided.map((request) => {
                  const kind = approvalKind(request);
                  const badge = outcomeBadge(request);
                  const isOpen = opened === request.id;
                  const links = subjectLinks(request);
                  return (
                    <li className="activity-item list-row ap-history-row" data-open={isOpen || undefined} key={request.id}>
                      <span aria-hidden="true" className="row-kind ap-kind"><Icon name={KIND_WORDS[kind].icon} /></span>
                      <span className="row-name">
                        <Link href={href({ open: isOpen ? null : request.id })} onClick={(event) => { if (isOpen) { event.preventDefault(); view.set({ open: null }); } else openRequest(event, request.id); }}>{approvalTitle(request)}</Link>
                        <small>{KIND_WORDS[kind].label} · asked by {personLabel(request.references?.people.requested_by)} {ago(request.createdAt, now)}</small>
                      </span>
                      <span className="row-mid">
                        <span className="row-status"><Badge icon={badge.icon} tone={badge.tone}>{badge.label}</Badge></span>
                        <span className="row-meta">
                          {request.status === "expired"
                            ? <>Expired <time dateTime={request.expiresAt ?? undefined} title={formatTimestamp(request.expiresAt)}>{ago(request.expiresAt, now)}</time> without a decision</>
                            : <>by {request.signoffs?.length && request.signoffs.length > 1 ? peopleList(request.signoffs) : personLabel(request.references?.people.decided_by)} <time dateTime={request.decidedAt ?? undefined} title={formatTimestamp(request.decidedAt)}>{ago(request.decidedAt, now)}</time></>}
                        </span>
                      </span>
                      {isOpen ? (
                        <div className="ap-history-detail">
                          {request.reason ? <blockquote className="ap-quote">“{request.reason}”</blockquote> : null}
                          {request.justification ? <p className="ap-plain">Asked for because: “{request.justification}”</p> : null}
                          {request.status === "approved" ? <ContentEffectsNote request={request} /> : null}
                          {links.length ? <p className="ap-links">{links.map((link) => <Link className="btn btn-sm" href={link.href} key={link.href}><Icon name={link.icon} />{link.label.replace("Open the full preview", kind === "restore" || kind === "undo" ? "Open the restore run" : link.label)}</Link>)}</p> : null}
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            ) : (
              history.length && decidedFilters.length ? <NoMatches extra={{ open: null }} filters={decidedFilters} noun={NOUN} /> : <p className="sel-empty">No request has been decided or has expired yet.</p>
            )}
          </section>
        )}
        <TechnicalDetails summary="Technical details for these requests">
          {[...waiting, ...history].map((request) => <RequestRecordFields key={request.id} request={request} />)}
        </TechnicalDetails>
      </div>
    </div>
  );
}

function Meter({ counts }: { counts: { approved: number; rejected: number; expired: number } }) {
  const total = counts.approved + counts.rejected + counts.expired;
  if (!total) return null;
  const percent = (part: number) => `${(part / total) * 100}%`;
  return (
    <span aria-label={`${counts.approved} approved, ${counts.rejected} rejected, ${counts.expired} expired`} className="ap-meter" role="img">
      <i data-tone="fine" style={{ width: percent(counts.approved) }} />
      <i data-tone="urgent" style={{ width: percent(counts.rejected) }} />
      <i data-tone="neutral" style={{ width: percent(counts.expired) }} />
    </span>
  );
}

function matchText(request: ApprovalRequestRecord): string {
  return `${approvalTitle(request)} ${KIND_WORDS[approvalKind(request)].label} ${personLabel(request.references?.people.requested_by)} ${personLabel(request.references?.people.decided_by, "")} ${request.justification ?? ""} ${request.reason ?? ""}`.toLowerCase();
}

function uniquePeople(requests: ApprovalRequestRecord[]) {
  const seen = new Map<string, NonNullable<ApprovalRequestRecord["references"]>["people"][string]>();
  for (const request of requests) {
    const person = request.references?.people.requested_by;
    if (person && !seen.has(person.id)) seen.set(person.id, person);
  }
  return [...seen.values()].filter((person): person is NonNullable<typeof person> => Boolean(person));
}

const EXPIRY_BUCKETS = {
  soon: { label: "Within 4 hours", icon: "alert" as const, about: "Decide now, or they must be asked again" },
  today: { label: "Today", icon: "clock" as const, about: "Within 24 hours" },
  later: { label: "Later", icon: "calendar" as const, about: "More than a day away" },
  none: { label: "Not expiring", icon: "info" as const, about: "Approved restores waiting on content changes" },
};

function expiryBucket(request: ApprovalRequestRecord, now: string): keyof typeof EXPIRY_BUCKETS {
  if (request.status !== "pending") return "none";
  const left = hoursLeft(request, now);
  if (left === null) return "none";
  if (left <= 4) return "soon";
  if (left <= 24) return "today";
  return "later";
}

function groupBy(
  items: ApprovalRequestRecord[],
  key: (item: ApprovalRequestRecord) => string,
  meta: (key: string, list: ApprovalRequestRecord[]) => Omit<ListGroup<ApprovalRequestRecord>, "items" | "key">,
  rank?: (key: string) => number,
): ListGroup<ApprovalRequestRecord>[] {
  const map = new Map<string, ApprovalRequestRecord[]>();
  for (const item of items) map.set(key(item), [...(map.get(key(item)) ?? []), item]);
  const groups = [...map.entries()].map(([groupKey, list]) => ({ key: groupKey, ...meta(groupKey, list), items: list }));
  return rank ? groups.sort((a, b) => rank(a.key) - rank(b.key)) : orderGroups(groups, () => null);
}

