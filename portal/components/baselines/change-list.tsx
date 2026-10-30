"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";

import { ChangeDecision } from "@/components/baselines/change-decision";
import { ChangeFacts } from "@/components/baselines/change-facts";
import { DetailsSheet } from "@/components/baselines/details-sheet";
import { sheetStep } from "@/lib/sheet-step";
import { RiskChip } from "@/components/baselines/parts";
import { BaselinesStyles } from "@/components/baselines/styles";
import { ChangeAttributionPanel } from "@/components/change-attribution";
import { ChangeEvidencePanel } from "@/components/decision-workbook";
import { DriftDiff } from "@/components/drift-diff";
import { WorkloadRestore } from "@/components/restore/workload-restore";
import { type ListSort } from "@/components/list/list-paging";
import { ActiveFilters, NoMatches, type ActiveFilter } from "@/components/list/active-filters";
import { SelectableList, type Grouping, type ListGroup } from "@/components/list/selectable-list";
import { SemanticDiff } from "@/components/semantic-diff";
import { Icon } from "@/components/shell/icons";
import { RecordField, TechnicalDetails } from "@/components/technical-details";
import {
  changedBy, decisionWords, impactTone, impactWords, itemKindName, itemService, kindLine, plainKind, setupName, typeService, whyItMatters, type Decision,
} from "@/lib/baselines-view";
import { alertCall, alertCallWords } from "@/lib/alert-calls";
import { changeLabel, changeName, isWaiting, respondDetail, respondResult, REVIEW_WORDS, reviewState } from "@/lib/changes-view";
import { backupPointWords } from "@/lib/restore-workloads-view";
import { workloadLabel } from "@/lib/compare-view";
import { toDay } from "@/lib/date-range";
import { driftActionControls } from "@/lib/drift-actions";
import { changeTiles, SERVICES_TILE, tileParams } from "@/lib/change-tiles";
import { applyFilters, pickedTiles, tileCounts, toggleTile } from "@/lib/filter-set";
import { worstTone, type RiskTone } from "@/lib/menu-status";
import { ago, BLAST_RADIUS_ORDER, brandCase, formatTimestamp } from "@/lib/presentation";
import { typeName } from "@/lib/protect-view";
import { byRisk, byText, byTime } from "@/lib/paging";
import { orderGroups, smartOrder } from "@/lib/selection";
import { serviceFor, serviceOrder } from "@/lib/services";
import { itemKind, kindParts } from "@/lib/type-groups";
import { toast } from "@/lib/toast";
import type { BaselineRecord, DriftRecord, SemanticSummary } from "@/lib/types";
import { readList, useViewState } from "@/lib/use-view-state";

const toneOf = (item: DriftRecord): RiskTone => impactTone(item.blastRadius);

const listWords = (names: string[]): string => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

function ordered(items: DriftRecord[]): DriftRecord[] {
  return smartOrder(items, toneOf, (item) => item.detectedAt);
}

function groupBy(items: DriftRecord[], key: (item: DriftRecord) => string, meta: (key: string, items: DriftRecord[]) => Omit<ListGroup<DriftRecord>, "items" | "key">, rank?: (key: string) => number): ListGroup<DriftRecord>[] {
  const map = new Map<string, DriftRecord[]>();
  for (const item of items) map.set(key(item), [...(map.get(key(item)) ?? []), item]);
  const groups = [...map.entries()].map(([groupKey, list]) => ({ key: groupKey, ...meta(groupKey, list), items: ordered(list) }));
  return rank ? groups.sort((a, b) => rank(a.key) - rank(b.key)) : orderGroups(groups, (group) => worstTone(group.items.map(toneOf)));
}

const RISK_ABOUT: Record<string, string> = {
  "tenant-lockout": "A wrong value here can lock admins or everyone out",
  "access-affecting": "Changes who can sign in or reach apps and data",
  cosmetic: "Names, labels and descriptions: nobody gains or loses access",
};

// Order by: when it was found, risk, and name.
const SORTS: ListSort<DriftRecord>[] = [
  { key: "found", label: "When found", desc: true, compare: (a, b) => byTime(a.detectedAt, b.detectedAt) },
  { key: "risk", label: "Risk", desc: true, compare: (a, b) => byRisk(toneOf(a), toneOf(b)) },
  { key: "name", label: "Name", compare: (a, b) => byText(changeName(a), changeName(b)) },
];
const changeText = (item: DriftRecord) => `${changeName(item)} ${itemKindName(item)} ${plainKind(item.resourceType)} ${typeName(item.resourceType)} ${changedBy(item) ?? ""}`.toLowerCase();

const GROUPINGS: Grouping<DriftRecord>[] = [
  {
    key: "service", label: "Service",
    // Inside a service, changes sit under their kind (users, groups, memberships, roles,
    // then policies and settings); inside a kind, the most serious first.
    groupsOf: (items) => groupBy(items, (item) => itemService(item).code, (code) => {
      const service = serviceFor(code);
      return { label: service.name, icon: service.icon, about: service.about };
    }).map((group) => {
      const parts = kindParts(group.items, itemKind, group.key);
      return { ...group, items: parts.flatMap((part) => part.items), parts };
    }),
  },
  {
    key: "risk", label: "Risk",
    groupsOf: (items) => groupBy(items, (item) => item.blastRadius, (radius) => ({
      label: impactWords(radius), icon: radius === "cosmetic" ? "info" : "alert", about: RISK_ABOUT[radius],
    }), (radius) => { const index = BLAST_RADIUS_ORDER.indexOf(radius); return index === -1 ? 99 : index; }),
  },
  {
    key: "kind", label: "Kind",
    groupsOf: (items) => groupBy(items, itemKind, (type, list) => ({
      label: plainKind(type), icon: typeService(type).icon, about: `${typeService(type).name} · ${list.length === 1 ? "1 change" : `${list.length} changes`}`,
    })),
  },
  {
    key: "who", label: "Who",
    groupsOf: (items) => groupBy(items, (item) => changedBy(item) ?? "", (who) => ({
      label: who || "Not known yet", icon: "person", about: who ? "Named by the Microsoft audit log" : "The audit log did not name who made these",
    })),
  },
];

/** The Changes page body: count tiles by risk, the shared list grouped by service, a
 * details panel per change, and accept, ignore or undo on the chosen changes. Service
 * setting changes (`serviceRead`) sit in the same list, so its filters and grouping
 * cover every service. Each service has its own approved setup: accepting adds the
 * change to it, and undo (one change at a time, where Keel can write the setting back)
 * runs the service restore: a check, then someone else's approval. They have no ignore;
 * acknowledging marks them seen. */
/** What the change list knows about an opened change beyond its comparison, added to the
 *  comparison's own Technical details so the sheet has one record. */
function OpenedRecord({ item }: { item: DriftRecord }) {
  if (!item.serviceRead) return <RecordField copy={false} label="Detected at" value={item.detectedAt} />;
  return (
    <>
      <RecordField label="Resource" value={item.serviceRead.resourceKey} />
      <RecordField label="Service change ID" value={item.id} />
      <RecordField copy={false} label="Service" value={item.serviceRead.workload} />
      <RecordField label="Service read ID" value={item.serviceRead.collectionId} />
      <RecordField copy={false} label="Compared with" value={item.serviceRead.comparedWith === "approved" ? "The approved setup" : "The read before it"} />
      <RecordField label={item.serviceRead.comparedWith === "approved" ? "Read holding the approved value" : "Compared with read"} value={item.serviceRead.previousCollectionId} />
      <RecordField label="Alert ID" value={item.serviceRead.alertId} />
      <RecordField copy={false} label="Seen at" value={item.detectedAt} />
    </>
  );
}

export function ChangeList({
  baseline,
  capabilities,
  items,
  now,
  scopeNote,
  summary,
}: {
  // Null when no setup is approved yet: the list then holds service setting changes only.
  baseline: BaselineRecord | null;
  capabilities: string[];
  items: DriftRecord[];
  now: string;
  // For a reader scoped to some entities: whose changes they see.
  scopeNote?: string | null;
  summary?: SemanticSummary;
}) {
  const view = useViewState();
  const pathname = usePathname() ?? "/drift";
  const params = useSearchParams();
  const router = useRouter();
  const [settled, setSettled] = useState<string[]>([]);
  // Service changes acknowledged here, shown as seen until the server read says so too.
  const [seen, setSeen] = useState<string[]>([]);
  // The service setting change being undone through its service restore.
  const [undoing, setUndoing] = useState<string | null>(null);
  const shownItems = useMemo(() => items.map((item) => (item.serviceRead && seen.includes(item.id) ? { ...item, serviceRead: { ...item.serviceRead, alertState: "acknowledged" } } : item)), [items, seen]);
  const itemsRef = useRef(items);
  useEffect(() => { if (itemsRef.current !== items) { itemsRef.current = items; setSeen([]); } }, [items]);
  const [deciding, setDeciding] = useState<{ decision: Decision; ids: string[] } | null>(null);
  const { canDispose, canRemediate } = driftActionControls(capabilities);
  const canRestore = capabilities.includes("restore");
  const canApprove = capabilities.includes("approve");

  const open = useMemo(() => shownItems.filter((item) => !settled.includes(item.id)), [shownItems, settled]);
  const service = view.get("service");
  const kind = view.get("kind");
  const query = view.get("q").trim().toLowerCase();
  const radii = BLAST_RADIUS_ORDER.filter((radius) => open.some((item) => item.blastRadius === radius));
  const tiles = useMemo(() => changeTiles(BLAST_RADIUS_ORDER), []);
  const picked = pickedTiles(tiles, [...readList(view.get("risk")), ...(view.get("from") === SERVICES_TILE ? [SERVICES_TILE] : [])]);
  const pickedKey = picked.join(",");
  // Filters other than the tiles: each one narrows (AND).
  const others = useMemo(() => [
    ...(service ? [(item: DriftRecord) => itemService(item).code === service] : []),
    ...(kind ? [(item: DriftRecord) => itemKind(item) === kind] : []),
    ...(query ? [(item: DriftRecord) => changeText(item).includes(query)] : []),
  ], [service, kind, query]);
  const shown = useMemo(() => applyFilters(open, tiles, pickedKey ? pickedKey.split(",") : [], others), [open, tiles, pickedKey, others]);
  const counts = useMemo(() => new Map(tileCounts(open, tiles, pickedKey ? pickedKey.split(",") : [], others).map((entry) => [entry.key, entry])), [open, tiles, pickedKey, others]);
  const opened = open.find((item) => item.id === view.get("open")) ?? null;
  // Previous and next in the panel follow the list as shown: its filters, grouping and sort.
  const [order, setOrder] = useState<string[]>([]);
  const step = useMemo(() => sheetStep(order, opened?.id), [order, opened?.id]);
  const deciding_items = deciding ? open.filter((item) => deciding.ids.includes(item.id)) : [];
  const undoingItem = undoing ? open.find((item) => item.id === undoing) ?? null : null;
  const serviceIds = useMemo(() => new Set(open.filter((item) => item.serviceRead).map((item) => item.id)), [open]);
  const decidable = (ids: string[]) => ids.filter((id) => !serviceIds.has(id));
  const serviceOnly = (ids: string[]) => ids.filter((id) => serviceIds.has(id));
  const allService = (ids: string[]) => ids.length > 0 && ids.every((id) => serviceIds.has(id));
  const skipped = (ids: string[]) => {
    const count = serviceOnly(ids).length;
    if (!count) return "";
    return ` ${count === 1 ? "1 service setting change is" : `${count} service setting changes are`} left out: undo ${count === 1 ? "it" : "each one"} from ${count === 1 ? "its" : "their"} details.`;
  };

  // Acknowledge service setting changes: one call per alert. A change that raised no
  // alert has nothing to answer.
  async function respond(action: "acknowledge", ids: string[], note?: string): Promise<string | null> {
    const chosen = open.filter((item) => ids.includes(item.id) && item.serviceRead);
    const answerable = chosen.filter((item) => item.serviceRead?.alertId);
    const results = await Promise.all(answerable.map(async (item) => ({ id: item.id, result: await alertCall(item.serviceRead!.alertId!, action, note) })));
    const done = results.filter((entry) => entry.result.ok).map((entry) => entry.id);
    const failed = results.filter((entry) => !entry.result.ok);
    const missing = chosen.length - answerable.length;
    if (!done.length && (failed.length || missing)) return failed.length ? alertCallWords(failed[0].result) : "These changes raised no alert, so there is nothing to answer.";
    if (action === "acknowledge") setSeen((current) => [...new Set([...current, ...done])]);
    else {
      setSettled((current) => [...new Set([...current, ...done])]);
      if (done.includes(view.get("open"))) view.set({ open: null });
    }
    toast({ tone: failed.length + missing ? "warning" : undefined, title: respondResult(action, done.length, failed.length + missing) });
    router.refresh();
    return null;
  }
  const acknowledge = (ids: string[]) => {
    const chosen = serviceOnly(ids).filter((id) => isWaiting(open.find((item) => item.id === id)!));
    if (!chosen.length) { toast({ tone: "info", title: "Nothing to acknowledge", detail: "Only service setting changes waiting for review can be acknowledged." }); return; }
    void respond("acknowledge", chosen).then((error) => { if (error) toast({ tone: "warning", title: "Could not acknowledge", detail: error }); });
  };

  const href = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params?.toString() ?? "");
    for (const [key, value] of Object.entries(changes)) if (value) next.set(key, value); else next.delete(key);
    const query = next.toString();
    return query ? `${pathname}?${query}` : pathname;
  };
  const follow = (event: MouseEvent, changes: Record<string, string | null>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    view.set(changes);
  };

  const notes = summary ? [
    summary.mismatched ? `${summary.mismatched} ${summary.mismatched === 1 ? "change could not be fully checked. Its details say why." : "changes could not be fully checked. Their details say why."}` : null,
    summary.unknownBefore ? `${summary.unknownBefore} ${summary.unknownBefore === 1 ? "change was" : "changes were"} not in the approved setup, so the earlier values are not known.` : null,
  ].filter((note): note is string => note !== null) : [];

  // Service setting changes are accepted with the rest. They have no ignore, and each
  // is undone on its own through its service restore.
  function decide(decision: Decision, ids: string[]) {
    if (decision === "undo" && ids.length === 1 && serviceIds.has(ids[0])) {
      const item = open.find((entry) => entry.id === ids[0]);
      if (item?.serviceRead?.undo.possible && canRestore) setUndoing(item.id);
      else view.set({ open: ids[0] });
      return;
    }
    const chosen = decision === "accept" ? ids : decidable(ids);
    if (chosen.length) setDeciding({ decision, ids: chosen });
    else if (ids.length) view.set({ open: ids[0] });
  }

  const primary = canDispose
    ? {
      label: (count: number) => decisionWords("accept", count).confirm,
      detail: (count: number) => `Adds ${count === 1 ? "it" : "them"} to the approved setup. Nothing in Microsoft 365 changes.`,
      run: (ids: string[]) => decide("accept", ids),
    }
    : canRemediate
      ? {
        label: (count: number) => decisionWords("undo", count).title,
        detail: (_count: number, ids: string[]) => `Puts the approved values back once someone else approves.${allService(ids) && ids.length === 1 ? "" : skipped(ids)}`,
        run: (ids: string[]) => decide("undo", ids),
      }
      : {
        label: (count: number) => (count === 1 ? "Open its details" : "Open the first one"),
        detail: () => "You can read these changes. Accepting or undoing them needs a role that can decide.",
        run: (ids: string[]) => view.set({ open: ids[0] }),
      };
  const more = [
    ...(canDispose && canRemediate ? [{ label: "Undo these changes…", run: (ids: string[]) => decide("undo", ids) }] : []),
    ...(canDispose ? [{ label: "Ignore for now…", run: (ids: string[]) => decide("ignore", ids) }] : []),
    ...(canDispose && serviceIds.size ? [{ label: "Acknowledge service setting changes", run: acknowledge }] : []),
  ];

  // Picks stay picked while tiles, services, kinds and the find change the view, so
  // someone can gather changes from several services and decide on them together.
  const keepPicks = useMemo(() => ({ pool: open, groupOf: (item: DriftRecord) => {
    const where = itemService(item);
    return { key: where.code, label: where.name, icon: where.icon, rank: serviceOrder(where.code) };
  } }), [open]);
  const waiting = open.filter((item) => item.serviceRead && isWaiting(item)).length;
  const tileLink = (key: string | null) => {
    const changes = { ...tileParams(key === null ? [] : toggleTile(tiles, picked, key)), open: null };
    return { href: href(changes), onClick: (event: MouseEvent) => follow(event, changes) };
  };
  const tileLabel = (key: string) => (key === SERVICES_TILE ? "Service settings" : impactWords(key));
  const activeFilters: ActiveFilter[] = [
    ...picked.map((key) => ({ key: `tile:${key}`, label: tileLabel(key), clear: tileParams(picked.filter((entry) => entry !== key)) })),
    ...(service ? [{ key: "service", label: `In ${serviceFor(service).name}`, clear: { service: null } }] : []),
    ...(kind ? [{ key: "kind", label: plainKind(kind), clear: { kind: null } }] : []),
    ...(query ? [{ key: "q", label: `Find: “${view.get("q").trim()}”`, clear: { q: null } }] : []),
  ];
  // What a tile says it would add, once another tile is picked.
  const addsWords = (key: string) => {
    const entry = counts.get(key);
    if (!picked.length || !entry || entry.picked) return null;
    return entry.adds ? `+${entry.adds} if added` : "Adds none";
  };
  const serviceReads = [...new Set(open.flatMap((item) => (item.serviceRead ? [itemService(item).name] : [])))];
  return (
    <div className="bl-page">
      <BaselinesStyles />
      <section aria-label="Open changes by risk" className="bl-tiles">
        {radii.map((radius) => {
          const active = picked.includes(radius);
          const adds = addsWords(radius);
          return (
            <Link aria-current={active || undefined} className="bl-card bl-tile bl-link" data-tone={impactTone(radius)} key={radius} title={active ? "Picked: click to remove it from the view" : "Click to add these to the view"} {...tileLink(radius)}>
              <span className="bl-tile-label"><Icon name={radius === "cosmetic" ? "info" : "alert"} />{impactWords(radius)}{active ? <Icon className="bl-tile-check" name="check" /> : null}</span>
              <b className="bl-tile-count">{counts.get(radius)?.count ?? 0}</b>
              <small>{RISK_ABOUT[radius]}</small>
              {adds ? <small className="bl-tile-adds">{adds}</small> : null}
            </Link>
          );
        })}
        <Link aria-current={!picked.length || undefined} className="bl-card bl-tile bl-link" {...tileLink(null)}>
          <span className="bl-tile-label"><Icon name="baselines" />All open changes</span>
          <b className="bl-tile-count">{applyFilters(open, tiles, [], others).length}</b>
          <small>{baseline && !serviceReads.length ? "Everything that differs from the approved setup" : "Everything waiting for review"}</small>
        </Link>
        {serviceIds.size ? (
          <Link aria-current={picked.includes(SERVICES_TILE) || undefined} className="bl-card bl-tile bl-link" data-tone={waiting ? "soon" : undefined} title={picked.includes(SERVICES_TILE) ? "Picked: click to remove it from the view" : "Click to add these to the view"} {...tileLink(SERVICES_TILE)}>
            <span className="bl-tile-label"><Icon name="cloud" />Service settings{picked.includes(SERVICES_TILE) ? <Icon className="bl-tile-check" name="check" /> : null}</span>
            <b className="bl-tile-count">{counts.get(SERVICES_TILE)?.count ?? 0}</b>
            <small>{waiting === serviceIds.size ? "Waiting for review" : waiting ? `${waiting} waiting for review; ${serviceIds.size - waiting} seen` : "All seen; accept or undo them"}</small>
            {addsWords(SERVICES_TILE) ? <small className="bl-tile-adds">{addsWords(SERVICES_TILE)}</small> : null}
          </Link>
        ) : null}
      </section>

      <div className="bl-context">
        {scopeNote ? <p className="bl-note"><Icon name="info" /><span>{scopeNote}</span></p> : null}
        {baseline ? (
          <p>
            <Icon name="baselines" />
            <span>Measured against <Link href="/baselines">{setupName(baseline)}</Link>, approved <time dateTime={baseline.setAt} title={formatTimestamp(baseline.setAt)}>{ago(baseline.setAt, now)}</time>.</span>
          </p>
        ) : null}
        <p>
          <Icon name="refresh" />
          <span>Checked after every backup. <Link href="/protect">Run a backup now</Link></span>
        </p>
        {serviceReads.length ? (
          <p className="bl-note">
            <Icon name="info" />
            <span>{`${listWords(serviceReads)} ${serviceReads.length === 1 ? "is" : "are"} measured against ${serviceReads.length === 1 ? "its" : "their"} own approved setup, taken from Keel's first read. Accept keeps a change; undo puts the approved value back once someone else approves.`}</span>
          </p>
        ) : null}
        {notes.map((note) => <p className="bl-note" key={note}><Icon name="info" /><span>{note}</span></p>)}
      </div>

      <ActiveFilters extra={{ open: null }} filters={activeFilters} noun={{ one: "change", many: "changes" }} shown={shown.length} total={open.length} />

      <section aria-labelledby="open-drift-heading" className="bl-section">
        <h2 className="visually-hidden" id="open-drift-heading">Open changes</h2>
        {open.length ? (
          <SelectableList
            onOrder={setOrder}
            action={primary}
            empty={<NoMatches extra={{ open: null }} filters={activeFilters} noun={{ one: "change", many: "changes" }} />}
            getId={(item) => item.id}
            groupings={GROUPINGS}
            items={shown}
            keepPicks={keepPicks}
            label="Open changes"
            matches={(item, text) => changeText(item).includes(text.trim())}
            more={more}
            sorts={SORTS}
            noun={{ one: "change", many: "changes" }}
            renderRow={(item) => {
              const who = changedBy(item);
              const state = reviewState(item);
              return (
                <div className="bl-row">
                  <span aria-hidden="true" className="bl-kind-icon" data-tone={toneOf(item)}><Icon name={itemService(item).icon} /></span>
                  <span className="bl-row-name">
                    <Link className="bl-row-link" href={href({ open: item.id })} onClick={(event) => follow(event, { open: item.id })}>{changeName(item)}</Link>
                    <small>{kindLine(item)}</small>
                  </span>
                  <RiskChip tone={toneOf(item)}>{impactWords(item.blastRadius)}</RiskChip>
                  <span className="bl-row-who" data-state={state ?? undefined}>
                    {state || who ? <span>{state ? REVIEW_WORDS[state] : who}</span> : null}
                    <small><time dateTime={item.detectedAt} title={formatTimestamp(item.detectedAt)}>{ago(item.detectedAt, now)}</time></small>
                  </span>
                </div>
              );
            }}
            rowName={(item) => changeLabel(item)}
            toneOf={toneOf}
          />
        ) : (
          <div className="bl-card bl-empty">
            <span aria-hidden="true" className="bl-kind-icon" data-tone="fine"><Icon name="check" /></span>
            <div><h3>Nothing to review</h3><p>The tenant matches the approved setup. Keel checks again after the next backup.</p></div>
          </div>
        )}
        {open.length ? (
          <TechnicalDetails summary="Technical details: these changes">
            {open.map((item) => (
              <RecordField key={item.id} label={`${item.serviceRead ? "Service change ID" : "Drift ID"} · ${item.naturalKey}`} usage={`Natural key ${item.naturalKey}, detected ${item.detectedAt}`} value={item.id} />
            ))}
            {baseline ? <RecordField label="Baseline ID" usage={<code>GET /api/baselines</code>} value={baseline.id} /> : null}
          </TechnicalDetails>
        ) : null}
      </section>

      {opened && !deciding && !undoing ? (
        <DetailsSheet
          footer={opened.serviceRead ? (
            <>
              {canDispose ? <button className="btn btn-primary" onClick={() => decide("accept", [opened.id])} type="button">Accept this change</button> : null}
              {canRestore && opened.serviceRead.undo.possible ? <button className="btn" onClick={() => setUndoing(opened.id)} type="button">Undo this change</button> : null}
              {canDispose && isWaiting(opened) ? <button className="btn" onClick={() => acknowledge([opened.id])} type="button">Acknowledge</button> : null}
              {opened.serviceRead.alertId ? <Link className="btn" href={`/alerts?open=${encodeURIComponent(opened.serviceRead.alertId)}`}>Open its alert</Link> : null}
              {opened.serviceRead.undo.possible ? (
                <p className="bl-help">Accepting adds it to the approved setup for {workloadLabel(opened.serviceRead.workload)} and changes nothing in Microsoft 365. Undo first checks what it would put back, then needs someone else&apos;s approval.</p>
              ) : (
                <p className="bl-cannot" role="note"><RiskChip tone="soon">Keel cannot undo this</RiskChip><span>{opened.serviceRead.undo.reason}</span></p>
              )}
            </>
          ) : canDispose || canRemediate ? (
            <>
              {canDispose ? <button className="btn btn-primary" onClick={() => decide("accept", [opened.id])} type="button">Accept this change</button> : null}
              {canRemediate ? <button className="btn" onClick={() => decide("undo", [opened.id])} type="button">Undo this change</button> : null}
              {canDispose ? <button className="btn" onClick={() => decide("ignore", [opened.id])} type="button">Ignore for now</button> : null}
              <p className="bl-help">Accepting adds it to the approved setup and changes nothing in Microsoft 365. Undo first shows what it can put back, then needs someone else&apos;s approval.</p>
            </>
          ) : undefined}
          kicker={<><RiskChip tone={toneOf(opened)}>{impactWords(opened.blastRadius)}</RiskChip><span>{kindLine(opened)}</span></>}
          noun="change"
          onClose={() => view.set({ open: null })}
          onStep={(id) => view.set({ open: id })}
          step={step}
          title={changeName(opened)}
          wide
        >
          <ChangeFacts item={opened} now={now} />
          {opened.semantic
            ? <SemanticDiff change={opened.semantic} item={opened} key={opened.id} record={<OpenedRecord item={opened} />} />
            : <DriftDiff item={opened} key={opened.id} record={<OpenedRecord item={opened} />} />}
          <section className="bl-why" aria-label="Why it matters">
            <h3>Why it matters</h3>
            <p>{whyItMatters(opened.resourceType)}</p>
          </section>
          {opened.evidence !== undefined ? <ChangeEvidencePanel attribution={opened.attribution} evidence={opened.evidence} gap={opened.evidenceGap} now={now} /> : null}
          {opened.attribution !== undefined ? <ChangeAttributionPanel attribution={opened.attribution} now={now} /> : null}
        </DetailsSheet>
      ) : null}


      {undoingItem?.serviceRead ? (
        <DetailsSheet
          kicker={<><RiskChip tone={toneOf(undoingItem)}>{impactWords(undoingItem.blastRadius)}</RiskChip><span>{changeName(undoingItem)}</span></>}
          onClose={() => setUndoing(null)}
          title="Undo this change"
          wide
        >
          <p className="bl-help">Keel puts back the {undoingItem.serviceRead.comparedWith === "approved" ? "approved value" : "value from before the change"}, from the read of {backupPointWords(undoingItem.serviceRead.previousReadAt ?? null)}. It checks what would change first and writes nothing until someone else approves. The next read then matches and settles this change.</p>
          <WorkloadRestore
            canApprove={canApprove}
            canRestore={canRestore}
            name={workloadLabel(undoingItem.serviceRead.workload)}
            now={now}
            onClose={() => setUndoing(null)}
            start={{ collectionId: undoingItem.serviceRead.previousCollectionId, targets: [undoingItem.serviceRead.resourceKey] }}
            workload={undoingItem.serviceRead.workload}
          />
        </DetailsSheet>
      ) : null}

      {deciding && deciding_items.length ? (
        <DetailsSheet
          kicker={<span>{deciding_items.length === 1 ? changeName(deciding_items[0]) : `${deciding_items.length} changes`}</span>}
          onClose={() => setDeciding(null)}
          title={decisionWords(deciding.decision, deciding_items.length).title}
        >
          <ChangeDecision
            decision={deciding.decision}
            items={deciding_items}
            onCancel={() => setDeciding(null)}
            onDone={(done, message) => {
              setSettled((current) => [...new Set([...current, ...done])]);
              setDeciding(null);
              if (done.length) view.set({ open: null });
              toast(done.length ? { title: message } : { tone: "info", title: "Sent to approvers", detail: "Nothing changes until one of them approves.", href: "/approvals", hrefLabel: "Open approvals" });
            }}
            today={toDay(new Date(now))}
          />
        </DetailsSheet>
      ) : null}
    </div>
  );
}
