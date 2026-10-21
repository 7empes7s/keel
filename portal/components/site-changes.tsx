import Link from "next/link";

import { BlastBadge, ChangeBadge } from "@/components/status-badge";
import { RecordField, TechnicalDetails } from "@/components/technical-details";
import { STATE_LABELS, STATE_TONES } from "@/lib/alerts-view";
import { ago, formatTimestamp } from "@/lib/presentation";
import { siteChangeLine, siteChangeName, waitingForReview, type SiteChangesData } from "@/lib/site-changes-view";

// Site permissions audit: SharePoint site settings that changed between two daily reads.
// They have no baseline, so they sit apart from the baseline changes; each one's alert
// is where a person acknowledges or resolves it.

export function SiteChanges({ data, now }: { data: SiteChangesData; now: string }) {
  const { changes } = data;
  const waiting = changes.filter(waitingForReview).length;
  return (
    <section aria-labelledby="site-changes-heading" className="report-section">
      <div className="section-heading-row report-heading">
        <div>
          <p className="section-kicker">SharePoint</p>
          <h2 id="site-changes-heading">Site permission changes</h2>
        </div>
        {changes.length ? <span className="result-count">{changes.length.toLocaleString("en-GB")}</span> : null}
      </div>
      <p className="field-help">
        {`KEEL compares each daily SharePoint read with the one before it. These are the sites whose settings changed in the last ${data.days} days, newest first. They are not measured against the baseline, so each stays open on the Alerts page until someone acknowledges or resolves it.`}
      </p>
      {!changes.length ? <p className="empty-state">{`No site settings changed in the last ${data.days} days.`}</p> : null}
      {waiting ? (
        <p>
          <Link className="text-link" href="/alerts">{`Review ${waiting === 1 ? "the open alert" : `the ${waiting.toLocaleString("en-GB")} open alerts`} on the Alerts page`}</Link>
        </p>
      ) : null}
      {changes.length ? (
        <ul className="item-list site-change-list">
          {changes.map((change) => (
            <li className="item-card site-change" key={change.id}>
              <div className="item-card-head">
                {change.siteId && change.changeType !== "removed"
                  ? <Link className="text-link" href={`/sites/${encodeURIComponent(change.siteId)}`}><strong>{siteChangeName(change)}</strong></Link>
                  : <strong>{siteChangeName(change)}</strong>}
              </div>
              <p className="site-line">{siteChangeLine(change)}</p>
              <p className="site-line">
                <ChangeBadge value={change.changeType} /> <BlastBadge value={change.blastRadius} />
                {change.alertState ? <> <span className={`pill pill-${STATE_TONES[change.alertState]}`}>{`Alert: ${STATE_LABELS[change.alertState].toLowerCase()}`}</span></> : null}
                {" "}
                <span className="result-count">
                  <time dateTime={change.seenAt} title={formatTimestamp(change.seenAt)}>seen {ago(change.seenAt, now)}</time>
                </span>
              </p>
              <TechnicalDetails>
                <RecordField label="Change" value={change.id} />
                <RecordField label="Resource" value={change.resourceKey} />
                <RecordField label="Site ID" value={change.siteId} />
                <RecordField copy={false} label="Change type" value={change.changeType} />
                <RecordField copy={false} label="Blast radius" value={change.blastRadius} />
                {change.fields.length ? change.fields.map((field) => <RecordField copy={false} key={field} label="Field as stored" value={field} />) : <RecordField copy={false} label="Field as stored" value={null} />}
                <RecordField copy={false} label="Seen" value={change.seenAt} />
                <RecordField label="SharePoint read" value={change.collectionId} />
                <RecordField label="Compared with read" value={change.previousCollectionId} />
                <RecordField label="Alert" value={change.alertId} />
                <RecordField copy={false} label="Alert state" value={change.alertState} />
              </TechnicalDetails>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
