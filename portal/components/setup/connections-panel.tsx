"use client";

import { useState } from "react";

import { Icon } from "@/components/shell/icons";
import { Badge } from "@/components/ui/badge";
import {
  GRANT_LABELS, GRANT_TONES, connectionAlerts, grantsFromEarlierCheck, connectionGroups, connectionStatus, grantRows, grantSummary,
  type Connection,
} from "@/lib/connections-view";
import { ago, formatTimestamp } from "@/lib/presentation";
import { PERMISSION_WORDS, type SetupState } from "@/lib/setup-view";

// Setup's Connections list (delegated-access DESIGN 3.5, build step 3): every Keel app
// and service account in your tenant, grouped Required / Optional / Service accounts.
// Problems come first, as alerts and at the top of each group. Opening a row shows what
// the app should hold next to what it holds, with the difference highlighted. Read only:
// switching apps off, removing them and re-granting come in later steps.

export function ConnectionsPanel({ state }: { state: SetupState }) {
  const connections = state.connections ?? null;
  const catalog = state.permissions?.permissions ?? [];
  return (
    <section aria-labelledby="setup-connections-title" className="su-cn" id="setup-connections">
      <header className="su-pp-head">
        <h2 id="setup-connections-title"><Icon name="link" />Connections</h2>
        <p>The Keel apps in your tenant, what each one is for, and whether it works.</p>
      </header>
      {connections === null
        ? <p className="su-cn-note"><Icon name="info" />Keel could not read its connections just now. Press Check again in a minute.</p>
        : <ConnectionsBody catalog={catalog} connections={connections} hasPermissions={catalog.length > 0} now={state.generatedAt} />}
    </section>
  );
}

function ConnectionsBody({ connections, catalog, hasPermissions, now }: {
  connections: Connection[];
  catalog: NonNullable<SetupState["permissions"]>["permissions"];
  // The Permissions table below is shown, so its link has somewhere to go.
  hasPermissions: boolean;
  now: string;
}) {
  const alerts = connectionAlerts(connections, now);
  const groups = connectionGroups(connections, now);
  return <>
    {alerts.map((alert) => (
      <div className="su-pp-alert" data-tone={alert.tone} key={alert.id} role={alert.tone === "urgent" ? "alert" : "status"}>
        <span aria-hidden="true" className="su-pp-alert-icon"><Icon name={alert.tone === "urgent" ? "x-circle" : "clock"} /></span>
        <div className="su-pp-alert-body">
          <p className="su-pp-alert-title">{alert.text}</p>
          {hasPermissions ? <p><a className="su-inline-link" href="#setup-permissions">See the permissions</a></p> : null}
        </div>
      </div>
    ))}
    {groups.map((group) => (
      <div className="su-cn-group" key={group.key}>
        <h3 className="su-cn-group-title">
          {group.title}
          <small>{group.connections.length ? `${group.connections.length} · ${group.hint}` : group.hint}</small>
        </h3>
        {group.connections.length
          ? <ul className="su-cn-list">{group.connections.map((connection) => <ConnectionRow catalog={catalog} connection={connection} key={`${connection.id}:${connection.state}`} now={now} />)}</ul>
          : <p className="su-cn-empty">{group.empty}</p>}
      </div>
    ))}
  </>;
}

function ConnectionRow({ connection, catalog, now }: { connection: Connection; catalog: NonNullable<SetupState["permissions"]>["permissions"]; now: string }) {
  const status = connectionStatus(connection, now);
  const rows = grantRows(connection, catalog, PERMISSION_WORDS);
  const missing = rows.filter((row) => row.status === "missing").length;
  const earlier = grantsFromEarlierCheck(connection, now);
  // A row with something missing opens on its own (keyed by state, so a new problem
  // after Check again opens it too); the rest open on request.
  const [open, setOpen] = useState(missing > 0 && !earlier);
  const panelId = `su-cn-grants-${connection.id}`;
  const ended = connection.credentialExpiresAt !== null && Date.parse(connection.credentialExpiresAt) <= Date.parse(now);
  return (
    <li className="su-cn-row" data-problem={status.problem ? "true" : undefined} data-tone={status.tone}>
      <div className="su-cn-main">
        <span aria-hidden="true" className="su-cn-icon"><Icon name={connection.kind === "service-account" ? "person" : "service-keel"} /></span>
        <div className="su-cn-text">
          <span className="su-cn-name">{connection.name}</span>
          <span className="su-cn-purpose">{connection.purpose}</span>
        </div>
        <Badge tone={status.tone}>{status.label}</Badge>
      </div>
      <dl className="su-cn-facts">
        <div>
          <dt>Certificate</dt>
          <dd>
            {connection.credentialExpiresAt
              ? <>{ended ? "Ended" : "Ends"} {formatTimestamp(connection.credentialExpiresAt).replace(/,? \d{2}:\d{2}( UTC)?$/, "")}</>
              : "Not known"}
          </dd>
        </div>
        <div>
          <dt>Last checked</dt>
          <dd>{connection.observed ? ago(connection.observed.at, now) : "Not yet"}</dd>
        </div>
        <div>
          <dt>Permissions</dt>
          <dd data-missing={missing ? "true" : undefined}>{missing ? `${missing} missing · ${grantSummary(rows)}` : grantSummary(rows)}</dd>
        </div>
      </dl>
      {rows.length ? (
        <>
          <button aria-controls={open ? panelId : undefined} aria-expanded={open} className="su-cn-toggle" onClick={() => setOpen(!open)} type="button">
            <Icon name={open ? "up" : "down"} />{open ? "Hide permissions" : "Show permissions"}
          </button>
          {open && earlier ? <p className="su-cn-note"><Icon name="info" />From the check {ago(connection.observed!.at, now)}. Keel could not look again this time.</p> : null}
          {open ? (
            <table aria-label={`${connection.name}: wanted and granted`} className="su-cn-grants" id={panelId}>
              <thead>
                <tr><th scope="col">Permission or role</th><th scope="col">Keel wants it</th><th scope="col">In your tenant</th></tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr data-status={row.status} key={`${row.kind}:${row.name}`}>
                    <td>
                      <span className="su-cn-words">{row.words}</span>
                      {row.kind === "permission" && row.words !== row.name ? <code>{row.name}</code> : null}
                      {row.usedFor ? <small>{row.usedFor}</small> : null}
                    </td>
                    <td>{row.wanted ? "Yes" : "No"}</td>
                    <td><Badge tone={GRANT_TONES[row.status]}>{GRANT_LABELS[row.status]}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </>
      ) : null}
    </li>
  );
}
