import Link from "next/link";
import type { ReactNode } from "react";

import { Icon, type IconName } from "@/components/shell/icons";
import { SitesTable } from "@/components/sites-table";
import { RecordField, RecordGroup, TechnicalDetails } from "@/components/technical-details";
import { Badge } from "@/components/ui/badge";
import { ago, formatTimestamp } from "@/lib/presentation";
import {
  appName, appStatus, backupStatus, backupWords, externalStatus, peopleStatus, roleLabel, rolesLabel, siteAddress,
  tenantSharingWords, type SitePermissions, type SitePermissionsData, type SiteStatus, type SitesContentRun, type SitesRun,
} from "@/lib/site-permissions-view";

// The Sites pages. The list is a compact table (components/sites-table.tsx) with
// problems first; a site's page leads with four status tiles (backup, apps, guests,
// owners), then compact tables of owners, groups and apps. Ids sit under Technical details.

function NewerRead({ latest, now }: { latest: SitesRun | null; now: string }) {
  if (!latest) return null;
  const what = latest.outcome === "disabled" ? "was switched off" : "failed";
  return <p className="action-error">{`The newest SharePoint read ${what} ${ago(latest.observedTo, now)}, so what is shown may be out of date.`}</p>;
}

function ReadNote({ run, contentRun, now }: { run: SitesRun; contentRun: SitesContentRun | null | undefined; now: string }) {
  return (
    <p className="st-footnote">
      Sites and app access are read every day (last <time dateTime={run.observedTo} title={formatTimestamp(run.observedTo)}>{ago(run.observedTo, now)}</time>).
      {" "}Backup, owners, groups and guests come from the nightly backup{contentRun ? <> (last <time dateTime={contentRun.completedAt} title={formatTimestamp(contentRun.completedAt)}>{ago(contentRun.completedAt, now)}</time>)</> : " (not run yet)"}.
    </p>
  );
}

export function SiteList({ data }: { data: SitePermissionsData }) {
  const { run, sites } = data;
  const sharing = tenantSharingWords(data.tenantSharing);
  return (
    <section aria-label="Sites" className="st-page">
      <NewerRead latest={data.latest} now={data.generatedAt} />
      {run?.capped ? <p className="action-error">{`The read stops after ${sites.length.toLocaleString("en-GB")} sites, so sites beyond that are not listed.`}</p> : null}
      {data.contentRun?.namePrefix ? (
        <p className="st-note" data-tone="soon" role="note"><Icon name="alert" /><span>The backup only takes sites whose names start with <b>{data.contentRun.namePrefix}</b>. Other sites are listed but not backed up.</span></p>
      ) : null}
      {!run ? <p className="empty-state">No SharePoint read has stored any sites yet. Sites appear here after the daily SharePoint read.</p> : null}
      {run && !sites.length ? <p className="empty-state">The last read found no sites.</p> : null}
      {sites.length ? <SitesTable now={data.generatedAt} run={data.contentRun ?? null} sites={sites} /> : null}
      {sharing ? <p className="st-footnote"><Icon name="link" /> Sharing allowed across the tenant: <b>{sharing}</b>.</p> : null}
      {run ? <ReadNote contentRun={data.contentRun} now={data.generatedAt} run={run} /> : null}
      {run ? (
        <TechnicalDetails>
          <RecordField label="SharePoint read" value={run.id} />
          <RecordField copy={false} label="Read outcome" value={run.outcome} />
          <RecordField copy={false} label="Read finished" value={run.observedTo} />
          <RecordField copy={false} label="Stopped at the site limit" value={run.capped ?? false} />
          {data.latest ? (
            <RecordGroup note={data.latest.outcome} title="Newer read">
              <RecordField label="SharePoint read" value={data.latest.id} />
              <RecordField copy={false} label="Read outcome" value={data.latest.outcome} />
              <RecordField copy={false} label="Read finished" value={data.latest.observedTo} />
            </RecordGroup>
          ) : null}
          <RecordField copy={false} label="Sites listed" value={sites.length} />
        </TechnicalDetails>
      ) : null}
    </section>
  );
}

function StatusTile({ icon, title, status, value, children }: { icon: IconName; title: string; status: SiteStatus; value?: ReactNode; children?: ReactNode }) {
  return (
    <div className="st-status" data-tone={status.tone}>
      <span className="st-status-label"><Icon name={icon} />{title}</span>
      <span className="st-status-value"><Badge tone={status.tone}>{status.label}</Badge>{value}</span>
      {status.detail ? <p>{status.detail}</p> : null}
      {children}
      {status.fix ? <Link className="btn btn-sm" href={status.fix.href}><Icon name="settings" />{status.fix.label}</Link> : null}
      {status.error ? (
        <details className="st-error">
          <summary>Show the error</summary>
          <p>{status.error}</p>
        </details>
      ) : null}
    </div>
  );
}

const plainRole = (role: string) => roleLabel(role);

export function SiteDetail({ site, run, latest, now, contentRun = null, tenantSharing = null }: {
  site: SitePermissions;
  run: SitesRun;
  latest: SitesRun | null;
  now: string;
  contentRun?: SitesContentRun | null;
  tenantSharing?: string | null;
}) {
  const backup = backupStatus(site, contentRun);
  const apps = appStatus(site);
  const people = peopleStatus(site, contentRun);
  const external = externalStatus(site) ?? { ...people, key: "unknown", detail: people.key === "pending" ? "Guests and sharing links are read with the nightly backup." : people.detail, fix: null, error: null };
  const held = backupWords(site);
  const sharing = tenantSharingWords(tenantSharing);
  const grants = site.appGrants.entries ?? [];
  const summary = site.people;
  return (
    <div className="st-page">
      <NewerRead latest={latest} now={now} />
      <section aria-label="This site at a glance" className="st-statuses">
        <StatusTile icon="backup" status={backup} title="Backup" value={backup.at ? <small><time dateTime={backup.at} title={formatTimestamp(backup.at)}>{ago(backup.at, now)}</time></small> : null}>
          {held ? <p className="st-status-fact">Holds {held}</p> : null}
        </StatusTile>
        <StatusTile icon="link" status={apps} title="Apps with access" />
        <StatusTile icon="person" status={external} title="Guests and sharing">
          {sharing ? <p className="st-status-fact">Tenant allows sharing with: {sharing}</p> : null}
        </StatusTile>
        <StatusTile icon="person" status={people} title="Owners">
          {summary?.owners.length ? <p className="st-status-fact">{summary.owners.slice(0, 3).join(", ")}{summary.ownerCount > 3 ? ` and ${summary.ownerCount - 3} more` : ""}</p> : null}
        </StatusTile>
      </section>

      {summary && summary.groups.length ? (
        <section aria-labelledby="site-groups-heading" className="st-section">
          <h2 id="site-groups-heading">Groups <span className="result-count">{summary.groups.length}</span></h2>
          {summary.inherits ? <p className="st-footnote">This site takes its access from its parent site, so the access levels below are the parent&apos;s.</p> : null}
          <div className="st-scroll">
            <table className="st-table st-table-small">
              <thead><tr><th scope="col">Group</th><th scope="col">Access</th><th scope="col">Members</th></tr></thead>
              <tbody>
                {summary.groups.map((group, index) => (
                  <tr key={`${group.name}-${index}`}>
                    <th data-label="Group" scope="row">{group.name ?? "A group with no name"}</th>
                    <td data-label="Access">{group.roles === null ? <span className="st-unknown">From the parent site</span> : group.roles.length ? group.roles.map(plainRole).join(", ") : <span className="st-unknown">No access of its own</span>}</td>
                    <td data-label="Members">{group.members === null ? <span className="st-unknown">Not read</span> : group.members.toLocaleString("en-GB")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {summary.uniqueLists ? <p className="st-footnote">{summary.uniqueLists === 1 ? "1 list or library has" : `${summary.uniqueLists} lists or libraries have`} its own access, different from the site&apos;s.</p> : null}
        </section>
      ) : null}

      {grants.length ? (
        <section aria-labelledby="site-apps-heading" className="st-section">
          <h2 id="site-apps-heading">Apps with access <span className="result-count">{grants.length}</span></h2>
          <div className="st-scroll">
            <table className="st-table st-table-small">
              <thead><tr><th scope="col">App</th><th scope="col">Access</th></tr></thead>
              <tbody>
                {grants.map((grant, index) => {
                  const full = grant.roles.some((role) => ["fullcontrol", "owner"].includes(role.toLowerCase()));
                  return (
                    <tr data-tone={full ? "soon" : undefined} key={grant.id ?? index}>
                      <th data-label="App" scope="row">{appName(grant)}</th>
                      <td data-label="Access">{full ? <Badge tone="soon">{rolesLabel(grant.roles)}</Badge> : rolesLabel(grant.roles)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <ReadNote contentRun={contentRun} now={now} run={run} />
      <TechnicalDetails>
        <RecordField label="Site" value={site.siteId} />
        <RecordField label="Web address" value={site.webUrl ?? siteAddress(site)} />
        <RecordField copy={false} label="Name as stored" value={site.displayName} />
        <RecordField label="SharePoint read" value={run.id} />
        <RecordField copy={false} label="Read outcome" value={run.outcome} />
        <RecordField copy={false} label="Read finished" value={run.observedTo} />
        <RecordGroup note={site.appGrants.status} title="App grants">
          <RecordField copy={false} label="Read status" value={site.appGrants.status} />
          <RecordField copy={false} label="Microsoft answered (HTTP status)" value={site.appGrants.httpStatus} />
          <RecordField copy={false} label="Entries" value={site.appGrants.entries?.length ?? null} />
          {grants.map((grant, index) => (
            <RecordGroup key={grant.id ?? index} title={appName(grant)}>
              <RecordField label="Grant" value={grant.id} />
              {grant.applications.map((application, position) => (
                <RecordField key={application.id ?? position} label="App" value={application.id} />
              ))}
              <RecordField copy={false} label="Roles as stored" value={grant.roles.length ? grant.roles : null} />
            </RecordGroup>
          ))}
        </RecordGroup>
      </TechnicalDetails>
    </div>
  );
}
