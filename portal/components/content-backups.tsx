import { Icon, type IconName } from "@/components/shell/icons";
import { RecordField, RecordGroup, TechnicalDetails } from "@/components/technical-details";
import { ShowDetails } from "@/components/ui/alert-list";
import { Badge } from "@/components/ui/badge";
import {
  NOT_BACKED_UP,
  STATE_BADGE,
  contentHeadline,
  contentRows,
  holdingLine,
  lastRunAt,
  runLine,
  runReasons,
  runScope,
  runSkipped,
  scopeSentence,
  scopeWords,
  skippedLine,
  storageNote,
  type ContentBackupsData,
  type ContentRow,
} from "@/lib/content-backups-view";
import { ago, formatTimestamp } from "@/lib/presentation";

// What's protected: the nightly content backup, one row per workload (mail, OneDrive,
// SharePoint, Teams, Planner) with what Keel holds, how the last run went and which
// names it read. Workload codes and run ids sit under Technical details.

const HEADING_ID = "content-backups-heading";

const ICONS: Record<string, IconName> = {
  "exchange-mail": "service-exchange",
  onedrive: "cloud",
  "sharepoint-sites": "service-sharepoint",
  teams: "service-teams",
  planner: "calendar",
};

function Row({ row, now, prefix }: { row: ContentRow; now: string; prefix: string | null | undefined }) {
  const badge = STATE_BADGE[row.state];
  const line = runLine(row);
  const problem = row.state === "failed" || row.state === "partial";
  const at = row.latest?.at ?? row.newestAt;
  const disk = storageNote(row);
  const skipped = skippedLine(row);
  return (
    <li className="activity-item list-row content-row" data-tone={problem ? badge.tone : undefined}>
      <span aria-hidden="true" className="row-kind"><Icon name={ICONS[row.workload.code] ?? "backup"} /></span>
      <span className="row-name">
        <span className="content-row-title">{row.workload.name}</span>
        <small>{row.workload.what}</small>
        <small>{scopeWords(row.workload, prefix)}</small>
        {line ? <small className={problem ? "job-error-line" : undefined}>{line}</small> : null}
        {problem ? <ShowDetails lines={runReasons(row).map((reason) => <code className="ui-raw-error" key={reason}>{reason}</code>)} /> : null}
        {skipped ? <small>{skipped}</small> : null}
        {skipped ? <ShowDetails lines={runSkipped(row).map((line) => <code className="ui-raw-error" key={line}>{line}</code>)} /> : null}
      </span>
      <span className="row-mid">
        <span className="row-status"><Badge tone={badge.tone}>{badge.label}</Badge></span>
        <span className="row-meta">
          <span>{holdingLine(row)}</span>
          {at ? <>
            <span aria-hidden="true">·</span>
            <time dateTime={at} title={formatTimestamp(at)}>{row.latest ? `last run ${ago(at, now)}` : `stored ${ago(at, now)}`}</time>
          </> : null}
        </span>
        {disk ? <span className="row-meta">{disk}</span> : null}
      </span>
    </li>
  );
}

export function ContentBackupsView({ data, now }: { data: ContentBackupsData; now: string }) {
  const rows = contentRows(data, now);
  const prefix = runScope(data);
  const scope = scopeSentence(prefix);
  const last = lastRunAt(rows);
  return (
    <section aria-labelledby={HEADING_ID} className="report-section job-list content-backups">
      <div className="section-heading-row report-heading">
        <div>
          <p className="section-kicker">Content</p>
          <h2 id={HEADING_ID}>Mail, files, sites, Teams and Planner</h2>
        </div>
        <span className="section-aside">
          {last ? <time dateTime={last} title={formatTimestamp(last)}>last run {ago(last, now)}</time> : <span>Nightly at 01:00 UTC</span>}
        </span>
      </div>
      <p>{contentHeadline(rows)}</p>
      {scope ? <p className="activity-meta">{scope}</p> : null}
      <ul className="activity-list">
        {rows.map((row) => <Row key={row.workload.code} now={now} prefix={prefix} row={row} />)}
      </ul>
      <p className="activity-meta">{NOT_BACKED_UP}</p>
      <TechnicalDetails summary="Technical details for content backups">
        {rows.map((row) => (
          <RecordGroup key={row.workload.code} note={row.workload.holds.join(", ")} title={row.workload.name}>
            <RecordField copy={false} label="Stored as" value={row.workload.holds.join(", ")} />
            <RecordField copy={false} label="Items · versions · containers" value={`${row.items} · ${row.versions} · ${row.containers}`} />
            <RecordField copy={false} label="Bytes held · bytes on disk" value={`${row.bytes} · ${row.storedBytes}`} />
            <RecordField label="Last run" value={row.latest ? `${row.latest.outcome} · ${row.latest.at ?? "no time"} · ${row.latest.id}` : null} />
            <RecordField label="Last good run" value={row.lastGood ? `${row.lastGood.at ?? "no time"} · ${row.lastGood.id}` : null} />
            {row.latest?.reasons.length ? <RecordField copy={false} label="Reasons" value={row.latest.reasons.join("\n")} /> : null}
          </RecordGroup>
        ))}
      </TechnicalDetails>
    </section>
  );
}

/** The page's section: `data` undefined when the content backups could not be read. */
export function ContentBackups({ data, now }: { data: ContentBackupsData | undefined; now: string }) {
  if (data === undefined) return <p className="action-error">Keel could not read the content backups. Reload in a minute.</p>;
  return <ContentBackupsView data={data} now={now} />;
}
