import Link from "next/link";

import { Icon } from "@/components/shell/icons";
import { RecordField, TechnicalDetails } from "@/components/technical-details";
import {
  groupWorkloadsByService,
  workloadBackupLine,
  workloadRestoreChip,
  workloadSummary,
  workloadWriteNote,
  type RestoreWorkload,
} from "@/lib/restore-workloads-view";
import { serviceFor, serviceOrder } from "@/lib/services";

// The Restore page's other Microsoft 365 services: Exchange, SharePoint and OneDrive,
// Teams, Purview and Power Platform, one card per service. Each kind of setting says
// whether it is backed up, what KEEL can put back, and what a person does by hand.
export function WorkloadServices({ workloads, now }: { workloads: RestoreWorkload[] | null; now: string }) {
  if (workloads === null) {
    return (
      <section aria-labelledby="restore-services-heading" className="report-section restore-services">
        <div className="section-heading-row report-heading">
          <div>
            <p className="section-kicker">More services</p>
            <h2 id="restore-services-heading">Exchange, SharePoint, Teams, Purview and Power Platform</h2>
          </div>
        </div>
        <p className="action-error">KEEL could not read the backups of these services. Reload in a minute.</p>
      </section>
    );
  }
  const groups = groupWorkloadsByService(workloads, serviceOrder);
  return (
    <section aria-labelledby="restore-services-heading" className="report-section restore-services">
      <div className="section-heading-row report-heading">
        <div>
          <p className="section-kicker">More services</p>
          <h2 id="restore-services-heading">Exchange, SharePoint, Teams, Purview and Power Platform</h2>
        </div>
        <span className="result-count">{groups.length} {groups.length === 1 ? "service" : "services"}</span>
      </div>
      <p className="restore-services-summary">{workloadSummary(workloads)}</p>
      <div className="restore-services-note" role="note">
        <Icon name="info" />
        <p>
          These settings cannot be put back from this page yet. Your KEEL operator plans the restore, it comes
          to <Link href="/approvals">Approvals</Link> like any other, and nothing changes until someone approves it.
          KEEL only writes what has been proven on this tenant.
        </p>
      </div>
      <div className="restore-services-grid">
        {groups.map((group) => {
          const service = serviceFor(group.service);
          const headingId = `restore-service-${service.code.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
          return (
            <section aria-labelledby={headingId} className="restore-service" key={service.code}>
              <header className="restore-service-head">
                <span className="restore-service-icon"><Icon name={service.icon} /></span>
                <div>
                  <h3 id={headingId}>{service.name}</h3>
                  <p>{service.about}</p>
                </div>
              </header>
              <ul className="restore-workloads">
                {group.workloads.map((workload) => <WorkloadCard key={workload.workload} now={now} workload={workload} />)}
              </ul>
            </section>
          );
        })}
      </div>
    </section>
  );
}

function WorkloadCard({ workload, now }: { workload: RestoreWorkload; now: string }) {
  const backup = workloadBackupLine(workload, now);
  const chip = workloadRestoreChip(workload);
  return (
    <li className="restore-workload" data-restorable={workload.writes.length ? "yes" : "no"}>
      <div className="restore-workload-head">
        <b>{workload.name}</b>
        <span className="restore-chip" data-tone={chip.tone}>{chip.text}</span>
      </div>
      <p className="restore-workload-backup" data-tone={backup.tone}>
        <span aria-hidden="true" className="restore-workload-dot" />
        {backup.text}.
      </p>
      {workload.writes.length ? (
        <ul className="restore-workload-writes" aria-label={`What KEEL can put back for ${workload.name}`}>
          {workload.writes.map((write) => {
            const note = workloadWriteNote(write);
            return (
              <li key={`${write.verb}:${write.name}`}>
                <Icon name="check" />
                <span>
                  <strong>{write.verb}</strong> {write.name}
                  {note ? <small>{note}</small> : null}
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="restore-workload-none">KEEL cannot put this back yet.</p>
      )}
      <details className="restore-workload-more">
        <summary>What you do by hand</summary>
        <p>{workload.todo}</p>
      </details>
      <details className="restore-workload-more">
        <summary>What the backup holds</summary>
        <ul>
          {workload.reads.map((read) => <li key={read}>{read}</li>)}
        </ul>
      </details>
      <TechnicalDetails>
        <RecordField label="Workload" value={workload.workload} />
        {workload.backup ? <RecordField label="Backup (collection) ID" value={workload.backup.collectionId} /> : null}
        {workload.lastRun ? <RecordField copy={false} label={`Newest run · ${workload.lastRun.outcome}`} value={workload.lastRun.reasons.join("; ") || workload.lastRun.collectionId} /> : null}
      </TechnicalDetails>
    </li>
  );
}
