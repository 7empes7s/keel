"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, type MouseEvent, type ReactNode } from "react";

import { BaselinesStyles } from "@/components/baselines/styles";
import { AttackTimeline, AttackWindowList, TimelineLegend } from "@/components/incidents/attack-window";
import { BackupSheet, type BackupStep } from "@/components/incidents/backup-sheet";
import { CheckSheet } from "@/components/incidents/check-sheet";
import { ConfirmSheet } from "@/components/incidents/confirm-sheet";
import { IncidentRecord } from "@/components/incidents/incident-record";
import { AttackWindowSheet, NewIncidentSheet } from "@/components/incidents/incident-sheets";
import { ActiveFilters, NoMatches, type ActiveFilter } from "@/components/list/active-filters";
import { SelectableList, type Grouping, type ListGroup } from "@/components/list/selectable-list";
import { OptionPicker } from "@/components/pickers/option-picker";
import { Segmented } from "@/components/pickers/segmented";
import { Icon, type IconName } from "@/components/shell/icons";
import { Badge } from "@/components/ui/badge";
import { Person } from "@/components/ui/person";
import { Verdict } from "@/components/verdict";
import { incidentAction } from "@/lib/incident-calls";
import {
  ALLOW_EFFECT, CLOSE_EFFECT, HISTORY_HREF, KEPT_HELP, READ_ONLY_LINE, STATES, WINDOW_HELP,
  backupAge, backupName, backupsWord, checkLine, incidentServiceGroups, serviceBackupLine, serviceBackupStatus, serviceGroupWords, incidentCounts, incidentVerdict, isStateFilter, orderBackups,
  personOf, restoreHref, stateChip, stateOf, type BackupState, type StateFilter,
} from "@/lib/incidents-view";
import type { IncidentDetail, IncidentRecoveryPoint, IncidentServiceBackup, IncidentSummary } from "@/lib/portal-data";
import { addsWords, applyFilters, readPicked, tileCounts, tileParam, withoutTile, type FilterTile } from "@/lib/filter-set";
import { ago } from "@/lib/presentation";
import { personLabel } from "@/lib/sentences";
import { serviceFor } from "@/lib/services";
import { toast } from "@/lib/toast";
import { pushUrl } from "@/lib/url-history";
import { useViewState } from "@/lib/use-view-state";

// Incidents (portal audit, pick B: incident picker at the top). During a breach the
// newest backup is the one most likely to hold the attacker's changes, so the page
// names the newest backup an investigator CLEARED (the engine's choice). Address:
// `incident=` (which incident, read by the server), `show=open|closed|all` (the
// picker's list), `state=` (a tile's filter), `open=<snapshotId>` (a backup's panel),
// `do=check|keep|release|allow|withdraw|window|close` (a step's sheet), `pick=` (the
// backups a bulk keep acts on), `new=1` (the new incident sheet).

type Show = "open" | "closed" | "all";

// The backup tiles: each state, and kept from clean-up.
const STATE_TILES: FilterTile<IncidentRecoveryPoint>[] = [
  ...(["cleared", "unchecked", "unsafe"] as const).map((key) => ({ key, test: (point: IncidentRecoveryPoint) => stateOf(point) === key })),
  { key: "kept", test: (point: IncidentRecoveryPoint) => Boolean(point.pinned) },
];

const TILE_SMALL: Record<StateFilter, string> = {
  cleared: "Safe to restore from",
  unchecked: "Check them before you restore",
  unsafe: "A restore from them is refused",
  kept: "Safe from routine clean-up",
};

export function IncidentsPage({ incidents, selected, canInvestigate, now }: {
  incidents: IncidentSummary[];
  selected: IncidentDetail | null;
  canInvestigate: boolean;
  now: string;
}) {
  const router = useRouter();
  const view = useViewState();
  const pathname = usePathname() ?? "/incidents";
  const params = useSearchParams();
  const verdict = incidentVerdict({ incidents, selected, now });
  const counts = incidentCounts(incidents, selected);
  const showParam = view.get("show");
  const show: Show = showParam === "open" || showParam === "closed" || showParam === "all" ? showParam : counts.open ? "open" : "all";
  const stateParam = view.get("state");
  // The backup tiles add up: `state=unchecked,kept` shows backups in either.
  const filter = readPicked(STATE_TILES, stateParam) as StateFilter[];
  const filterKey = filter.join(",");
  const incident = selected?.incident ?? null;
  const canChange = canInvestigate && incident?.status === "open";
  const points = useMemo(() => (selected ? orderBackups(selected.points, selected.recommended) : []), [selected]);
  const shown = useMemo(() => applyFilters(points, STATE_TILES, filterKey ? filterKey.split(",") : []), [points, filterKey]);
  const tileTotals = useMemo(() => new Map(tileCounts(points, STATE_TILES, filterKey ? filterKey.split(",") : []).map((entry) => [entry.key, entry])), [points, filterKey]);
  const activeFilters: ActiveFilter[] = filter.map((key) => ({ key: `state:${key}`, label: key === "kept" ? "Kept from clean-up" : `${STATES[key].label} backups`, clear: { state: withoutTile(filter, key) } }));
  const opened = points.find((point) => point.snapshotId === view.get("open")) ?? null;
  const step = view.get("do");
  const picked = view.get("pick").split(",").filter(Boolean);
  const targets = picked.length ? points.filter((point) => picked.includes(point.snapshotId)) : opened ? [opened] : [];
  const overrideOf = (snapshotId: string) => selected?.overrides?.find((entry) => entry.snapshotId === snapshotId) ?? null;
  const pinOf = (snapshotId: string) => selected?.pins.find((entry) => entry.snapshotId === snapshotId) ?? null;
  const today = now.slice(0, 10);

  const href = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params?.toString() ?? "");
    for (const [key, value] of Object.entries(changes)) if (value) next.set(key, value); else next.delete(key);
    const text = next.toString();
    return text ? `${pathname}?${text}` : pathname;
  };
  const openHref = (id: string, action: string | null = null) => href({ open: id, do: action, pick: null, new: null });
  const follow = (event: MouseEvent, to: string) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    pushUrl(to);
  };
  const closeSheets = () => view.set({ open: null, do: null, pick: null, new: null });
  const back = () => (picked.length || !opened ? closeSheets() : view.set({ do: null }));
  const done = (title: string, detail?: string) => {
    toast({ title, detail });
    router.refresh();
  };

  const options = incidents
    .filter((entry) => show === "all" || entry.status === show || entry.id === incident?.id)
    .map((entry) => ({
      value: entry.id,
      label: entry.title,
      icon: (entry.status === "open" ? "alert" : "check-circle") as IconName,
      hint: `${entry.status === "open" ? "Open" : "Closed"} · opened ${ago(entry.openedAt, now)} by ${personLabel(personOf(entry.owner))}`,
    }));

  // The Service view (the default) shows every Microsoft 365 service in one list: the
  // tenant backups an investigator checks (Entra ID and Intune) are its rows, and each
  // other service follows with its own backups, which are checked by hand. A state tile
  // narrows the checked backups only, so the other services step aside while one is on.
  const query = view.get("q");
  const serviceBackups = selected?.serviceBackups;
  const groupings = useMemo<Grouping<IncidentRecoveryPoint>[]>(() => [
    { key: "service", label: "Service", groupsOf: (items) => {
      const searching = query.trim() !== "";
      const checked: ListGroup<IncidentRecoveryPoint> = {
        key: "entra-intune",
        label: "Entra ID and Intune",
        icon: "service-entra",
        about: "Checked by an investigator",
        items,
        ...(items.length ? {} : { count: "No backup yet", extra: <p className="ir-muted">No tenant backup has finished yet.</p> }),
      };
      if (filterKey) return items.length ? [checked] : [];
      const others = incidentServiceGroups(serviceBackups ?? [], query).map((group): ListGroup<IncidentRecoveryPoint> => {
        const service = group.service ?? serviceFor(null);
        const words = serviceGroupWords(group.entries);
        return {
          key: service.code,
          label: service.name,
          icon: service.icon,
          about: words.about,
          items: [],
          count: words.count,
          extra: group.entries.length
            ? <ServiceBackupList entries={group.entries} now={now} />
            : <p className="ir-muted">KEEL has no backup of {service.name} yet.</p>,
        };
      });
      return [...(items.length || !searching ? [checked] : []), ...others];
    } },
    { key: "state", label: "State", groupsOf: (items) => groupBy(items, (item) => stateOf(item), (key, list) => ({ label: STATES[key as BackupState].plural, icon: STATES[key as BackupState].icon, about: backupsWord(list.length) }), (key) => STATES[key as BackupState].rank) },
    { key: "day", label: "Day", groupsOf: (items) => groupBy(items, (item) => String(item.observedTo ?? item.observedFrom ?? "").slice(0, 10), (key, list) => ({ label: key ? new Date(`${key}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }) : "Unknown day", icon: "calendar" as IconName, about: backupsWord(list.length) }), (key) => -Number(key.replaceAll("-", ""))) },
  ], [query, filterKey, serviceBackups, now]);

  const renderRow = (point: IncidentRecoveryPoint) => {
    const state = stateOf(point);
    const words = STATES[state];
    const recommended = selected?.recommended === point.snapshotId;
    const override = overrideOf(point.snapshotId);
    const line = checkLine(point, now);
    const name = backupName(point);
    return (
      <div className="ir-row" data-state={state}>
        <span aria-hidden="true" className="ir-kind" data-tone={point.stale ? "soon" : words.tone}><Icon name="backup" /></span>
        <span className="ir-row-name">
          <Link className="ir-row-link" href={openHref(point.snapshotId)} onClick={(event) => follow(event, openHref(point.snapshotId))}>{name}</Link>
          <small>{backupAge(point, now)}</small>
        </span>
        <span className="ir-row-mid">
          <span className="ir-chips">
            <Badge icon={words.icon} tone={point.stale ? "soon" : words.tone}>{stateChip(point)}</Badge>
            {recommended ? <Badge icon="star" tone="low">Recommended</Badge> : null}
            {point.inCompromiseWindow ? <Badge icon="alert" tone="urgent">Taken during the attack</Badge> : null}
            {override ? <Badge icon="check" tone="low">Restore allowed</Badge> : null}
            {point.pinned ? <Badge icon="pin" tone="neutral">Kept</Badge> : null}
          </span>
          <small className="ir-check-line">{line.prefix}{line.person ? <> <Person person={line.person} /></> : null}{line.when ? ` · ${line.when}` : ""}</small>
        </span>
        <span className="ir-row-acts">
          {state === "cleared" ? <Link className="btn btn-sm" href={restoreHref(point.snapshotId, incident?.id ?? "")}>Restore from this backup</Link>
            : override ? <Link className="btn btn-sm" href={restoreHref(point.snapshotId, incident?.id ?? "")}>Restore anyway</Link>
              : canChange ? <Link className="btn btn-sm" href={openHref(point.snapshotId, "check")} onClick={(event) => follow(event, openHref(point.snapshotId, "check"))}>{point.assessment ? "Record a new check" : "Record your check"}</Link>
                : null}
        </span>
      </div>
    );
  };

  async function keep(reason: string): Promise<string | null> {
    const todo = targets.filter((point) => !point.pinned);
    if (!todo.length) { closeSheets(); toast({ title: "Already kept", detail: "Every backup you chose is already kept." }); return null; }
    const failed: string[] = [];
    let reasonText: string | null = null;
    for (const point of todo) {
      const result = await incidentAction("pin", { incidentId: incident?.id, snapshotId: point.snapshotId, reason });
      if (!result.ok) { failed.push(backupName(point)); reasonText = result.reason; }
    }
    if (failed.length === todo.length) return reasonText;
    back();
    if (failed.length) toast({ tone: "warning", title: `Kept ${todo.length - failed.length} of ${todo.length} backups`, detail: `Not kept: ${failed.join(", ")}.` });
    else done(todo.length === 1 ? "Backup kept" : `${backupsWord(todo.length)} kept`, "Routine clean-up will not remove them until you let them go.");
    if (failed.length) router.refresh();
    return null;
  }

  const target = targets[0] ?? null;
  const sheetOpen = Boolean((view.get("new") && canInvestigate) || opened || (step && canChange));

  return (
    <div className="ir-page">
      <Verdict action={verdict.action} detail={verdict.detail} text={verdict.text} tone={verdict.tone} />
      <div data-layer="explanation">
        {incidents.length ? (
          <div className="ir-toolbar">
            <OptionPicker label="Incident" onChange={(id) => router.push(`/incidents?incident=${encodeURIComponent(id)}${showParam ? `&show=${showParam}` : ""}`)} options={options} placeholder="Choose an incident" value={incident?.id ?? null} />
            <Segmented label="Show" onChange={(value) => view.set({ show: value })} options={[{ value: "open", label: "Open" }, { value: "closed", label: "Closed" }, { value: "all", label: "All" }]} value={show} />
            {canInvestigate ? <Link className="btn" href={href({ new: "1", open: null, do: null })} onClick={(event) => follow(event, href({ new: "1", open: null, do: null }))}><Icon name="plus" />New incident</Link> : null}
          </div>
        ) : (
          <section className="ir-empty">
            <p>No incident is recorded. Open one when you suspect an attacker had access, so restores use a backup an investigator checked.</p>
            {canInvestigate ? <Link className="btn" href={href({ new: "1" })} onClick={(event) => follow(event, href({ new: "1" }))}><Icon name="plus" />New incident</Link> : null}
          </section>
        )}
        {!canInvestigate ? <p className="ir-muted">{READ_ONLY_LINE}</p> : null}

        {selected && incident ? <>
          <section aria-label="Backups at a glance" className="ir-tiles">
            <Link aria-current={show === "open" && showParam === "open" ? true : undefined} className="ir-tile" href={href({ show: "open", state: null })}>
              <span className="ir-tile-label"><Icon name="alert" />Open incidents</span>
              <b className="ir-tile-count">{counts.open}</b>
              <small>{counts.closed} closed</small>
            </Link>
            {(["cleared", "unchecked", "kept"] as const).map((key) => {
              const active = filter.includes(key);
              const adds = addsWords(tileTotals.get(key), filter.length);
              const count = counts[key];
              const tone = key === "unchecked" && count ? "soon" : key === "cleared" && !count && incident.status === "open" ? "urgent" : undefined;
              const label = key === "cleared" ? "Cleared backups" : key === "unchecked" ? "Not checked yet" : "Kept from clean-up";
              const icon: IconName = key === "cleared" ? "check-circle" : key === "unchecked" ? "clock" : "pin";
              return (
                <Link aria-current={active || undefined} className="ir-tile" data-tone={tone} href={href({ state: tileParam(STATE_TILES, filter, key), open: null, do: null })} key={key} title={active ? "Picked: click to remove it from the view" : "Click to add these to the view"}>
                  <span className="ir-tile-label"><Icon name={icon} />{label}{active ? <Icon className="tile-check" name="check" /> : null}</span>
                  <b className="ir-tile-count">{count}</b>
                  <small>{key === "unchecked" && counts.uncheckedInWindow ? `${counts.uncheckedInWindow} during the attack` : TILE_SMALL[key]}</small>
                  {adds ? <small className="tile-adds">{adds}</small> : null}
                </Link>
              );
            })}
          </section>

          <section aria-labelledby="ir-incident-heading" className="ir-card">
            <header className="ir-card-head">
              <div className="ir-title">
                <h2 id="ir-incident-heading">{incident.title}</h2>
                <Badge icon={incident.status === "open" ? "clock" : "check-circle"} tone={incident.status === "open" ? "soon" : "fine"}>{incident.status === "open" ? "Open" : "Closed"}</Badge>
                <small>Opened {ago(incident.openedAt, now)} by <Person person={personOf(incident.owner)} />{incident.closedAt ? ` · closed ${ago(incident.closedAt, now)}` : ""}</small>
              </div>
              <span className="ir-card-acts">
                <Link className="btn btn-sm btn-ghost" href={HISTORY_HREF}><Icon name="audit" />History</Link>
                {canChange ? <Link className="btn btn-sm" href={href({ do: "window", open: null, pick: null })} onClick={(event) => follow(event, href({ do: "window", open: null, pick: null }))}><Icon name="plus" />Add attack window</Link> : null}
                {canChange ? <Link className="btn btn-sm" href={href({ do: "close", open: null, pick: null })} onClick={(event) => follow(event, href({ do: "close", open: null, pick: null }))}><Icon name="close" />Close incident</Link> : null}
              </span>
            </header>
            {incident.status === "closed" ? <p className="ir-closed-note">This incident is closed, so nothing on it can change. It stays as a record; open a new incident if the attacker comes back.</p> : null}
            <h3 className="ir-subhead"><Icon name="alert" />When the attacker had access</h3>
            <AttackTimeline detail={selected} now={now} />
            <TimelineLegend />
            <AttackWindowList detail={selected} />
            {canChange ? <p className="ir-muted">{WINDOW_HELP}</p> : null}
          </section>

          <section aria-labelledby="ir-backups-heading" className="ir-section">
            <h2 id="ir-backups-heading">Backups</h2>
            <p className="ir-muted">Every Microsoft 365 service, in one list. An investigator checks the Entra ID and Intune backups; check the other services&apos; backups by hand before you restore from them.</p>
            <ActiveFilters extra={{ open: null, do: null }} filters={activeFilters} noun={{ one: "backup", many: "backups" }} shown={shown.length} total={points.length} />
            {points.length === 0 && !serviceBackups?.length ? (
              <p className="sel-empty">No completed backups exist for this tenant yet.</p>
            ) : points.length && shown.length === 0 ? (
              <NoMatches extra={{ open: null, do: null }} filters={activeFilters} noun={{ one: "backup", many: "backups" }} />
            ) : (
              <SelectableList
                action={canChange ? {
                  label: (count) => `Keep ${backupsWord(count)}`,
                  detail: (count, ids) => {
                    const already = points.filter((point) => ids.includes(point.snapshotId) && point.pinned).length;
                    return `Keeping them stops routine clean-up removing the evidence.${already ? ` ${already === count ? "All are" : `${already} ${already === 1 ? "is" : "are"}`} kept already and stay as they are.` : ""}`;
                  },
                  run: (ids) => pushUrl(href({ do: "keep", pick: ids.join(","), open: null })),
                } : {
                  label: (count) => `Export ${backupsWord(count)}`,
                  detail: () => "Saves these backups' state and checks as a JSON file.",
                  run: (ids) => exportBackups(points.filter((point) => ids.includes(point.snapshotId)), incident, now),
                }}
                getId={(item) => item.snapshotId}
                groupings={groupings}
                items={shown}
                label="Backups"
                matches={(item, text) => `${backupName(item)} ${stateChip(item)}`.toLowerCase().includes(text)}
                noun={{ one: "backup", many: "backups" }}
                renderRow={renderRow}
                rowName={(item) => backupName(item)}
                toneOf={(item) => (item.stale ? "soon" : STATES[stateOf(item)].risk)}
              />
            )}
            <p className="ir-muted">{KEPT_HELP} Kept backups are removed by routine clean-up only after you let them go.</p>
          </section>

          <IncidentRecord detail={selected} />
        </> : null}
      </div>

      {sheetOpen ? <BaselinesStyles /> : null}
      {view.get("new") && canInvestigate ? (
        <NewIncidentSheet
          onClose={closeSheets}
          onOpened={(id, title) => { toast({ title: "Incident opened", detail: `“${title}” is open. Record when the attacker got in, then check the backups.` }); router.push(`/incidents?incident=${encodeURIComponent(id)}`); }}
          today={today}
        />
      ) : step === "close" && canChange && incident ? (
        <ConfirmSheet
          confirmLabel="Close incident"
          effect={CLOSE_EFFECT}
          kicker={<span className="ir-kicker"><Icon name="alert" />Incident</span>}
          onClose={closeSheets}
          onConfirm={async () => {
            const result = await incidentAction("close", { incidentId: incident.id });
            if (!result.ok) return result.reason;
            closeSheets();
            done("Incident closed", `“${incident.title}” stays as a record.`);
            return null;
          }}
          title={`Close “${incident.title}”?`}
        />
      ) : step === "window" && canChange && incident ? (
        <AttackWindowSheet incidentId={incident.id} onClose={closeSheets} onSaved={() => { closeSheets(); done("Attack window added", "Backups taken inside it are marked as taken during the attack."); }} today={today} />
      ) : step === "check" && canChange && incident && opened ? (
        <CheckSheet incidentId={incident.id} key={opened.snapshotId} onClose={back} onSaved={(saved) => { back(); done("Check recorded", saved === "clean" ? "A restore may use this backup." : "A restore from this backup is refused."); }} point={opened} />
      ) : step === "keep" && canChange && targets.length ? (
        <ConfirmSheet
          confirmLabel={`Keep ${backupsWord(targets.length)}`}
          effect={`Routine clean-up will not remove ${targets.length === 1 ? "this backup" : "these backups"} until someone lets ${targets.length === 1 ? "it" : "them"} go. ${KEPT_HELP}`}
          key={targets.map((point) => point.snapshotId).join(",")}
          kicker={<span className="ir-kicker"><Icon name="pin" />Keep</span>}
          onClose={back}
          onConfirm={keep}
          placeholder="Evidence for the case"
          reasonLabel="Why it must be kept"
          title={targets.length === 1 ? "Keep this backup" : `Keep ${backupsWord(targets.length)}`}
        >
          {targets.length > 1 ? <ul className="ir-target-list">{targets.map((point) => <li key={point.snapshotId}>{backupName(point)}{point.pinned ? " (kept already)" : ""}</li>)}</ul> : <p className="ir-muted">Backup of {backupName(targets[0])}.</p>}
        </ConfirmSheet>
      ) : step === "release" && canChange && target && pinOf(target.snapshotId) ? (
        <ConfirmSheet
          confirmLabel="Let clean-up remove it"
          effect="It goes back to routine clean-up, which removes it when it is due. Nothing is deleted now."
          kicker={<span className="ir-kicker"><Icon name="pin" />Keep</span>}
          onClose={back}
          onConfirm={async (reason) => {
            const result = await incidentAction("release", { pinId: pinOf(target.snapshotId)?.id, reason });
            if (!result.ok) return result.reason;
            back();
            done("No longer kept", "Routine clean-up removes it when it is due.");
            return null;
          }}
          placeholder="The case is closed and the evidence is exported"
          reasonLabel="Why it may go"
          title={`Let clean-up remove the backup of ${backupName(target)}?`}
        />
      ) : step === "allow" && canChange && target && stateOf(target) !== "cleared" ? (
        <ConfirmSheet
          confirmLabel="Allow a restore"
          effect={`A restore from this ${stateOf(target) === "unsafe" ? "unsafe" : "unchecked"} backup is refused unless an investigator allows it. ${ALLOW_EFFECT} A new check or a new attack window cancels this permission.`}
          kicker={<span className="ir-kicker"><Icon name="restore" />Allow a restore</span>}
          onClose={back}
          onConfirm={async (reason) => {
            const result = await incidentAction("override", { incidentId: incident?.id, snapshotId: target.snapshotId, reason });
            if (!result.ok) return result.reason;
            back();
            done("Restore allowed", "Someone else must still ask for the restore.");
            return null;
          }}
          placeholder="The only backup with last week's membership changes"
          reasonLabel="Why a restore must use it anyway"
          title="Allow a restore from this backup"
        />
      ) : step === "withdraw" && canChange && target && overrideOf(target.snapshotId) ? (
        <ConfirmSheet
          confirmLabel="Withdraw permission"
          effect="A restore from this backup is refused again. A restore already asked for is blocked when it runs."
          kicker={<span className="ir-kicker"><Icon name="restore" />Allow a restore</span>}
          onClose={back}
          onConfirm={async () => {
            const result = await incidentAction("revoke-override", { overrideId: overrideOf(target.snapshotId)?.id });
            if (!result.ok) return result.reason;
            back();
            done("Permission withdrawn", "A restore from this backup is refused again.");
            return null;
          }}
          title="Withdraw the permission to restore?"
        />
      ) : opened && selected ? (
        <BackupSheet
          canChange={Boolean(canChange)}
          detail={selected}
          key={opened.snapshotId}
          now={now}
          onClose={closeSheets}
          onStep={(name: BackupStep) => pushUrl(openHref(opened.snapshotId, name))}
          point={opened}
          stepHref={(name: BackupStep) => openHref(opened.snapshotId, name)}
        />
      ) : null}
    </div>
  );
}

/** One service's backups against the attack window: a status badge and a line each. */
function ServiceBackupList({ entries, now }: { entries: IncidentServiceBackup[]; now: string }): ReactNode {
  return (
    <ul className="ir-service-list">
      {entries.map((entry) => {
        const status = serviceBackupStatus(entry);
        return (
          <li className="ir-service-row" data-tone={status.tone} key={`${entry.kind}:${entry.workload}`}>
            <span className="ir-service-name">{entry.name}<small>{entry.kind === "content" ? "Content" : "Settings"} · check by hand</small></span>
            <Badge tone={status.tone}>{status.label}</Badge>
            <span className="ir-muted">{serviceBackupLine(entry, now)}</span>
          </li>
        );
      })}
    </ul>
  );
}

function exportBackups(points: IncidentRecoveryPoint[], incident: IncidentSummary, now: string) {
  const text = JSON.stringify({ generatedAt: now, incident: { id: incident.id, title: incident.title, status: incident.status }, backups: points }, null, 2);
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `keel-incident-backups-${now.slice(0, 10)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function groupBy<T>(items: T[], key: (item: T) => string, meta: (key: string, list: T[]) => Omit<ListGroup<T>, "items" | "key">, rank: (key: string) => number): ListGroup<T>[] {
  const map = new Map<string, T[]>();
  for (const item of items) map.set(key(item), [...(map.get(key(item)) ?? []), item]);
  return [...map.entries()].map(([groupKey, list]) => ({ key: groupKey, ...meta(groupKey, list), items: list })).sort((a, b) => rank(a.key) - rank(b.key));
}
