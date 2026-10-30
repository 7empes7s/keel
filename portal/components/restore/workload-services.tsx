"use client";

import { useState } from "react";

import { Icon } from "@/components/shell/icons";
import { RecordField, RecordGroup, TechnicalDetails, type RecordValue } from "@/components/technical-details";
import {
  groupWorkloadsByService,
  startsFromPage,
  workloadBackupLine,
  workloadRestoreBadge,
  type RestoreWorkload,
} from "@/lib/restore-workloads-view";
import { serviceFor, serviceOrder } from "@/lib/services";
import { WorkloadRestore } from "@/components/restore/workload-restore";

// The Restore page without a tenant backup yet: every kind of setting KEEL backs up on
// its own, under its Microsoft service, each with its backup and how it is put back.
// With a tenant backup the same kinds sit inside the services of the main list instead.
export function WorkloadServices({ workloads, now, canRestore = false, canApprove = false }: {
  workloads: RestoreWorkload[] | null;
  now: string;
  canRestore?: boolean;
  canApprove?: boolean;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const heading = (
    <div className="section-heading-row report-heading">
      <h2 id="restore-services-heading">Microsoft 365 services</h2>
    </div>
  );
  if (workloads === null) {
    return (
      <section aria-labelledby="restore-services-heading" className="report-section restore-services">
        {heading}
        <p className="action-error">KEEL could not read the backups of these services. Reload in a minute.</p>
      </section>
    );
  }
  const groups = groupWorkloadsByService(workloads, serviceOrder);
  const openWorkload = workloads.find((workload) => workload.workload === open) ?? null;
  return (
    <section aria-labelledby="restore-services-heading" className="report-section restore-services">
      {heading}
      {groups.length === 0 ? (
        <p className="empty-state">No other services to show yet.</p>
      ) : (
        <div className="restore-services-grid">
          {groups.map((group) => {
            const service = serviceFor(group.service);
            const headingId = `restore-service-${service.code.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
            return (
              <section aria-labelledby={headingId} className="restore-service" key={service.code}>
                <header className="restore-service-head">
                  <span className="restore-service-icon"><Icon name={service.icon} /></span>
                  <h3 id={headingId}>{service.name}</h3>
                </header>
                <WorkloadKinds canRestore={canRestore} now={now} onStart={setOpen} open={open} workloads={group.workloads} />
              </section>
            );
          })}
        </div>
      )}
      {openWorkload ? (
        <WorkloadRestore
          canApprove={canApprove}
          canRestore={canRestore}
          key={openWorkload.workload}
          name={openWorkload.name}
          now={now}
          onClose={() => setOpen(null)}
          workload={openWorkload.workload}
        />
      ) : null}
    </section>
  );
}

/** One service's kinds of setting backed up on their own, in order, one card each. */
export function WorkloadKinds({ workloads, now, canRestore, open, onStart }: {
  workloads: RestoreWorkload[];
  now: string;
  canRestore: boolean;
  open: string | null;
  onStart: (workload: string) => void;
}) {
  return (
    <ul className="restore-workloads">
      {workloads.map((workload) => (
        <WorkloadCard
          key={workload.workload}
          now={now}
          onStart={canRestore && startsFromPage(workload) ? () => onStart(workload.workload) : null}
          open={open === workload.workload}
          workload={workload}
        />
      ))}
    </ul>
  );
}

export function WorkloadCard({ workload, now, onStart, open }: { workload: RestoreWorkload; now: string; onStart: (() => void) | null; open: boolean }) {
  const backup = workloadBackupLine(workload, now);
  const badge = workloadRestoreBadge(workload);
  return (
    <li className="restore-workload">
      <div className="restore-workload-head">
        <b>{workload.name}</b>
        <span className="restore-chip" data-tone={badge.tone}>{badge.text}</span>
      </div>
      <p className="restore-workload-backup" data-tone={backup.tone}>
        <span aria-hidden="true" className="restore-workload-dot" />
        {backup.text}.
      </p>
      {/* Kept but not put back by KEEL: where a person makes the change instead. */}
      {badge.tone === "soon" ? <p className="restore-workload-todo">{workload.todo}</p> : null}
      {onStart ? (
        <button aria-expanded={open} className={open ? "btn btn-sm" : "btn restore-workload-start"} onClick={onStart} type="button">
          {open ? "Choosing below" : "Choose what to put back"}
        </button>
      ) : null}
      <TechnicalDetails>
        <RecordField label="Workload" value={workload.workload} />
        <RecordField copy={false} label="Service code" value={workload.service} />
        <RecordField copy={false} label="Reads" value={workload.reads} />
        {workload.writes.length ? <RecordField copy={false} label="Writes" value={workload.writes as unknown as RecordValue} /> : null}
        {workload.backup ? (
          <RecordGroup note={workload.backup.partial ? "partial" : "complete"} title="Newest backup with settings">
            <RecordField label="Backup (collection) ID" value={workload.backup.collectionId} />
            <RecordField copy={false} label="Taken" value={workload.backup.takenAt} />
            <RecordField copy={false} label="Items" value={workload.backup.items} />
            <RecordField copy={false} label="Partial" value={workload.backup.partial} />
          </RecordGroup>
        ) : null}
        {workload.lastRun ? (
          <RecordGroup note={workload.lastRun.outcome} title="Newest run">
            <RecordField label="Collection ID" value={workload.lastRun.collectionId} />
            <RecordField copy={false} label="Outcome" value={workload.lastRun.outcome} />
            <RecordField copy={false} label="At" value={workload.lastRun.at} />
            {workload.lastRun.reasons.map((reason, index) => <RecordField copy={false} key={`${index}:${reason}`} label="Reason" value={reason} />)}
          </RecordGroup>
        ) : null}
      </TechnicalDetails>
    </li>
  );
}
