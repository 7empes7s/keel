"use client";

import Link from "next/link";
import { useMemo } from "react";

import { ActiveFilters, NoMatches, type ActiveFilter } from "@/components/list/active-filters";
import { FindInput } from "@/components/list/find-input";
import { ListPager, SortControl, useListPaging, type ListSort } from "@/components/list/list-paging";
import { Icon, type IconName } from "@/components/shell/icons";
import { Badge } from "@/components/ui/badge";
import { applyFilters, pickedTiles, tileCounts, toggleTile } from "@/lib/filter-set";
import { byText, byTime, pageWindow, sortRows } from "@/lib/paging";
import { ago, formatTimestamp } from "@/lib/presentation";
import {
  SITE_TILES, appStatus, backupStatus, backupWords, externalStatus, groupsWords, peopleStatus, sharingLevel, sharingStatus, siteAddress, siteName, sitesInOrder,
  type SitePermissions, type SitesContentRun,
} from "@/lib/site-permissions-view";
import { readList, useViewState } from "@/lib/use-view-state";

// The Sites list: tiles that count sites needing attention, not backed up, reached by
// apps, shared with guests, shared wider than the tenant default or without an owner
// (picking several adds them up), Find
// (narrows), and a compact table with problems first. Columns turn into labelled lines
// whenever the list is too narrow for them (a phone, or a laptop with the menu open).

const NOUN = { one: "site", many: "sites" };

export function SitesTable({ sites, run, now }: { sites: SitePermissions[]; run: SitesContentRun | null; now: string }) {
  const view = useViewState();
  const tiles = useMemo(() => SITE_TILES.map((tile) => ({ key: tile.key, test: (site: SitePermissions) => tile.test(site, run) })), [run]);
  const picked = pickedTiles(tiles, readList(view.get("show")));
  const query = view.get("q").trim().toLowerCase();
  const sorts = useMemo<ListSort<SitePermissions>[]>(() => [
    { key: "name", label: "Name", compare: (a, b) => byText(siteName(a), siteName(b)) },
    { key: "backup", label: "Last backup", desc: true, compare: (a, b) => byTime(backupStatus(a, run).at, backupStatus(b, run).at) },
    { key: "size", label: "Size", desc: true, compare: (a, b) => (a.backup?.bytes ?? -1) - (b.backup?.bytes ?? -1) },
    { key: "apps", label: "Apps with access", desc: true, compare: (a, b) => (a.appGrants.entries?.length ?? -1) - (b.appGrants.entries?.length ?? -1) },
    { key: "people", label: "People", desc: true, compare: (a, b) => (a.people?.people ?? -1) - (b.people?.people ?? -1) },
    { key: "sharing", label: "Most open sharing", desc: true, compare: (a, b) => sharingLevel(a.sharing.value) - sharingLevel(b.sharing.value) },
  ], [run]);
  const paging = useListPaging<SitePermissions>({ sorts });
  const ordered = useMemo(() => sitesInOrder(sites, run), [sites, run]);
  const others = useMemo(() => (query ? [(site: SitePermissions) => `${siteName(site)} ${siteAddress(site) ?? ""} ${site.people?.owners.join(" ") ?? ""}`.toLowerCase().includes(query)] : []), [query]);
  const pickedKey = picked.join(",");
  const shown = useMemo(() => {
    const found = applyFilters(ordered, tiles, pickedKey ? pickedKey.split(",") : [], others);
    return paging.sort ? sortRows(found, paging.sort.compare, paging.dir) : found;
  }, [ordered, tiles, pickedKey, others, paging.sort, paging.dir]);
  const counts = useMemo(() => new Map(tileCounts(ordered, tiles, pickedKey ? pickedKey.split(",") : [], others).map((entry) => [entry.key, entry])), [ordered, tiles, pickedKey, others]);
  const { start, end } = pageWindow(paging.pageOf(shown.length), shown.length, paging.size);

  const filters: ActiveFilter[] = [
    ...picked.map((key) => ({ key: `tile:${key}`, label: SITE_TILES.find((tile) => tile.key === key)!.label, clear: { show: picked.filter((entry) => entry !== key).join(",") || null } })),
    ...(query ? [{ key: "q", label: `Find: “${view.get("q").trim()}”`, clear: { q: null } }] : []),
  ];
  const toggle = (key: string | null) => view.set({ show: key === null ? null : toggleTile(tiles, picked, key).join(",") || null, ...paging.resetPage });

  return (
    <div className="st-list">
      <section aria-label="Sites at a glance" className="st-tiles">
        <button aria-pressed={!picked.length} className="st-tile" onClick={() => toggle(null)} type="button">
          <span className="st-tile-label"><Icon name="service-sharepoint" />All sites</span>
          <b className="st-tile-count">{applyFilters(ordered, tiles, [], others).length}</b>
        </button>
        {SITE_TILES.map((tile) => {
          const entry = counts.get(tile.key);
          const value = entry?.count ?? 0;
          const tone = value && tile.key !== "apps" ? (["no-owner", "attention", "wider"].includes(tile.key) ? "urgent" : "soon") : undefined;
          return (
            <button aria-pressed={entry?.picked ?? false} className="st-tile" data-tone={tone} key={tile.key} onClick={() => toggle(tile.key)} title={entry?.picked ? "Picked: click to remove it from the view" : "Click to add these to the view"} type="button">
              <span className="st-tile-label"><Icon name={tile.icon as IconName} />{tile.label}{entry?.picked ? <Icon className="st-tile-check" name="check" /> : null}</span>
              <b className="st-tile-count">{value}</b>
              {entry?.adds ? <small>+{entry.adds} more</small> : null}
            </button>
          );
        })}
      </section>

      <div className="sel-toolbar">
        <label className="picker-field sel-find">
          <span className="picker-label">Find</span>
          <span className="sel-find-box">
            <Icon name="search" />
            <FindInput onChange={(text) => view.set({ q: text, ...paging.resetPage })} placeholder="Find a site, address or owner" value={view.get("q")} />
          </span>
        </label>
        <SortControl paging={paging} sorts={sorts} />
      </div>

      <ActiveFilters filters={filters} noun={NOUN} shown={shown.length} total={sites.length} />

      {shown.length ? (
        <div className="st-scroll">
          <table aria-label="Sites" className="st-table">
            <thead>
              <tr>
                <th scope="col">Site</th>
                <th scope="col">Backup</th>
                <th scope="col">Apps with access</th>
                <th scope="col">Sharing setting</th>
                <th scope="col">Guests and links</th>
                <th scope="col">Owners and members</th>
              </tr>
            </thead>
            <tbody>
              {shown.slice(start, end).map((site) => <SiteRow key={site.siteId} now={now} run={run} site={site} />)}
            </tbody>
          </table>
        </div>
      ) : (
        <NoMatches filters={filters} noun={NOUN} />
      )}
      <ListPager label="Sites" noun={NOUN} paging={paging} total={shown.length} />
    </div>
  );
}

const rowTone = (statuses: ({ tone: string } | null)[]) => (statuses.some((status) => status?.tone === "urgent") ? "urgent" : statuses.some((status) => status?.tone === "soon") ? "soon" : undefined);

function SiteRow({ site, run, now }: { site: SitePermissions; run: SitesContentRun | null; now: string }) {
  const backup = backupStatus(site, run);
  const apps = appStatus(site);
  const people = peopleStatus(site, run);
  const external = externalStatus(site);
  const sharing = sharingStatus(site);
  const held = backupWords(site);
  const groups = groupsWords(site);
  const owners = site.people?.owners ?? [];
  return (
    <tr data-tone={rowTone([backup, apps, people, external, sharing])}>
      <th data-label="Site" scope="row">
        <Link className="st-name" href={`/sites/${encodeURIComponent(site.siteId)}`}>{siteName(site)}</Link>
        {siteAddress(site) ? <small className="st-address">{siteAddress(site)}</small> : null}
      </th>
      <td data-label="Backup">
        <Badge tone={backup.tone}>{backup.label}</Badge>
        {backup.at ? <small><time dateTime={backup.at} title={formatTimestamp(backup.at)}>{ago(backup.at, now)}</time>{held ? ` · ${held}` : ""}</small> : held ? <small>{held}</small> : null}
      </td>
      <td data-label="Apps with access"><Badge tone={apps.tone}>{apps.label}</Badge></td>
      <td data-label="Sharing setting">
        <Badge tone={sharing.tone}>{sharing.label}</Badge>
        {sharing.key === "wider" ? <small className="st-wider">More open than the default</small> : null}
      </td>
      <td data-label="Guests and links">{external ? <Badge tone={external.tone}>{external.label}</Badge> : <span className="st-unknown">Not known yet</span>}</td>
      <td data-label="Owners and members">
        {site.people ? (
          people.key === "no-owner" ? <Badge tone="urgent">No owner</Badge> : (
            <span className="st-owners" title={owners.join(", ")}>
              {owners.slice(0, 2).join(", ")}
              {site.people.ownerCount > 2 ? <small> +{site.people.ownerCount - 2} more</small> : null}
            </span>
          )
        ) : <Badge tone={people.tone}>{people.label}</Badge>}
        {groups ? <small className="st-members">{groups}</small> : <small className="st-unknown">Groups and people not known yet</small>}
      </td>
    </tr>
  );
}
