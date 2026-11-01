"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo, useState, type MouseEvent, type ReactNode } from "react";

import { runWord, useBackup } from "@/components/backup-controls";
import { FailureLine } from "@/components/backup-failure";
import { DetailsSheet } from "@/components/baselines/details-sheet";
import { BaselinesStyles } from "@/components/baselines/styles";
import { coverageWindows, TypeDetails, TypeRecordFields } from "@/components/coverage-report";
import { type ListSort } from "@/components/list/list-paging";
import { ActiveFilters, NoMatches, type ActiveFilter } from "@/components/list/active-filters";
import { SelectableList, type Grouping, type ListGroup } from "@/components/list/selectable-list";
import { Icon, type IconName } from "@/components/shell/icons";
import { RecordField, RecordGroup, TechnicalDetails } from "@/components/technical-details";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Verdict } from "@/components/verdict";
import { typeInfo } from "../../engine/insights/taxonomy.mjs";
import { plainKind, typeService } from "@/lib/baselines-view";
import { worstTone, type RiskTone } from "@/lib/menu-status";
import { failureReason, needsRetry, retryPlan, type RetryPlan } from "@/lib/backup-failure";
import { addsWords, applyFilters, readPicked, tileCounts, tileParam, withoutTile, type FilterTile } from "@/lib/filter-set";
import { ago } from "@/lib/presentation";
import {
  HEALTH_BADGE,
  STANDING_LABEL,
  TIERS,
  backupHealth,
  backupPlan,
  backupPlanSentence,
  backupSentence,
  healthRisk,
  matchesHealth,
  coverageSentence,
  coverageSummary,
  protectCounts,
  protectScopeDetail,
  protectVerdict,
  protectVerdictDetail,
  restoreStanding,
  tierLabel,
  typeName,
  workloadLiveNote,
  activeRunSentence,
  type ActiveTierRuns,
  type BackupHealth,
  type HealthFilter,
  type HealthTile,
  type RestoreStanding,
} from "@/lib/protect-view";
import { byRisk, byText, byTime } from "@/lib/paging";
import { orderGroups, smartOrder } from "@/lib/selection";
import { serviceFor, serviceOrder } from "@/lib/services";
import { kindParts } from "@/lib/type-groups";
import type { CoverageData, CoverageType } from "@/lib/types";
import { pushUrl } from "@/lib/url-history";
import { useLiveSearchParams, useViewState } from "@/lib/use-view-state";
import { csvLine } from "@/lib/csv";

// What's protected (portal audit: one grouped list on a desktop, pick A; service cards
// first on a phone, pick B). Five tiles filter the list (`health=`), a phone's service
// card opens its kinds below (`service=`) or is ticked to back the whole service up, and
// every kind opens a details panel (`open=`, so Back closes it). Ids stay in one record
// under the list.

const NOUN = { one: "type", many: "types" };
const PROBLEM: BackupHealth[] = ["failed", "partial", "stale", "never"];

const serviceCode = (item: CoverageType) => typeService(item.type).code;
// Workload kinds (exchange-mail-flow, teams-org-policies…) are named by the taxonomy;
// directory types by the redesign's plain names.
const kindName = (item: CoverageType) => {
  const info = typeInfo(item.type);
  return item.type.includes("-") && info.known ? info.name : plainKind(item.type);
};

function ordered(items: CoverageType[]): CoverageType[] {
  // Failures first, then out of date or never, then by tier and name.
  return smartOrder(
    [...items].sort((a, b) => (a.criticality ?? "tier9").localeCompare(b.criticality ?? "tier9") || kindName(a).localeCompare(kindName(b))),
    (item) => healthRisk(item) ?? null,
    () => "",
  );
}

function groupBy(items: CoverageType[], key: (item: CoverageType) => string, meta: (key: string, list: CoverageType[]) => Omit<ListGroup<CoverageType>, "items" | "key">, rank?: (key: string) => number): ListGroup<CoverageType>[] {
  const map = new Map<string, CoverageType[]>();
  for (const item of items) map.set(key(item), [...(map.get(key(item)) ?? []), item]);
  const groups = [...map.entries()].map(([groupKey, list]) => ({ key: groupKey, ...meta(groupKey, list), items: ordered(list) }));
  return rank ? groups.sort((a, b) => rank(a.key) - rank(b.key)) : orderGroups(groups, (group) => worstTone(group.items.map((item) => healthRisk(item))));
}

const HEALTH_GROUPS: { key: string; label: string; icon: IconName; about: string; has: (health: BackupHealth) => boolean }[] = [
  { key: "failed", label: "Failed", icon: "x-circle", about: "The last backup did not finish", has: (health) => health === "failed" },
  { key: "partial", label: "Partly done", icon: "alert", about: "The last backup read only part of these, so some settings are missing", has: (health) => health === "partial" },
  { key: "out-of-date", label: "Out of date or never", icon: "clock", about: "Not backed up recently enough, or not yet", has: (health) => health === "stale" || health === "never" },
  { key: "backed-up", label: "Backed up", icon: "check-circle", about: "The last backup finished in time", has: (health) => health === "ok" || health === "empty" },
  { key: "not-backed-up", label: "Not backed up", icon: "info", about: "Keel cannot read these, or this tenant does not have them", has: (health) => health === "not-collected" || health === "unavailable" },
];

const STANDING_ORDER: RestoreStanding[] = ["cannot-restore", "unproven", "proven", "partial", "protected"];
const STANDING_ABOUT: Record<RestoreStanding, string> = {
  "cannot-restore": "Kept for reference, or not read yet",
  unproven: "No live test restore on this tenant yet",
  proven: "A live test restore on this tenant worked",
  partial: "Some fields come back by hand",
  protected: "A test restore brought everything back",
};

// Order by: name, health (worst first), last backup, and how many settings it holds.
const SORTS: ListSort<CoverageType>[] = [
  { key: "name", label: "Name", compare: (a, b) => byText(kindName(a), kindName(b)) },
  { key: "health", label: "Health", desc: true, compare: (a, b) => byRisk(healthRisk(a), healthRisk(b)) },
  { key: "backed-up", label: "Last backup", desc: true, compare: (a, b) => byTime(a.lastCollectedAt, b.lastCollectedAt) },
  { key: "items", label: "Settings", desc: true, compare: (a, b) => (a.itemCount ?? -1) - (b.itemCount ?? -1) },
];

const GROUPINGS: Grouping<CoverageType>[] = [
  {
    key: "service", label: "Service",
    // Inside a service, kinds sit under what they are: users, groups, roles, then
    // policies and tenant settings, in the taxonomy's order.
    groupsOf: (items) => groupBy(items, serviceCode, (code) => {
      const service = serviceFor(code);
      return { label: service.name, icon: service.icon, about: service.about };
    }).map((group) => {
      // Inside each kind group, failures and out-of-date kinds still come first.
      const parts = kindParts(group.items, (item) => item.type, group.key).map((part) => ({ ...part, items: ordered(part.items) }));
      return { ...group, items: parts.flatMap((part) => part.items), parts };
    }),
  },
  {
    key: "health", label: "Health",
    groupsOf: (items) => groupBy(items, (item) => HEALTH_GROUPS.find((group) => group.has(backupHealth(item)))!.key, (key) => {
      const group = HEALTH_GROUPS.find((entry) => entry.key === key)!;
      return { label: group.label, icon: group.icon, about: group.about };
    }, (key) => HEALTH_GROUPS.findIndex((group) => group.key === key)),
  },
  {
    key: "standing", label: "Restore",
    groupsOf: (items) => groupBy(items, (item) => restoreStanding(item), (standing) => ({
      label: STANDING_LABEL[standing as RestoreStanding], icon: "restore", about: STANDING_ABOUT[standing as RestoreStanding],
    }), (standing) => STANDING_ORDER.indexOf(standing as RestoreStanding)),
  },
  {
    key: "tier", label: "Tier",
    groupsOf: (items) => groupBy(items, (item) => item.criticality ?? "none", (tier) => {
      const known = TIERS.find((entry) => entry.id === tier);
      return { label: known ? known.label : "No tier", icon: "calendar", about: known ? `${known.description.charAt(0).toUpperCase()}${known.description.slice(1)}` : "Not part of a tier's backup run" };
    }, (tier) => { const index = TIERS.findIndex((entry) => entry.id === tier); return index === -1 ? 9 : index; }),
  },
];

interface ServiceSummary {
  code: string;
  name: string;
  icon: IconName;
  kinds: CoverageType[];
  backedUp: number;
  failed: number;
  partial: number;
  outOfDate: number;
  proven: number;
}

function serviceSummaries(types: CoverageType[]): ServiceSummary[] {
  const map = new Map<string, CoverageType[]>();
  for (const item of types) map.set(serviceCode(item), [...(map.get(serviceCode(item)) ?? []), item]);
  return [...map.entries()].map(([code, kinds]) => {
    const service = serviceFor(code);
    const counts = protectCounts(kinds);
    return { code, name: service.name, icon: service.icon, kinds, backedUp: counts.backedUp, failed: counts.failed, partial: counts.partial, outOfDate: counts.stale + counts.never, proven: counts.proven };
  }).sort((a, b) => {
    const rank = (entry: ServiceSummary) => (entry.failed ? 0 : entry.partial || entry.outOfDate ? 1 : 2);
    return rank(a) - rank(b) || serviceOrder(a.code) - serviceOrder(b.code);
  });
}

function serviceBadge(service: ServiceSummary): { tone: BadgeTone; label: string } {
  if (service.failed) return { tone: "urgent", label: `${service.failed} failed${service.partial ? `, ${service.partial} partly done` : ""}` };
  if (service.partial) return { tone: "soon", label: `${service.partial} partly done` };
  if (service.outOfDate) return { tone: "soon", label: `${service.outOfDate} out of date` };
  if (service.backedUp === service.kinds.length) return { tone: "fine", label: "Backed up" };
  return { tone: "neutral", label: `${service.kinds.length - service.backedUp} not backed up` };
}

function problemLine(item: CoverageType): string {
  switch (backupHealth(item)) {
    case "failed": return `${kindName(item)} failed`;
    case "partial": return `${kindName(item)} was only partly backed up`;
    case "stale": return `${kindName(item)} is out of date`;
    case "never": return `${kindName(item)} never backed up`;
    default: return `${kindName(item)}: ${HEALTH_BADGE[backupHealth(item)].label.toLowerCase()}`;
  }
}

function percent(part: number, whole: number): string {
  return `${whole ? (part / whole) * 100 : 0}%`;
}

function Meter({ service }: { service: ServiceSummary }) {
  const total = service.kinds.length;
  return (
    <span aria-label={`${service.backedUp} backed up, ${service.failed} failed, ${service.partial} partly done, ${service.outOfDate} out of date or never, of ${total}`} className="pt-meter" role="img">
      <i data-tone="fine" style={{ width: percent(service.backedUp, total) }} />
      <i data-tone="urgent" style={{ width: percent(service.failed, total) }} />
      <i data-part="partial" data-tone="soon" style={{ width: percent(service.partial, total) }} />
      <i data-tone="soon" style={{ width: percent(service.outOfDate, total) }} />
    </span>
  );
}

function downloadCsv(types: CoverageType[], now: string) {
  const rows = [["Type", "Service", "Tier", "Backup health", "Can it be restored", "Last backup", "Settings"],
    ...types.map((item) => [kindName(item), typeService(item.type).name, item.criticality ? tierLabel(item.criticality) : "No tier",
      HEALTH_BADGE[backupHealth(item)].label, STANDING_LABEL[restoreStanding(item)], item.lastCollectedAt ? ago(item.lastCollectedAt, now) : "Never", item.itemCount])];
  const blob = new Blob([rows.map((row) => csvLine(row)).join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "whats-protected.csv";
  link.click();
  URL.revokeObjectURL(url);
}

const TILES: { key: HealthTile; label: string; icon: IconName }[] = [
  { key: "backed-up", label: "Backed up", icon: "check-circle" },
  { key: "failed", label: "Failed", icon: "x-circle" },
  { key: "partial", label: "Partly done", icon: "alert" },
  { key: "out-of-date", label: "Out of date or never", icon: "clock" },
  { key: "proven", label: "Restore proven", icon: "restore" },
];
// No tile of their own (the sum line counts them), but a link can pick them: Overview's
// "Not backed up by Keel yet" and "Not on this tenant". They add up with the tiles (OR).
const LINK_FILTERS: { key: HealthFilter; label: string }[] = [
  { key: "not-backed-up", label: "Not backed up by Keel yet" },
  { key: "not-on-tenant", label: "Not on this tenant" },
];
const FILTER_LABELS = new Map<string, string>([...TILES, ...LINK_FILTERS].map((entry) => [entry.key, entry.label]));
const HEALTH_TILES: FilterTile<CoverageType>[] = [...TILES, ...LINK_FILTERS].map((tile) => ({ key: tile.key, test: (item: CoverageType) => matchesHealth(item, tile.key) }));

const TIER_IDS = TIERS.map((tier) => tier.id);

function retryTitle(plan: RetryPlan): string {
  if (plan.kind === "tier") return `Runs every ${tierLabel(plan.tier)} type again. It only reads your tenant.`;
  if (plan.kind === "workloads") return "Runs the Exchange, SharePoint, Teams, Purview and Power Platform settings backup again. It only reads your tenant.";
  return "This type has no tier, so this runs a full backup. It only reads your tenant.";
}

export function ProtectCoverage({ data, now, canBackup, canCollect = canBackup, tierStrip, children, active }: {
  data: CoverageData;
  now: string;
  canBackup: boolean;
  // Retrying a kind with no tier runs the settings or full backup, which needs collect.
  canCollect?: boolean;
  tierStrip?: ReactNode;
  // Each tier's backup that is queued or running, so its buttons say so and stay off.
  active?: ActiveTierRuns;
  // The rest of the page's explanation layer (content backups, recent jobs), after the list.
  children?: ReactNode;
}) {
  const view = useViewState();
  const pathname = usePathname() ?? "/protect";
  const params = useLiveSearchParams();
  const { backUp, retry, busy, feedback, runOf } = useBackup(active, now);
  const canRetry = (plan: RetryPlan) => (plan.kind === "tier" ? canBackup : canCollect);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());

  // The health tiles add up: `health=failed,out-of-date` shows kinds in either. Service narrows.
  const healthFilter = readPicked(HEALTH_TILES, view.get("health"));
  const pickedKey = healthFilter.join(",");
  const service = view.get("service");
  // The verdict and the tiles count the kinds the service filter leaves, like the list.
  // Health tile picks don't narrow them, so each tile still says what it would add.
  const scoped = useMemo(() => (service ? data.types.filter((item) => serviceCode(item) === service) : data.types), [data.types, service]);
  const counts = useMemo(() => protectCounts(scoped), [scoped]);
  const services = useMemo(() => serviceSummaries(data.types), [data.types]);
  const others = useMemo(() => (service ? [(item: CoverageType) => serviceCode(item) === service] : []), [service]);
  const shown = useMemo(() => applyFilters(data.types, HEALTH_TILES, pickedKey ? pickedKey.split(",") : [], others), [data.types, pickedKey, others]);
  const tileTotals = useMemo(() => new Map(tileCounts(data.types, HEALTH_TILES, pickedKey ? pickedKey.split(",") : [], others).map((entry) => [entry.key, entry])), [data.types, pickedKey, others]);
  const opened = data.types.find((item) => item.type === view.get("open")) ?? null;
  const windows = coverageWindows(data);
  const liveNote = workloadLiveNote(data);

  const href = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params?.toString() ?? "");
    for (const [key, value] of Object.entries(changes)) if (value) next.set(key, value); else next.delete(key);
    const query = next.toString();
    return query ? `${pathname}?${query}` : pathname;
  };
  // Filters replace the URL; opening a kind pushes it, so Back closes the panel.
  const follow = (event: MouseEvent, changes: Record<string, string | null>, push = false) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    if (push) pushUrl(href(changes));
    else view.set(changes);
  };

  const pickedServices = services.filter((entry) => picked.has(entry.code));
  const pickedPlan = backupPlan(pickedServices.flatMap((entry) => entry.kinds));
  const togglePick = (code: string) => setPicked((current) => {
    const next = new Set(current);
    if (next.has(code)) next.delete(code); else next.add(code);
    return next;
  });

  const tileSmall: Record<HealthTile, string> = {
    "backed-up": `of ${counts.total} ${counts.total === 1 ? "type" : "types"}`,
    failed: counts.failed ? "Their last backup did not finish" : counts.partial ? `Nothing failed; ${counts.partial} partly done` : "Nothing failed",
    partial: counts.partial ? "Read in part: some settings are missing" : "Nothing partly done",
    "out-of-date": `${counts.stale} out of date, ${counts.never} never`,
    proven: counts.tested ? `${counts.tested} more pass tests, not yet run live` : "By a live test restore on this tenant",
  };
  const tileValue: Record<HealthTile, string> = {
    "backed-up": String(counts.backedUp),
    failed: String(counts.failed),
    partial: String(counts.partial),
    "out-of-date": String(counts.stale + counts.never),
    proven: `${counts.proven} of ${counts.restorable}`,
  };
  const tileTone: Partial<Record<HealthTile, RiskTone>> = {
    failed: counts.failed ? "urgent" : undefined,
    partial: counts.partial ? "soon" : undefined,
    "out-of-date": counts.stale + counts.never ? "soon" : undefined,
  };

  const activeFilters: ActiveFilter[] = [
    ...healthFilter.map((key) => ({ key: `health:${key}`, label: FILTER_LABELS.get(key)!, clear: { health: withoutTile(healthFilter, key) } })),
    ...(service ? [{ key: "service", label: `In ${serviceFor(service).name}`, clear: { service: null } }] : []),
  ];

  const verdict = protectVerdict({ ...data, types: scoped }, now);
  const narrowing = activeFilters.filter((filter) => !filter.key.startsWith("health:")).map((filter) => filter.label);
  const verdictDetail = narrowing.length
    ? protectScopeDetail(narrowing, data.types)
    : protectVerdictDetail(scoped, (type) => typeService(type).name, now);

  return (
    <>
    <Verdict detail={verdictDetail} text={verdict.text} tone={verdict.tone} />
    <div data-layer="explanation">
    <div className="pt-page">
      <section aria-label="Backup health" className="pt-tiles">
        {TILES.map((tile) => {
          const active = healthFilter.includes(tile.key);
          const adds = addsWords(tileTotals.get(tile.key), healthFilter.length);
          const changes = { health: tileParam(HEALTH_TILES, healthFilter, tile.key), open: null };
          return (
            <Link
              aria-current={active || undefined}
              className="pt-tile"
              data-tone={tileTone[tile.key]}
              href={href(changes)}
              key={tile.key}
              onClick={(event) => follow(event, changes)}
              title={active ? "Picked: click to remove it from the view" : "Click to add these to the view"}
            >
              <span className="pt-tile-label"><Icon name={tile.icon} />{tile.label}{active ? <Icon className="tile-check" name="check" /> : null}</span>
              <b className="pt-tile-count">{tileValue[tile.key]}</b>
              <small>{tileSmall[tile.key]}</small>
              {adds ? <small className="tile-adds">{adds}</small> : null}
            </Link>
          );
        })}
      </section>
      {/* The tiles leave out kinds Keel does not back up yet; this line counts every kind, so the parts add up. */}
      <p className="pt-tiles-sum">{coverageSentence(coverageSummary(scoped))}</p>

      {tierStrip}

      {/* Pick A on a desktop (one grouped list), pick B on a phone (service cards first). */}
      <section aria-labelledby="by-service-heading" className="pt-section pt-by-service">
        <div className="pt-section-head">
          <div>
            <h2 id="by-service-heading">By service</h2>
            <p>Open a service to see its types below, or tick services to back them up together.</p>
          </div>
        </div>
        <div className="pt-services">
          {services.map((entry) => {
            const badge = serviceBadge(entry);
            // Failures first, then out of date, then kinds Keel does not back up here.
            const problems = entry.kinds.filter((item) => !["ok", "empty"].includes(backupHealth(item)));
            const ordered_problems = smartOrder(problems, (item) => healthRisk(item) ?? "low", () => "").slice(0, 2);
            const newest = entry.kinds.map((item) => item.lastCollectedAt).filter((value): value is string => Boolean(value)).sort().at(-1);
            const active = service === entry.code;
            const isPicked = picked.has(entry.code);
            return (
              <div className="pt-service" data-active={active || undefined} data-picked={isPicked || undefined} key={entry.code}>
                <div className="pt-service-head">
                  <input aria-label={`Select ${entry.name}`} checked={isPicked} className="sel-check" onChange={() => togglePick(entry.code)} type="checkbox" />
                  <span aria-hidden="true" className="pt-kind"><Icon name={entry.icon} /></span>
                  <b>{entry.name}</b>
                  <Badge tone={badge.tone}>{badge.label}</Badge>
                </div>
                <p className="pt-service-big"><b>{entry.backedUp}</b><span>of {entry.kinds.length} {entry.kinds.length === 1 ? "type" : "types"} backed up</span></p>
                <Meter service={entry} />
                <ul className="pt-service-lines">
                  {ordered_problems.length ? ordered_problems.map((item) => (
                    <li data-tone={healthRisk(item)} key={item.type}><Icon name={backupHealth(item) === "failed" ? "x-circle" : backupHealth(item) === "partial" ? "alert" : healthRisk(item) ? "clock" : "info"} />{problemLine(item)}</li>
                  )) : (
                    <>
                      {newest ? <li data-tone="fine"><Icon name="check-circle" />All backed up {ago(newest, now)}</li> : null}
                      <li><Icon name="restore" />{entry.proven} {entry.proven === 1 ? "restore" : "restores"} proven</li>
                    </>
                  )}
                </ul>
                <Link
                  aria-current={active || undefined}
                  className="pt-service-open"
                  href={href({ service: active ? null : entry.code, open: null })}
                  onClick={(event) => follow(event, { service: active ? null : entry.code, open: null })}
                >
                  {active ? "Show every service" : `Open ${entry.kinds.length} ${entry.kinds.length === 1 ? "type" : "types"}`}
                  <Icon name={active ? "close" : "chevron-down"} />
                </Link>
              </div>
            );
          })}
        </div>
        {pickedServices.length ? (
          <div aria-label="Chosen services" className="sel-bar pt-selbar" role="region">
            <span className="sel-bar-count"><b>{pickedServices.length === 1 ? "1 service" : `${pickedServices.length} services`}</b> selected</span>
            <span className="sel-bar-detail">{pickedServices.map((entry) => entry.name).join(", ")}: {backupPlanSentence(pickedPlan)}</span>
            <span className="sel-bar-actions">
              <button
                aria-busy={busy === "services" || undefined}
                className="btn btn-primary"
                disabled={!canBackup || busy !== null || pickedPlan.tiers.length === 0}
                onClick={() => void backUp(pickedPlan.tiers, "services").then(() => setPicked(new Set()))}
                type="button"
              >
                <Icon name="play" />Back up {pickedServices.length === 1 ? "1 service" : `${pickedServices.length} services`}
              </button>
              <button aria-label="Clear selection" className="icon-button" onClick={() => setPicked(new Set())} title="Clear selection" type="button"><Icon name="close" /></button>
            </span>
          </div>
        ) : null}
      </section>

      <section aria-labelledby="kinds-heading" className="pt-section" id="kinds">
        <div className="pt-section-head">
          <div>
            <h2 id="kinds-heading">Every setting type</h2>
            <p>Whether each one is backed up and whether Keel can put it back. Open one for the details.</p>
          </div>
          <button className="btn btn-sm" onClick={() => downloadCsv(shown, now)} type="button"><Icon name="save" />Download CSV</button>
        </div>
        {windows.length > 1 ? <p className="pt-note"><Icon name="info" /><span>These types were read at different times, so treat each one as its own copy, not one picture of the tenant at a single moment.</span></p> : null}
        {liveNote ? (
          <div className="pt-note" role="note">
            <Icon name="info" />
            <div>
              <span>{liveNote.summary}</span>
              <details className="technical-details">
                <summary>Dates and reasons</summary>
                <ul>{liveNote.lines.map((line) => <li key={line}>{line}</li>)}</ul>
              </details>
            </div>
          </div>
        ) : null}
        <ActiveFilters extra={{ open: null }} filters={activeFilters} noun={NOUN} shown={shown.length} total={data.types.length} />
        <SelectableList
          action={{
            label: (count) => `Back up ${count} ${count === 1 ? "type" : "types"}`,
            detail: (_count, ids) => backupPlanSentence(backupPlan(data.types.filter((item) => ids.includes(item.type)))),
            run: (ids) => {
              const plan = backupPlan(data.types.filter((item) => ids.includes(item.type)));
              if (canBackup && plan.tiers.length) void backUp(plan.tiers, "kinds");
            },
          }}
          empty={activeFilters.length ? <NoMatches extra={{ open: null }} filters={activeFilters} noun={NOUN} /> : undefined}
          getId={(item) => item.type}
          groupings={GROUPINGS}
          items={shown}
          label="Every setting type"
          matches={(item, query) => `${kindName(item)} ${typeName(item.type)} ${item.type} ${typeService(item.type).name}`.toLowerCase().includes(query)}
          noun={NOUN}
          renderRow={(item) => {
            const state = backupHealth(item);
            const badge = HEALTH_BADGE[state];
            const tier = item.criticality && TIERS.some((entry) => entry.id === item.criticality) ? item.criticality : null;
            // Every failed or partly done kind says why and can be run again, tier or not.
            const reason = failureReason(item);
            const plan = needsRetry(item) ? retryPlan(item, TIER_IDS) : null;
            return (
              <div className={`pt-row health-${state}`}>
                <span aria-hidden="true" className="pt-kind" data-tone={healthRisk(item)}><Icon name={typeService(item.type).icon} /></span>
                <span className="pt-row-name">
                  <Link className="pt-row-link" href={href({ open: item.type })} onClick={(event) => follow(event, { open: item.type }, true)}>{kindName(item)}</Link>
                  <small>{typeService(item.type).name} · {tier ? tierLabel(tier) : "No tier"}</small>
                </span>
                <span className="pt-row-mid">
                  <Badge tone={badge.tone}>{badge.label}</Badge>
                  <span className="pt-row-line">{backupSentence(item, now)}</span>
                  {reason ? <span className="pt-row-why"><FailureLine compact reason={reason} /></span> : null}
                </span>
                <span className="pt-row-acts">
                  {plan ? (() => {
                    // A tier retry is that tier's backup: while it is queued or running, say so.
                    const run = plan.kind === "tier" ? runOf(plan.tier) : null;
                    return (
                      <button
                        aria-busy={busy === item.type || undefined}
                        aria-label={run ? undefined : `Retry ${kindName(item)}`}
                        className="btn btn-sm"
                        disabled={!canRetry(plan) || busy !== null || run !== null}
                        onClick={() => void retry(plan, kindName(item), item.type)}
                        title={run ? activeRunSentence(run, now) : canRetry(plan) ? retryTitle(plan) : `You need the ${plan.kind === "tier" ? "backup" : "collect"} permission to run this again.`}
                        type="button"
                      >
                        {run && plan.kind === "tier" ? <><Icon name="refresh" />{`${tierLabel(plan.tier)} ${runWord(run).toLowerCase()}`}</> : <><Icon name="play" />Retry</>}
                      </button>
                    );
                  })() : tier && PROBLEM.includes(state) ? (() => {
                    const run = runOf(tier);
                    return (
                      <button
                        aria-busy={busy === item.type || undefined}
                        className="btn btn-sm"
                        disabled={!canBackup || busy !== null || run !== null}
                        onClick={() => void backUp([tier], item.type)}
                        title={run ? activeRunSentence(run, now) : `Runs every ${tierLabel(tier)} type`}
                        type="button"
                      >
                        {run ? `${tierLabel(tier)} ${runWord(run).toLowerCase()}` : `Back up ${tierLabel(tier)} again`}
                      </button>
                    );
                  })() : null}
                </span>
              </div>
            );
          }}
          sorts={SORTS}
          rowName={kindName}
          toneOf={healthRisk}
        />
        {feedback}
        <TechnicalDetails summary="Technical details for every type">
          {windows.length > 1 ? <RecordField copy={false} label="Observation windows differ" value={windows.join("; ")} /> : null}
          {data.types.map((item) => (
            <RecordGroup key={item.type} note={`${typeService(item.type).name} · ${item.type}`} title={kindName(item)}>
              <TypeRecordFields item={item} />
            </RecordGroup>
          ))}
        </TechnicalDetails>
      </section>

      {/* The details panel's styles come with it (they live with the Baselines section). */}
      {opened ? <BaselinesStyles /> : null}
      {opened ? (
        <DetailsSheet
          footer={needsRetry(opened) && canRetry(retryPlan(opened, TIER_IDS)) && !(() => { const plan = retryPlan(opened, TIER_IDS); return plan.kind === "tier" && runOf(plan.tier) !== null; })() ? (
            <>
              <button
                aria-busy={busy === "sheet" || undefined}
                className="btn btn-primary"
                disabled={busy !== null}
                onClick={() => void retry(retryPlan(opened, TIER_IDS), kindName(opened), "sheet")}
                type="button"
              >
                <Icon name="play" />Retry {kindName(opened)}
              </button>
              <p className="bl-help">{retryTitle(retryPlan(opened, TIER_IDS))}</p>
            </>
          ) : opened.criticality && TIERS.some((entry) => entry.id === opened.criticality) && canBackup ? (() => {
            const tier = opened.criticality!;
            const run = runOf(tier);
            return (
              <>
                <button
                  aria-busy={busy === "sheet" || undefined}
                  className="btn btn-primary"
                  disabled={busy !== null || run !== null}
                  onClick={() => void backUp([tier], "sheet")}
                  type="button"
                >
                  <Icon name={run ? "refresh" : "play"} />{run ? `${tierLabel(tier)} ${runWord(run).toLowerCase()}` : `Back up ${tierLabel(tier)}`}
                </button>
                {run ? (
                  <p className="bl-help" role="status">{activeRunSentence(run, now)} <Link href={`/jobs/${encodeURIComponent(run.jobId)}`}>View job</Link></p>
                ) : (
                  <p className="bl-help">Runs every {tierLabel(tier)} type. It only reads your tenant.</p>
                )}
              </>
            );
          })() : undefined}
          kicker={<><Badge tone={HEALTH_BADGE[backupHealth(opened)].tone}>{HEALTH_BADGE[backupHealth(opened)].label}</Badge><span>{typeService(opened.type).name}</span></>}
          onClose={() => view.set({ open: null })}
          title={kindName(opened)}
          wide
        >
          <TypeDetails item={opened} name={kindName(opened)} now={now} />
        </DetailsSheet>
      ) : null}
    </div>
    {children}
    </div>
    </>
  );
}
