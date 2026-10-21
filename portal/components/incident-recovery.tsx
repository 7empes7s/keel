"use client";

import Link from "next/link";

import { RecordField, RecordGroup, TechnicalDetails } from "@/components/technical-details";
import type { ParsedExclusion } from "@/lib/incidents-view";
import type { IncidentRecoveryPoint } from "@/lib/portal-data";
import type { Ref } from "@/lib/types";

// The incident context a restore runs under, shown in the restore review. The
// Incidents page itself lives in components/incidents/; its words in
// lib/incidents-view.ts.
export type RecoveryPointStatus = IncidentRecoveryPoint["status"];

function PersonName({ person }: { person: Ref | null }) {
  if (!person) return <>someone no longer readable</>;
  return person.href ? <Link href={person.href}>{person.name}</Link> : <>{person.name}</>;
}

export interface IncidentRecoveryView {
  incidentTitle: string | null;
  authorizedBy: Ref | null;
  checks: { label: string; expectation: string }[];
}

/** The incident context a restore dry run was planned under, shown in its review. */
export function IncidentQualificationSummary({ context, view }: {
  context: {
    incidentId: string;
    qualification: "qualified" | "overridden";
    status: RecoveryPointStatus;
    reasons: string[];
    assessment: { id?: string; version: number; verdict: string; fingerprint?: string } | null;
    exclusions: ParsedExclusion[];
    override: { id?: string; reason: string; authorizedBy: string } | null;
    postRestoreChecks: { naturalKey: string; field: string | null; expectation: string }[];
  };
  view?: IncidentRecoveryView | null;
}) {
  const title = view?.incidentTitle ? `“${view.incidentTitle}”` : "this incident";
  const checks = view?.checks ?? [];
  return (
    <section aria-labelledby="incident-qualification-heading" className={`incident-qualification incident-qualification-${context.qualification}`}>
      <div data-layer="explanation">
        <h4 id="incident-qualification-heading">
          {context.qualification === "qualified"
            ? `This snapshot is cleared for ${title}.`
            : `This snapshot is ${context.status === "unsuitable" ? "marked unsafe" : "not checked"} for ${title}; an override allows it.`}
        </h4>
        {context.override ? (
          <p className="incident-override">
            Override approved by <PersonName person={view?.authorizedBy ?? null} />: {context.override.reason}
          </p>
        ) : null}
        {checks.length > 0 ? (
          <>
            <p>After the restore, KEEL reads the tenant again and fails the restore if any of these is still there:</p>
            <ul className="incident-exclusions">
              {checks.map((check) => (
                <li key={check.label}>{check.expectation === "absent" ? `${check.label} must be gone` : `${check.label} must not hold the malicious value`}</li>
              ))}
            </ul>
          </>
        ) : null}
        <p className="muted-value">If an investigator changes their check before the restore runs, the restore is blocked.</p>
      </div>
      <TechnicalDetails>
        <RecordField label="Incident ID" usage={<>use with <code>keel-restore --incident &lt;id&gt;</code></>} value={context.incidentId} />
        <RecordField copy={false} label="Recovery point state" value={context.status} />
        <RecordField copy={false} label="Qualification" value={context.qualification} />
        {context.reasons.map((reason, index) => <RecordField copy={false} key={`${index}:${reason}`} label="Engine reason" value={reason} />)}
        {context.assessment ? (
          <RecordGroup note={`version ${context.assessment.version}`} title="Investigator's check">
            <RecordField label="Assessment ID" value={context.assessment.id} />
            <RecordField copy={false} label="Assessment version" value={context.assessment.version} />
            <RecordField copy={false} label="Verdict" value={context.assessment.verdict} />
            {context.assessment.fingerprint ? <RecordField label="Assessment fingerprint" usage="bound into this plan's digest" value={context.assessment.fingerprint} /> : null}
          </RecordGroup>
        ) : null}
        {context.exclusions.map((exclusion) => (
          <RecordGroup key={`exclusion:${exclusion.naturalKey}#${exclusion.field ?? ""}`} note="left out of the restore" title={exclusion.naturalKey}>
            <RecordField label="Exclusion" value={exclusion.naturalKey} />
            <RecordField copy={false} label="Field path" value={exclusion.field} />
            <RecordField copy={false} label="Reason" value={exclusion.reason} />
          </RecordGroup>
        ))}
        {context.override ? (
          <RecordGroup title="Override">
            {context.override.id ? <RecordField label="Override ID" value={context.override.id} /> : null}
            <RecordField label="Authorized by (principal ID)" value={context.override.authorizedBy} />
            <RecordField copy={false} label="Reason" value={context.override.reason} />
          </RecordGroup>
        ) : null}
        {context.postRestoreChecks.map((check) => (
          <RecordGroup key={`check:${check.naturalKey}#${check.field ?? ""}`} note="post-restore check" title={check.naturalKey}>
            <RecordField label="Stored key" value={check.naturalKey} />
            <RecordField copy={false} label="Field path" value={check.field} />
            <RecordField copy={false} label="Expectation" value={check.expectation} />
          </RecordGroup>
        ))}
      </TechnicalDetails>
    </section>
  );
}
