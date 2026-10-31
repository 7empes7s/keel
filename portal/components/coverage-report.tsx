"use client";

import Link from "next/link";

import { Icon } from "@/components/shell/icons";
import { RecordField, TechnicalDetails } from "@/components/technical-details";
import { failureReason } from "@/lib/backup-failure";
import { ago, displayEnum, formatTimestamp } from "@/lib/presentation";
import {
  backupSentence,
  recoveryDecisionSentence,
  restoreOperations,
  restoreStanding,
  standingSentence,
  tierLabel,
} from "@/lib/protect-view";
import type { CoverageData, CoverageType, TypeExpansion, TypeQualification } from "@/lib/types";

// Coverage plan v3: the coverage state of a type and the parts a restore cannot
// bring back (engine/coverage/completeness.mjs, through qualificationFor). Older
// reports carry none and show nothing.
type CoverageState = "full" | "incomplete" | "microsoft-managed" | "not-readable";
interface TypeCompleteness {
  state: CoverageState;
  recreate: "keel" | "by-hand" | "none";
  why?: string;
  missing: { part: string; reason: string; perObject: boolean }[];
}

const STATE_SENTENCE: Record<CoverageState, string> = {
  full: "Full coverage: Keel restores this on its own and nothing is missing.",
  incomplete: "Incomplete: the backup holds everything Keel can read, but some parts must be finished by hand after a restore.",
  "microsoft-managed": "Microsoft-managed: Microsoft owns this, so there is nothing to restore.",
  "not-readable": "Not readable: Keel cannot read this.",
};

const REASON_WORDS: Record<string, string> = {
  secret: "Microsoft never returns it",
  "read-only": "no tool can write it",
  "binary-route": "a file the backup does not hold",
  "other-route": "stored separately and not in the backup yet",
  "microsoft-managed": "set by Microsoft",
  "not-written": "in the backup, but Keel does not write it yet",
};

function completenessOf(item: CoverageType): TypeCompleteness | null {
  return (item.qualification as (TypeQualification & { completeness?: TypeCompleteness }) | null | undefined)?.completeness ?? null;
}

function missingWords(completeness: TypeCompleteness): string[] {
  return completeness.missing.map((part) => `${part.part} (${REASON_WORDS[part.reason] ?? part.reason})${part.perObject ? ", listed per object in each backup" : ""}`);
}

// Roadmap task-131, rebuilt for the portal audit (What's protected, pick B): one details
// panel per kind answers "can Keel put this back?" in one sentence; every task-54
// evidence field (collector, endpoint, pagination evidence, diagnosis, projection review,
// proof reference, credential mode, observation) is kept, labelled, in its record.
function observationQuery(item: CoverageType) {
  const observation = item.observation;
  return new URLSearchParams({
    observationId: observation?.observationId ?? "",
    resourceType: item.type,
    startedAt: observation?.window?.startedAt ?? "",
    endedAt: observation?.window?.endedAt ?? "",
  }).toString();
}

function endpointValue(path: string | null | undefined, version: string | null | undefined, source: string): string | null {
  return path ? `${path} (${version ?? "unknown version"}, ${source})` : null;
}

// Roadmap task-108: which subtypes the registered writes are limited to. An older
// report without the field reads "not recorded", never "not limited".
function subtypeValue(expansion: TypeExpansion | null | undefined): string {
  const subtypes = expansion?.qualifiedSubtypes;
  if (!expansion || subtypes === undefined) return "not recorded";
  if (expansion.restoreScope === "none") return "no writes registered";
  if (subtypes.length === 0) return "not limited by subtype";
  return `${subtypes.join(", ")} only · every other subtype, including built-in policies, is refused`;
}

// Roadmap task-109: what cannot be recovered for the type, configuration and
// relationships alike, one entry per line. An older report or an unassessed type
// reads "not assessed", never "nothing".
function unrecoverableValue(expansion: TypeExpansion | null | undefined): string {
  const items = expansion?.unrecoverable;
  if (!expansion || items === undefined || items === null) return "not assessed";
  if (items.length === 0) return "none recorded";
  return items.map((item) => `${item.kind} ${item.name}: ${item.reason}`).join(" · ");
}

/** Every recorded field of one kind, for a Technical details list. */
export function TypeRecordFields({ item }: { item: CoverageType }) {
  const irrecoverable = item.irrecoverableFields ?? null;
  const detail = item.detail;
  const decision = item.qualification;
  const completeness = completenessOf(item);
  return (
    <>
      <RecordField label="Configuration type" value={item.type} />
      <RecordField
        label="Coverage state"
        value={completeness ? `${completeness.state} · recreate ${completeness.recreate}${completeness.missing.length ? ` · missing ${completeness.missing.map((part) => `${part.part} [${part.reason}]`).join(", ")}` : ""}` : "not recorded"}
        copy={false}
      />
      <RecordField label="Protection state" value={`${item.protectionState} · report ${item.reportStatus} · outcome ${item.outcome ?? "none"}`} copy={false} />
      <RecordField label="Serving adapter" value={item.adapter} />
      <RecordField label="Declared endpoint" value={endpointValue(item.declaredEndpoint?.path, item.declaredEndpoint?.apiVersion, "declared") ?? "unknown"} copy={false} />
      <RecordField label="Measured endpoint" value={endpointValue(detail?.endpoint, detail?.apiVersion, "measured") ?? "not recorded"} copy={false} />
      <RecordField
        label="Pagination evidence"
        value={detail?.pagesCompleted === null || detail?.pagesCompleted === undefined ? "unknown"
          : `${detail.pagesCompleted.toLocaleString("en-GB")} page${detail.pagesCompleted === 1 ? "" : "s"} completed`}
        copy={false}
      />
      {detail && (detail.httpStatus !== null || detail.graphCode || detail.message) ? (
        <RecordField label="Last read error" value={[detail.httpStatus, detail.graphCode, detail.message].filter((part) => part !== null && part !== "").join(" · ")} copy={false} />
      ) : null}
      <RecordField
        label="Prerequisite diagnosis"
        value={item.diagnosis ? `${item.diagnosis.diagnosis}${item.diagnosis.reason ? ` · ${item.diagnosis.reason}` : ""}` : "not diagnosed"}
        copy={false}
      />
      <RecordField label="Relationship completeness" value={`${item.relationshipCompleteness ?? "unknown"} · no relationship collection exists yet`} copy={false} />
      <RecordField
        label="Irrecoverable fields"
        value={irrecoverable === null ? "unknown" : irrecoverable.length === 0 ? "none declared" : irrecoverable.join(", ")}
        copy={false}
      />
      <RecordField
        label="Fidelity"
        value={`declared ${item.fidelity.declared ?? "none"} · measured ${item.fidelity.measured ?? "not drill-verified"}${item.fidelity.verifiedAt ? ` at ${item.fidelity.verifiedAt}` : ""}`}
        copy={false}
      />
      <RecordField
        label="Recovery decision"
        value={decision ? `${decision.decision}${decision.reason ? ` · ${decision.reason}` : ""}${decision.softRestoreCandidate ? " · soft-delete restore is a candidate, not yet qualified" : ""}` : "unknown"}
        copy={false}
      />
      <RecordField
        label="Expansion batch"
        value={decision?.expansion
          ? `${decision.expansion.batchLabel} · ${decision.expansion.status} · restore scope ${decision.expansion.restoreScope} · ${decision.expansion.reason}`
          : "not recorded"}
        copy={false}
      />
      <RecordField
        label="Write subtypes"
        value={subtypeValue(decision?.expansion)}
        copy={false}
      />
      <RecordField
        label="Cannot be recovered"
        value={unrecoverableValue(decision?.expansion)}
        copy={false}
      />
      {decision ? Object.entries(decision.remapping).map(([operation, proven]) => (
        <RecordField copy={false} key={operation} label={`Remapping · ${operation}`} value={proven ? "proven" : "not proven, refused when an id changes"} />
      )) : null}
      {item.writeCapability ? Object.entries(item.writeCapability.operations).flatMap(([operation, capability]) => [
        <RecordField copy={false} key={`${operation}-claim`} label={`Write · ${operation}`}
          value={`${capability.claim} · projection review ${capability.projection} · credential mode ${capability.credentialMode ?? "unknown"}${capability.idOutcome ? ` · id ${capability.idOutcome}` : ""}`} />,
        <RecordField key={`${operation}-proof`} label={`Proof reference · ${operation}`} value={capability.proofRef ?? "unknown"} />,
      ]) : <RecordField label="Write capability" value="unknown" copy={false} />}
      <RecordField label="Criticality" value={item.criticality ?? "unknown"} copy={false} />
      <RecordField label="Blast radius" value={item.blastRadius ?? "unknown"} copy={false} />
      <RecordField label="Remappable" value={item.remappable === null ? "unknown" : String(item.remappable)} copy={false} />
      <RecordField label="Last collected" value={item.lastCollectedAt ?? "never"} copy={false} />
      <RecordField label="Items in the last backup" value={item.itemCount ?? "unknown"} copy={false} />
      <RecordField label="Stale" value={item.stale ? "yes, older than its schedule allows" : "no"} copy={false} />
      {detail?.startedAt ? <RecordField label="Last read started" value={detail.startedAt} copy={false} /> : null}
      {detail?.completedAt ? <RecordField label="Last read completed" value={detail.completedAt} copy={false} /> : null}
      {item.observation ? (
        <>
          <RecordField
            label="Observation ID"
            usage={<>Benchmark comparison unavailable until a benchmark view records a matching observation. Linked views:{" "}
              <a href={`/protect?${observationQuery(item)}`}>Backups</a> · <a href={`/drift?${observationQuery(item)}`}>Drift</a></>}
            value={item.observation.observationId}
          />
          <RecordField
            copy={false}
            label="Observation window"
            value={item.observation.window ? `${item.observation.window.startedAt} – ${item.observation.window.endedAt}` : "window unknown"}
          />
          <RecordField copy={false} label="Observation evidence" value={`completeness ${item.observation.completeness} · evidence ${item.observation.evidenceLevel}`} />
        </>
      ) : <RecordField label="Observation ID" value="no observation recorded" copy={false} />}
    </>
  );
}


/** The details panel's body for one kind: its standing, what a restore brings back, the
 *  facts, where to go next, and its record last and closed. */
export function TypeDetails({ item, now, name }: { item: CoverageType; now: string; name: string }) {
  const operations = restoreOperations(item);
  const decision = recoveryDecisionSentence(item);
  const irrecoverable = item.irrecoverableFields?.length ?? 0;
  const completeness = completenessOf(item);
  const missing = completeness ? missingWords(completeness) : [];
  const standing = restoreStanding(item);
  // A type Keel cannot read for want of a grant is fixed on Setup.
  const needsGrant = item.diagnosis && /grant|permission|consent|scope|role/i.test(`${item.diagnosis.diagnosis} ${item.diagnosis.reason ?? ""}`);
  // Why the last backup failed comes first, with each permission or role it needs.
  const failure = failureReason(item);
  return (
    <div className="pt-details">
      {failure ? (
        <section aria-label="Why the last backup failed" className="pt-details-why" data-tone={failure.tone} role={failure.tone === "urgent" ? "alert" : undefined}>
          <h3>Why the last backup failed</h3>
          <p>{failure.text}</p>
          {failure.needs.length ? (
            <ul>
              {failure.needs.map((need) => (
                <li key={`${need.type}:${need.name}`}>
                  <Link className="bf-need" href={need.href}>
                    <Icon name={need.type === "role" ? "person" : "settings"} /><code>{need.name}</code>
                  </Link>
                  <span>{need.words ?? (need.type === "role" ? "Admin role" : "Microsoft permission")}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {failure.needs.length ? <p>Open one to see on Setup whether Keel&apos;s backup app holds it, and approve it there. Then press Retry.</p> : null}
        </section>
      ) : null}
      <p className="pt-details-standing">{standingSentence(item)}</p>
      <section aria-label="What a restore brings back" className="pt-details-part">
        <h3>What a restore brings back</h3>
        <ul className="pt-details-facts">
          {decision ? <li className={`decision-${item.qualification?.decision ?? "unknown"}`}>{decision}</li> : null}
          {operations.map((line) => <li key={line}>{line}</li>)}
          {completeness ? <li>{completeness.why ? `${STATE_SENTENCE[completeness.state]} ${completeness.why}` : STATE_SENTENCE[completeness.state]}</li> : null}
          {irrecoverable > 0 ? <li>{irrecoverable} {irrecoverable === 1 ? "field" : "fields"} Microsoft sets itself and Keel cannot restore.</li> : null}
          {!decision && !operations.length && !completeness && !irrecoverable ? <li>Nothing recorded yet.</li> : null}
        </ul>
        {missing.length ? (
          <>
            <h3>Finished by hand</h3>
            <ul className="pt-details-facts">{missing.map((line) => <li key={line}>{line}</li>)}</ul>
          </>
        ) : null}
      </section>
      <section aria-label="Facts" className="pt-details-part">
        <h3>Facts</h3>
        <ul className="pt-details-facts">
          <li>{backupSentence(item, now)}</li>
          <li>{item.criticality ? `${tierLabel(item.criticality)}.` : "Not in a backup tier."}</li>
          {item.blastRadius ? <li>Impact if it changes: {displayEnum("blastRadius", item.blastRadius).toLowerCase()}.</li> : null}
          {item.lastCollectedAt ? <li>Last read <time dateTime={item.lastCollectedAt} title={formatTimestamp(item.lastCollectedAt)}>{ago(item.lastCollectedAt, now)}</time>.</li> : null}
        </ul>
      </section>
      <p className="pt-details-links">
        {standing !== "cannot-restore" ? <Link className="pt-inline-link" href={`/restore?q=${encodeURIComponent(name)}`}>Restore this kind</Link> : null}
        {standing === "unproven" ? <Link className="pt-inline-link" href="/restore">Plan a test restore</Link> : null}
        {needsGrant && !failure?.needs.length ? <Link className="pt-inline-link" href="/setup#setup-permissions">Give Keel the permission it needs</Link> : null}
      </p>
      <TechnicalDetails>
        <TypeRecordFields item={item} />
      </TechnicalDetails>
    </div>
  );
}

/** The distinct collection windows of a report: more than one means the kinds were read
 *  at different times. */
export function coverageWindows(data: CoverageData): string[] {
  return [...new Set(data.types.flatMap((item) => item.observation?.window
    ? [`${item.observation.window.startedAt} – ${item.observation.window.endedAt}`] : []))];
}
