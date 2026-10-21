"use client";

import Link from "next/link";

import { DetailsSheet } from "@/components/baselines/details-sheet";
import { BackupRecord } from "@/components/incidents/incident-record";
import { Icon } from "@/components/shell/icons";
import { Badge } from "@/components/ui/badge";
import { Person } from "@/components/ui/person";
import {
  KEPT_HELP, STATES, backupName, backupWhy, exclusionLabel, personOf, restoreHref, stateChip, stateOf,
} from "@/lib/incidents-view";
import type { IncidentDetail, IncidentRecoveryPoint } from "@/lib/portal-data";
import { ago, formatTimestamp } from "@/lib/presentation";

export type BackupStep = "check" | "keep" | "release" | "allow" | "withdraw";

// One backup, opened from its row (`?open=<snapshotId>`): why it is in its state, the
// investigator's check and reason, what a restore leaves out, whether it is kept and
// whether a restore was allowed anyway; then every action, and its record last.
export function BackupSheet({ detail, point, now, canChange, stepHref, onStep, onClose }: {
  detail: IncidentDetail;
  point: IncidentRecoveryPoint;
  now: string;
  canChange: boolean;
  stepHref: (step: BackupStep) => string;
  onStep: (step: BackupStep) => void;
  onClose: () => void;
}) {
  const state = stateOf(point);
  const words = STATES[state];
  const recommended = detail.recommended === point.snapshotId;
  const pin = detail.pins.find((entry) => entry.snapshotId === point.snapshotId) ?? null;
  const override = detail.overrides?.find((entry) => entry.snapshotId === point.snapshotId) ?? null;
  const assessment = point.assessment;
  const open = detail.incident.status === "open";
  const step = (name: BackupStep, label: string) => (
    <Link className="btn" href={stepHref(name)} onClick={(event) => { if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return; event.preventDefault(); onStep(name); }}>{label}</Link>
  );

  return (
    <DetailsSheet
      footer={<>
        {state === "cleared" ? (
          <Link className={open && recommended ? "btn btn-primary" : "btn"} href={restoreHref(point.snapshotId, detail.incident.id)}><Icon name="restore" />Restore from this backup</Link>
        ) : override ? (
          <Link className="btn" href={restoreHref(point.snapshotId, detail.incident.id)}><Icon name="restore" />Restore anyway</Link>
        ) : (
          <button className="btn" disabled title="An investigator must allow it first" type="button"><Icon name="restore" />Restore anyway</button>
        )}
        {canChange ? <>
          {step("check", assessment ? "Record a new check" : "Record your check")}
          {pin ? step("release", "Let clean-up remove it") : step("keep", "Keep this backup")}
          {state !== "cleared" ? (override ? step("withdraw", "Withdraw permission") : step("allow", "Allow a restore from this backup")) : null}
        </> : null}
        <p className="bl-help">
          {state !== "cleared" && !override ? "A restore from it needs an investigator to allow it first. " : ""}
          {KEPT_HELP}
        </p>
      </>}
      kicker={<span className="ir-kicker"><Icon name="backup" />Backup</span>}
      onClose={onClose}
      title={backupName(point)}
    >
      <div className="ir-sheet">
        <div className="ir-chips">
          <Badge icon={words.icon} tone={point.stale ? "soon" : words.tone}>{stateChip(point)}</Badge>
          {recommended ? <Badge icon="star" tone="low">Recommended</Badge> : null}
          {point.inCompromiseWindow ? <Badge icon="alert" tone="urgent">Taken during the attack</Badge> : null}
          {override ? <Badge icon="check" tone="low">Restore allowed</Badge> : null}
        </div>
        <p>{backupWhy(point, detail, now)}</p>
        <dl className="ir-facts">
          <div><dt>Taken</dt><dd>{formatTimestamp(point.observedTo ?? point.observedFrom)}</dd></div>
          {assessment ? (
            <div>
              <dt>{state === "unsafe" ? "Marked unsafe by" : "Checked by"}</dt>
              <dd><Person person={personOf(assessment.assessedBy)} />, <time dateTime={assessment.assessedAt ?? undefined} title={formatTimestamp(assessment.assessedAt)}>{ago(assessment.assessedAt, now)}</time></dd>
            </div>
          ) : (
            <div><dt>Checked</dt><dd>{point.stale ? "Needs a new check" : "Nobody has checked it yet"}</dd></div>
          )}
          {assessment?.rationale ? <div><dt>Why</dt><dd className="ir-quote">“{assessment.rationale}”</dd></div> : null}
          {assessment?.exclusions.length ? (
            <div>
              <dt>Left out</dt>
              <dd>
                <ul className="ir-left-out">
                  {assessment.exclusions.map((exclusion) => (
                    <li key={`${exclusion.naturalKey}#${exclusion.field ?? ""}`}><b>{exclusionLabel(exclusion)}</b>: {exclusion.reason}</li>
                  ))}
                </ul>
              </dd>
            </div>
          ) : null}
          <div>
            <dt>Kept</dt>
            <dd>{pin ? <>Kept from clean-up by <Person person={personOf(pin.pinnedBy)} />: “{pin.reason}”</> : "Removed by routine clean-up when due"}</dd>
          </div>
          {override ? (
            <div>
              <dt>Restore allowed</dt>
              <dd>By <Person person={personOf(override.authorizedBy)} />{override.authorizedAt ? `, ${ago(override.authorizedAt, now)}` : ""}: “{override.reason}”</dd>
            </div>
          ) : null}
        </dl>
        <BackupRecord override={override} pin={pin} point={point} />
      </div>
    </DetailsSheet>
  );
}
