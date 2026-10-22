import Link from "next/link";
import type { ReactNode } from "react";

import { PagedRows } from "@/components/list/paged-rows";
import { RecordField, RecordGroup, TechnicalDetails } from "@/components/technical-details";
import { ago, formatTimestamp } from "@/lib/presentation";
import {
  appName, partProblem, rolesLabel, siteAddress, siteLine, siteName,
  type PermissionPart, type SitePermissions, type SitePermissionsData, type SitesRun,
} from "@/lib/site-permissions-view";

// Gap 2 of the site permissions audit: each SharePoint site's stored permissions. The
// list answers "which sites let which apps in"; a site's own page names each grant.
// Site, app and grant ids sit under Technical details.

function ReadTime({ run, now }: { run: SitesRun; now: string }) {
  return (
    <span className="result-count">
      <time dateTime={run.observedTo} title={formatTimestamp(run.observedTo)}>read {ago(run.observedTo, now)}</time>
    </span>
  );
}

function NewerRead({ latest, now }: { latest: SitesRun | null; now: string }) {
  if (!latest) return null;
  const what = latest.outcome === "disabled" ? "was switched off" : "failed";
  return <p className="action-error">{`The newest SharePoint read ${what} ${ago(latest.observedTo, now)}, so what is shown may be out of date.`}</p>;
}

export function SiteList({ data }: { data: SitePermissionsData }) {
  const { run, sites } = data;
  return (
    <section aria-labelledby="sites-heading" className="report-section">
      <div className="section-heading-row report-heading">
        <div>
          <p className="section-kicker">SharePoint</p>
          <h2 id="sites-heading">Sites</h2>
        </div>
        {run ? <ReadTime now={data.generatedAt} run={run} /> : null}
      </div>
      <NewerRead latest={data.latest} now={data.generatedAt} />
      {run?.capped ? <p className="action-error">{`The read stops after ${sites.length.toLocaleString("en-GB")} sites, so sites beyond that are not listed.`}</p> : null}
      {!run ? <p className="empty-state">No SharePoint read has stored any sites yet. Sites appear here after the daily SharePoint read.</p> : null}
      {run && !sites.length ? <p className="empty-state">The last read found no sites.</p> : null}
      {sites.length ? (
        <PagedRows
          label="Sites"
          listClassName="item-list site-list"
          noun={{ one: "site", many: "sites" }}
          prefix=""
          rows={sites.map((site) => ({
            id: site.siteId,
            node: (
              <li className="item-card site-card">
                <div className="item-card-head">
                  <Link className="text-link" href={`/sites/${encodeURIComponent(site.siteId)}`}><strong>{siteName(site)}</strong></Link>
                </div>
                {siteAddress(site) ? <p className="field-help site-address">{siteAddress(site)}</p> : null}
                <p className="site-line">{siteLine(site)}</p>
              </li>
            ),
            text: `${siteName(site)} ${siteAddress(site) ?? ""} ${siteLine(site)}`,
            values: { name: siteName(site), apps: site.appGrants.entries?.length ?? -1 },
          }))}
          sorts={[{ key: "name", label: "Name" }, { key: "apps", label: "Apps with access", desc: true }]}
        />
      ) : null}
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

function PartSection<T>({ id, kicker, title, part, what, children }: {
  id: string;
  kicker: string;
  title: string;
  part: PermissionPart<T>;
  what: string;
  children: (entries: T[]) => ReactNode;
}) {
  const problem = partProblem(part.status, what);
  return (
    <section aria-labelledby={id} className="report-section">
      <div className="section-heading-row report-heading">
        <div>
          <p className="section-kicker">{kicker}</p>
          <h2 id={id}>{title}</h2>
        </div>
        {part.entries ? <span className="result-count">{part.entries.length.toLocaleString("en-GB")}</span> : null}
      </div>
      {problem ? <p className={part.status === "not-read" ? "empty-state" : "action-error"}>{problem}</p> : null}
      {part.entries && !part.entries.length ? <p className="empty-state">{`No ${what} on this site.`}</p> : null}
      {part.entries?.length ? children(part.entries) : null}
      {part.httpStatus !== null ? (
        <TechnicalDetails>
          <RecordField copy={false} label="Read status" value={part.status} />
          <RecordField copy={false} label="Microsoft answered (HTTP status)" value={part.httpStatus} />
        </TechnicalDetails>
      ) : null}
    </section>
  );
}

export function SiteDetail({ site, run, latest, now }: { site: SitePermissions; run: SitesRun; latest: SitesRun | null; now: string }) {
  return (
    <>
      <Link className="text-link back-link" href="/sites"><span aria-hidden="true">←</span> All sites</Link>
      <NewerRead latest={latest} now={now} />
      <PartSection id="site-apps-heading" kicker="Apps" part={site.appGrants} title="Apps with access" what="app grants">
        {(grants) => (
          <ul className="item-list">
            {grants.map((grant, index) => (
              <li className="item-card" key={grant.id ?? index}>
                <div className="item-card-head"><strong>{appName(grant)}</strong></div>
                <p className="site-line">{rolesLabel(grant.roles)}</p>
                <TechnicalDetails>
                  <RecordField label="Grant" value={grant.id} />
                  {grant.applications.map((application, position) => (
                    <RecordField key={application.id ?? position} label="App" value={application.id} />
                  ))}
                  <RecordField copy={false} label="Roles as stored" value={grant.roles.length ? grant.roles : null} />
                </TechnicalDetails>
              </li>
            ))}
          </ul>
        )}
      </PartSection>
      {site.groups.status === "not-read" && site.roleAssignments.status === "not-read" ? (
        <section aria-labelledby="site-people-heading" className="report-section">
          <div className="section-heading-row report-heading">
            <div>
              <p className="section-kicker">People</p>
              <h2 id="site-people-heading">SharePoint groups and roles</h2>
            </div>
          </div>
          <p className="field-help">KEEL does not read this site&apos;s SharePoint groups or the roles given to people yet. They will show here once it does.</p>
        </section>
      ) : <>
        <PartSection id="site-groups-heading" kicker="People" part={site.groups} title="SharePoint groups" what="SharePoint groups">
          {(groups) => (
            <ul className="item-list">
              {groups.map((group, index) => (
                <li className="item-card" key={group.id ?? index}>
                  <div className="item-card-head"><strong>{group.name ?? "A group with no name"}</strong></div>
                  <p className="site-line">
                    {rolesLabel(group.roles)}
                    {group.members !== null ? ` · ${group.members.toLocaleString("en-GB")} ${group.members === 1 ? "member" : "members"}` : null}
                  </p>
                  {group.id ? (
                    <TechnicalDetails>
                      <RecordField label="Group" value={group.id} />
                      <RecordField copy={false} label="Roles as stored" value={group.roles.length ? group.roles : null} />
                      <RecordField copy={false} label="Members" value={group.members} />
                    </TechnicalDetails>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </PartSection>
        <PartSection id="site-roles-heading" kicker="People" part={site.roleAssignments} title="Roles given on this site" what="role assignments">
          {(assignments) => (
            <ul className="item-list">
              {assignments.map((assignment, index) => (
                <li className="item-card" key={assignment.id ?? index}>
                  <div className="item-card-head"><strong>{assignment.name ?? "Someone KEEL could not name"}</strong></div>
                  <p className="site-line">{rolesLabel(assignment.roles)}</p>
                  {assignment.id ? (
                    <TechnicalDetails>
                      <RecordField label="Assignment" value={assignment.id} />
                      <RecordField copy={false} label="Kind" value={assignment.kind} />
                      <RecordField copy={false} label="Roles as stored" value={assignment.roles.length ? assignment.roles : null} />
                    </TechnicalDetails>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </PartSection>
      </>}
      <section aria-labelledby="site-record-heading" className="report-section">
        <div className="section-heading-row report-heading">
          <div>
            <p className="section-kicker">Read</p>
            <h2 id="site-record-heading">Where this comes from</h2>
          </div>
          <ReadTime now={now} run={run} />
        </div>
        <p>KEEL reads site permissions from Microsoft once a day and keeps each read. Restoring app access to a site is a step done by hand.</p>
        <TechnicalDetails>
          <RecordField label="Site" value={site.siteId} />
          <RecordField label="Web address" value={site.webUrl} />
          <RecordField copy={false} label="Name as stored" value={site.displayName} />
          <RecordField label="SharePoint read" value={run.id} />
          <RecordField copy={false} label="Read outcome" value={run.outcome} />
          <RecordField copy={false} label="Read finished" value={run.observedTo} />
          {([["App grants", site.appGrants], ["SharePoint groups", site.groups], ["Role assignments", site.roleAssignments]] as const).map(([title, part]) => (
            <RecordGroup key={title} note={part.status} title={title}>
              <RecordField copy={false} label="Read status" value={part.status} />
              <RecordField copy={false} label="Microsoft answered (HTTP status)" value={part.httpStatus} />
              <RecordField copy={false} label="Entries" value={part.entries?.length ?? null} />
            </RecordGroup>
          ))}
        </TechnicalDetails>
      </section>
    </>
  );
}
