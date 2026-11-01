"use client";

import { useRouter } from "next/navigation";
import { Fragment, useEffect, useMemo, useRef } from "react";

import { ActiveFilters, NoMatches, type ActiveFilter } from "@/components/list/active-filters";
import { FindInput } from "@/components/list/find-input";
import { ListPager, SortControl, useListPaging, type ListSort } from "@/components/list/list-paging";
import { OptionPicker } from "@/components/pickers/option-picker";
import { Segmented } from "@/components/pickers/segmented";
import { Icon, type IconName } from "@/components/shell/icons";
import { Badge } from "@/components/ui/badge";
import { addsWords, applyFilters, pickedTiles, tileCounts, toggleTile, type FilterTile } from "@/lib/filter-set";
import { byText, pageGroups, sortRows } from "@/lib/paging";
import {
  PERMISSION_STATUS_LABELS, PERMISSION_STATUS_ORDER, PERMISSION_STATUS_TONES,
  UNUSED_WHY, apiPermissionsLink, appFor, appName, appNameInSentence, consentLink, missingSentence, permissionApps, permissionCounts, permissionRows, roleLink, unusedSentence,
  type PermissionRow, type PermissionStatus, type SetupState,
} from "@/lib/setup-view";
import { toast } from "@/lib/toast";
import { readList, useViewState } from "@/lib/use-view-state";

// Setup's permission table (CoreView comparison, gaps 1 and 2): every permission and
// admin role each Keel app uses, by app and service, with what it is for and whether the
// app holds it. A missing role links to where it is assigned: consent never assigns one.
// Missing ones come first with Microsoft's admin consent page one click away; when the
// admin comes back to this tab, the page checks the tenant again on its own. Held
// permissions Keel never uses are excess privilege: amber, with an alert per app that
// says why it matters and links to where an admin removes them. Keel never removes them.

const SERVICE_ICONS: Record<string, IconName> = {
  entra: "service-entra", governance: "service-entra", intune: "service-intune", exchange: "service-exchange",
  sharepoint: "service-sharepoint", teams: "service-teams", purview: "service-purview", other: "cloud", reports: "reports", unused: "info",
};

const STATUS_HINTS: Record<PermissionStatus, string> = {
  missing: "Keel needs these and the app does not hold them",
  optional: "Would add a feature; nothing fails without them",
  "not-checked": "Keel could not look in your tenant",
  granted: "The app holds these",
  unused: "Keel never uses these. Remove them",
};

const NOUN = { one: "permission or role", many: "permissions and roles" };

const APP_ICONS: Record<string, IconName> = { collector: "backup", restorer: "restore", "content-reader": "inbox", "engage-writer": "restore" };
const PREFIX = "perm-";

interface Group {
  key: string;
  identity: string;
  service: string;
  label: string;
  rows: PermissionRow[];
}

export function PermissionsPanel({ state }: { state: SetupState }) {
  const router = useRouter();
  const view = useViewState();
  const rows = useMemo(() => permissionRows(state), [state]);
  const armed = useRef(false);

  // Back from Microsoft's consent page: check the tenant again without being asked.
  useEffect(() => {
    const back = () => {
      if (!armed.current || document.visibilityState !== "visible") return;
      armed.current = false;
      toast({ title: "Checking permissions again", detail: "Microsoft can take a minute to show a new approval. Press Check again if it still shows missing." });
      router.refresh();
    };
    window.addEventListener("focus", back);
    document.addEventListener("visibilitychange", back);
    return () => { window.removeEventListener("focus", back); document.removeEventListener("visibilitychange", back); };
  }, [router]);
  const arm = () => { armed.current = true; };

  const tiles = useMemo<FilterTile<PermissionRow>[]>(() => PERMISSION_STATUS_ORDER.map((status) => ({ key: status, test: (row) => row.status === status })), []);
  const picked = pickedTiles(tiles, readList(view.get(`${PREFIX}status`)));
  const identities = useMemo(() => permissionApps(state.permissions), [state.permissions]);
  const app = identities.find((identity) => identity === view.get(`${PREFIX}app`)) ?? null;
  const query = view.get(`${PREFIX}q`);
  const text = query.trim().toLowerCase();
  const others = useMemo(() => [
    ...(app ? [(row: PermissionRow) => row.identity === app] : []),
    ...(text ? [(row: PermissionRow) => `${row.words} ${row.name} ${row.usedFor} ${row.serviceLabel} ${row.apiLabel}`.toLowerCase().includes(text)] : []),
  ], [app, text]);
  const shown = useMemo(() => applyFilters(rows, tiles, picked, others), [rows, tiles, picked.join(","), others]);
  const counts = useMemo(() => new Map(tileCounts(rows, tiles, picked, others).map((entry) => [entry.key, entry])), [rows, tiles, picked.join(","), others]);

  const sorts = useMemo<ListSort<PermissionRow>[]>(() => [
    { key: "status", label: "Status", compare: (a, b) => PERMISSION_STATUS_ORDER.indexOf(a.status) - PERMISSION_STATUS_ORDER.indexOf(b.status) },
    { key: "name", label: "Permission", compare: (a, b) => byText(a.words, b.words) },
    { key: "code", label: "Microsoft name", compare: (a, b) => byText(a.name, b.name) },
  ], []);
  const paging = useListPaging<PermissionRow>({ prefix: PREFIX, sorts, defaultSize: "50" });

  const groups = useMemo(() => {
    const out: Group[] = [];
    for (const row of shown) {
      const groupKey = `${row.identity}:${row.service}`;
      let group = out.find((entry) => entry.key === groupKey);
      if (!group) out.push(group = { key: groupKey, identity: row.identity, service: row.service, label: row.serviceLabel, rows: [] });
      group.rows.push(row);
    }
    return paging.sort ? out.map((group) => ({ ...group, rows: sortRows(group.rows, paging.sort!.compare, paging.dir) })) : out;
  }, [shown, paging.sort, paging.dir]);
  const page = paging.pageOf(shown.length);
  const paged = pageGroups(groups, (group) => group.rows.length, () => false, page, paging.size).groups;

  if (!state.permissions || !rows.length) return null;
  const all = permissionCounts(rows);
  const observed = state.permissions.observed;
  const apps = identities.map((identity) => {
    const own = rows.filter((row) => row.identity === identity);
    const info = appFor(state, identity);
    return {
      identity, info, rows: own, counts: permissionCounts(own),
      consent: consentLink(state.tenantId, info?.appId),
      entra: apiPermissionsLink(info?.appId),
      missing: own.filter((row) => row.status === "missing"),
      unused: own.filter((row) => row.status === "unused"),
    };
  });

  const appOptions = [
    { value: "", label: identities.length === 2 ? "Both apps" : "All apps" },
    ...identities.map((identity) => ({ value: identity, label: appName(identity).replace(/ app$/, ""), icon: APP_ICONS[identity] })),
  ];
  const pickApp = (value: string) => view.set({ [`${PREFIX}app`]: value || null, ...paging.resetPage });
  const setTiles = (next: string[]) => view.set({ [`${PREFIX}status`]: next.join(",") || null, ...paging.resetPage });
  const filters: ActiveFilter[] = [
    ...picked.map((status) => ({ key: `status:${status}`, label: PERMISSION_STATUS_LABELS[status as PermissionStatus], clear: { [`${PREFIX}status`]: picked.filter((entry) => entry !== status).join(",") || null } })),
    ...(app ? [{ key: "app", label: appName(app), clear: { [`${PREFIX}app`]: null } }] : []),
    ...(text ? [{ key: "q", label: `Find: “${query.trim()}”`, clear: { [`${PREFIX}q`]: null } }] : []),
  ];
  let lastIdentity: string | null = null;

  return (
    <section aria-labelledby="setup-permissions-title" className="su-pp" id="setup-permissions">
      <header className="su-pp-head">
        <div>
          <h2 id="setup-permissions-title"><Icon name="settings" />Permissions</h2>
          <p>
            What each Keel app may do in Microsoft 365, the admin roles it needs, and what Keel uses them for.{" "}
            {observed
              ? <>Checked in your tenant when this page loaded{!observed.complete ? "; some Exchange or SharePoint permissions could not be read" : ""}.</>
              : "Keel could not look at your tenant just now, so only what setup saw is shown."}
          </p>
        </div>
      </header>

      {apps.filter((entry) => entry.missing.length).map((entry) => {
        const permissions = entry.missing.filter((row) => row.type !== "admin-role");
        const roles = entry.missing.filter((row) => row.type === "admin-role");
        const unlisted = permissions.filter((row) => row.requested === false);
        return (
          <div className="su-pp-alert" data-tone="urgent" key={entry.identity} role="alert">
            <span aria-hidden="true" className="su-pp-alert-icon"><Icon name="x-circle" /></span>
            <div className="su-pp-alert-body">
              <p className="su-pp-alert-title">{missingSentence(entry.identity, entry.missing)}</p>
              {permissions.length ? (
                <p>
                  {entry.consent
                    ? "Approve opens Microsoft's consent page for this app. A Global Administrator signs in once; Keel checks again when you come back to this tab."
                    : "This server does not know the app's ID, so Keel cannot open its consent page. Approve it in Entra ID under the app's API permissions."}
                </p>
              ) : null}
              {unlisted.length ? (
                <p>
                  {unlisted.length === permissions.length ? "They are" : `${unlisted.length} of them ${unlisted.length === 1 ? "is" : "are"}`} not on the app&apos;s permission list yet, so approving cannot grant {unlisted.length === 1 ? "it" : "them"}. Add {unlisted.length === 1 ? "it" : "them"} in Entra ID first: {unlisted.map((row) => row.name).join(", ")}.
                </p>
              ) : null}
              {roles.length ? (
                <p>
                  Approving permissions never assigns an admin role. A Privileged Role Administrator assigns {roles.length === 1 ? "the role" : "each role"} to {entry.info?.displayName ?? `the ${appNameInSentence(entry.identity)}`}: {roles.map((row) => row.name).join(", ")}.
                </p>
              ) : null}
              <div className="su-pp-alert-actions">
                {permissions.length && entry.consent ? (
                  <a className="btn" href={entry.consent} onClick={arm} rel="noreferrer" target="_blank">
                    <Icon name="link" />Approve in Microsoft<span className="visually-hidden"> (opens in a new tab)</span>
                  </a>
                ) : null}
                {permissions.length && entry.entra && (unlisted.length || !entry.consent) ? (
                  <a className="btn" href={entry.entra} onClick={arm} rel="noreferrer" target="_blank">
                    <Icon name="link" />Add in Entra ID<span className="visually-hidden"> (opens in a new tab)</span>
                  </a>
                ) : null}
                {roles.map((row) => {
                  const href = roleLink(row);
                  return href ? (
                    <a className="btn" href={href} key={row.id} onClick={arm} rel="noreferrer" target="_blank">
                      <Icon name="person" />Assign {row.name}<span className="visually-hidden"> in {row.api === "intune" ? "Intune" : "Entra ID"} (opens in a new tab)</span>
                    </a>
                  ) : null;
                })}
                <CopyNames names={entry.missing.map((row) => row.name)} />
              </div>
            </div>
          </div>
        );
      })}

      {apps.filter((entry) => entry.unused.length).map((entry) => {
        const roles = entry.unused.filter((row) => row.type === "admin-role");
        const permissions = entry.unused.length - roles.length;
        return (
          <div className="su-pp-alert" data-kind="unused" data-tone="soon" key={`unused:${entry.identity}`} role="status">
            <span aria-hidden="true" className="su-pp-alert-icon"><Icon name="alert" /></span>
            <div className="su-pp-alert-body">
              <p className="su-pp-alert-title">{unusedSentence(entry.identity, entry.unused)}</p>
              <p>
                This is extra access. {UNUSED_WHY} Every permission an app does not need is one more way in for an attacker, so remove what Keel does not use. Nothing in Keel stops working.
              </p>
              <p>
                {permissions ? `An admin removes ${permissions === 1 ? "the permission" : "the permissions"} in Entra ID under the app's API permissions${roles.length ? ", and " : "."}` : ""}
                {roles.length ? `${permissions ? "a" : "A"} Privileged Role Administrator removes ${roles.length === 1 ? "the role" : "each role"} from ${entry.info?.displayName ?? `the ${appNameInSentence(entry.identity)}`}: ${roles.map((row) => row.name).join(", ")}.` : ""}
                {" "}Keel never removes access for you.
              </p>
              <div className="su-pp-alert-actions">
                {permissions && entry.entra ? (
                  <a className="btn" href={entry.entra} onClick={arm} rel="noreferrer" target="_blank">
                    <Icon name="link" />Remove in Entra ID<span className="visually-hidden"> (opens in a new tab)</span>
                  </a>
                ) : null}
                {roles.map((row) => {
                  const href = roleLink(row);
                  return href ? (
                    <a className="btn" href={href} key={row.id} onClick={arm} rel="noreferrer" target="_blank">
                      <Icon name="person" />Remove {row.name}<span className="visually-hidden"> in {row.api === "intune" ? "Intune" : "Entra ID"} (opens in a new tab)</span>
                    </a>
                  ) : null;
                })}
                <CopyNames names={entry.unused.map((row) => row.name)} />
              </div>
            </div>
          </div>
        );
      })}

      <div aria-label="Permissions by status" className="su-pp-tiles" role="group">
        {PERMISSION_STATUS_ORDER.filter((status) => all[status] > 0).map((status) => {
          const entry = counts.get(status);
          const on = picked.includes(status);
          const adds = addsWords(entry, picked.length);
          return (
            <button
              aria-pressed={on}
              className="su-pp-tile"
              data-tone={PERMISSION_STATUS_TONES[status]}
              key={status}
              onClick={() => setTiles(toggleTile(tiles, picked, status))}
              title={STATUS_HINTS[status]}
              type="button"
            >
              <span className="su-pp-tile-label"><Icon name={status === "granted" ? "check-circle" : status === "missing" ? "x-circle" : status === "unused" ? "alert" : "info"} />{PERMISSION_STATUS_LABELS[status]}</span>
              <b>{entry?.count ?? 0}</b>
              <small>{adds ?? STATUS_HINTS[status]}</small>
            </button>
          );
        })}
      </div>

      <div className="sel-toolbar su-pp-toolbar">
        {appOptions.length > 3 ? (
          // Three apps or more do not fit side by side on a phone: a picker instead.
          <OptionPicker label="App" onChange={pickApp} options={appOptions} value={app ?? ""} />
        ) : (
          <Segmented label="App" onChange={pickApp} options={appOptions} value={app ?? ""} />
        )}
        <label className="picker-field sel-find">
          <span className="picker-label">Find</span>
          <span className="sel-find-box">
            <Icon name="search" />
            <FindInput onChange={(text) => view.set({ [`${PREFIX}q`]: text, ...paging.resetPage })} placeholder="Find permissions" value={query} />
          </span>
        </label>
        <SortControl paging={paging} sorts={sorts} />
      </div>
      <ActiveFilters filters={filters} noun={NOUN} shown={shown.length} total={rows.length} />

      {shown.length ? (
        <table className="su-ptable">
          <caption className="visually-hidden">Permissions by app and service</caption>
          <thead>
            <tr><th scope="col">Permission</th><th scope="col">What Keel uses it for</th><th scope="col">Status</th></tr>
          </thead>
          <tbody>
            {paged.map(({ group, start, end, continued }) => {
              const appEntry = apps.find((entry) => entry.identity === group.identity)!;
              const appHeader = group.identity !== lastIdentity;
              lastIdentity = group.identity;
              return (
                <Fragment key={group.key}>
                  {appHeader ? (
                    <tr className="su-ptable-app">
                      <th colSpan={3} scope="rowgroup"><div className="su-ptable-head">
                        <span className="su-ptable-app-name">
                          <Icon name={APP_ICONS[group.identity] ?? "settings"} />
                          {appName(group.identity)}
                          {appEntry.info?.displayName ? <small>{appEntry.info.displayName}</small> : null}
                        </span>
                        <span className="su-ptable-app-counts">
                          {appEntry.counts.missing ? <Badge tone="urgent">{appEntry.counts.missing} missing</Badge> : null}
                          <Badge tone="fine">{appEntry.counts.granted} granted</Badge>
                          {appEntry.counts.unused ? <Badge tone={PERMISSION_STATUS_TONES.unused}>{appEntry.counts.unused} extra</Badge> : null}
                        </span>
                      </div></th>
                    </tr>
                  ) : null}
                  <tr className="su-ptable-group" data-service={group.service}>
                    <th colSpan={3} scope="rowgroup"><div className="su-ptable-head">
                      <Icon name={SERVICE_ICONS[group.service] ?? "cloud"} />
                      {group.label}
                      <small>{group.rows.length}{continued ? " · continued" : ""}</small>
                      {group.service === "unused" && appEntry.entra ? (
                        <a className="su-inline-link" href={appEntry.entra} rel="noreferrer" target="_blank">Remove in Entra ID<span className="visually-hidden"> (opens in a new tab)</span></a>
                      ) : null}
                    </div></th>
                  </tr>
                  {group.rows.slice(start, end).map((row) => (
                    <tr className="su-ptable-row" data-status={row.status} key={row.id}>
                      <td data-label="Permission">
                        <span className="su-ptable-words">{row.words}</span>
                        <span className="su-ptable-code">
                          <code>{row.name}</code>
                          {row.api !== "graph" ? <span className="su-ptable-api">{row.apiLabel}</span> : null}
                          {row.type === "delegated" ? <span className="su-ptable-api" title="Used while signed in as a Keel service account">Delegated</span> : null}
                        </span>
                      </td>
                      <td data-label="Used for">{row.usedFor}</td>
                      <td data-label="Status">
                        <span className="su-ptable-status">
                          <Badge tone={PERMISSION_STATUS_TONES[row.status]}>{PERMISSION_STATUS_LABELS[row.status]}</Badge>
                          <RowAction app={appEntry} arm={arm} row={row} />
                        </span>
                      </td>
                    </tr>
                  ))}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      ) : (
        <NoMatches filters={filters} noun={NOUN} />
      )}
      <ListPager label="Permissions" noun={NOUN} paging={paging} total={shown.length} />
    </section>
  );
}

// The one thing to do about a row, right beside it: approve a missing or optional
// permission, add it to the app first when consent cannot grant it, or assign a role.
function RowAction({ row, app, arm }: { row: PermissionRow; app: { consent: string | null; entra: string | null }; arm: () => void }) {
  if (row.status !== "missing" && row.status !== "optional") return null;
  if (row.type === "admin-role") {
    const href = roleLink(row);
    return href ? (
      <a className="su-inline-link" href={href} onClick={arm} rel="noreferrer" target="_blank">
        {row.api === "intune" ? "Assign in Intune" : "Assign in Entra ID"}
        <span className="visually-hidden"> {row.name} (opens in a new tab)</span>
      </a>
    ) : null;
  }
  const href = row.requested === false ? app.entra : app.consent ?? app.entra;
  if (!href) return null;
  return (
    <a className="su-inline-link" href={href} onClick={arm} rel="noreferrer" target="_blank">
      {row.requested === false || !app.consent ? "Add in Entra ID" : "Approve"}
      <span className="visually-hidden"> {row.words} (opens in a new tab)</span>
    </a>
  );
}

function CopyNames({ names }: { names: string[] }) {
  async function copy() {
    try {
      await navigator.clipboard.writeText(names.join("\n"));
      toast({ title: "Microsoft names copied" });
    } catch {
      toast({ tone: "warning", title: "Could not copy", detail: "Your browser blocked the clipboard. The Microsoft names are in the table." });
    }
  }
  return <button className="btn" onClick={copy} type="button"><Icon name="page" />Copy Microsoft names</button>;
}
