"use client";

import { useMemo, useState } from "react";

import { RecordField, TechnicalDetails } from "@/components/technical-details";
import { ago, displayEnum, formatTimestamp } from "@/lib/presentation";
import {
  STANDING_LABEL,
  backupHealth,
  backupSentence,
  recoveryDecisionSentence,
  restoreOperations,
  restoreStanding,
  standingSentence,
  tierLabel,
  typeName,
  type RestoreStanding,
} from "@/lib/protect-view";
import type { CoverageData, CoverageType, TypeExpansion } from "@/lib/types";

// Roadmap task-131 (superseding task-54's matrix layout): one drawer per configuration
// type. Its summary and explanation answer "can KEEL put this back?" in one sentence;
// every task-54 evidence field — collector, endpoint, pagination evidence, diagnosis,
// projection review, proof reference, credential mode, observation — is kept, labelled,
// in the drawer's record layer. A native <details> keeps it keyboard- and
// narrow-screen-accessible without script.
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

function TypeRecord({ item }: { item: CoverageType }) {
  const irrecoverable = item.irrecoverableFields ?? null;
  const detail = item.detail;
  const decision = item.qualification;
  return (
    <TechnicalDetails>
      <RecordField label="Configuration type" value={item.type} />
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
    </TechnicalDetails>
  );
}

/** One configuration type: its name and standing, opening onto the explanation and record. */
export function TypeDrawer({ item, now }: { item: CoverageType; now: string }) {
  const standing = restoreStanding(item);
  const health = backupHealth(item);
  const operations = restoreOperations(item);
  const decision = recoveryDecisionSentence(item);
  const irrecoverable = item.irrecoverableFields?.length ?? 0;
  return (
    <details className={`capability-matrix type-drawer standing-${standing} health-${health}`}>
      <summary>
        <span className="type-drawer-name">{typeName(item.type)}</span>
        <span className={`state-badge standing-badge standing-${standing}`}>{STANDING_LABEL[standing]}</span>
        <span className="type-drawer-backup">{backupSentence(item, now)}</span>
      </summary>
      <div className="type-drawer-body">
        <p className="type-drawer-standing">{standingSentence(item)}</p>
        <ul className="type-drawer-facts">
          <li>{item.criticality ? `${tierLabel(item.criticality)}.` : "Not in a backup tier."}</li>
          {item.blastRadius ? <li>Impact if it changes: {displayEnum("blastRadius", item.blastRadius).toLowerCase()}.</li> : null}
          {irrecoverable > 0 ? <li>{irrecoverable} {irrecoverable === 1 ? "field" : "fields"} Microsoft sets itself and KEEL cannot restore.</li> : null}
          {decision ? <li className={`decision-${item.qualification?.decision ?? "unknown"}`}>{decision}</li> : null}
          {operations.map((line) => <li key={line}>{line}</li>)}
          {item.lastCollectedAt ? <li>Collected <time dateTime={item.lastCollectedAt} title={formatTimestamp(item.lastCollectedAt)}>{ago(item.lastCollectedAt, now)}</time>.</li> : null}
        </ul>
        <TypeRecord item={item} />
      </div>
    </details>
  );
}

const STANDING_ORDER: RestoreStanding[] = ["cannot-restore", "unproven", "partial", "protected"];
const GROUP_TITLE: Record<RestoreStanding, string> = {
  "cannot-restore": "Cannot be restored",
  unproven: "Backed up, restore not yet proven",
  partial: "Partially protected",
  protected: "Protected",
};

export function CoverageReport({ data, now }: { data: CoverageData; now?: string }) {
  const at = now ?? data.generatedAt;
  const [query, setQuery] = useState("");
  const [standing, setStanding] = useState<RestoreStanding | "all">("all");
  const [tier, setTier] = useState("all");

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return data.types.filter((item) =>
      (standing === "all" || restoreStanding(item) === standing)
      && (tier === "all" || item.criticality === tier)
      && (!needle || item.type.toLowerCase().includes(needle) || typeName(item.type).toLowerCase().includes(needle)));
  }, [data.types, query, standing, tier]);

  const groups = STANDING_ORDER.map((candidate) => ({
    standing: candidate,
    items: filtered.filter((item) => restoreStanding(item) === candidate)
      .sort((a, b) => (a.criticality ?? "tier9").localeCompare(b.criticality ?? "tier9") || a.type.localeCompare(b.type)),
  })).filter((group) => group.items.length > 0);

  const windows = [...new Set(data.types.flatMap((item) => item.observation?.window
    ? [`${item.observation.window.startedAt} – ${item.observation.window.endedAt}`] : []))];

  return (
    <section aria-labelledby="coverage-report-heading" className="report-section">
      <div className="section-heading-row report-heading">
        <div>
          <p className="section-kicker">Every configuration type</p>
          <h2 id="coverage-report-heading">What KEEL can put back</h2>
        </div>
        <span className="result-count">{filtered.length} of {data.types.length}</span>
      </div>

      {windows.length > 1 ? (
        <aside className="honesty-note" aria-label="Collection times differ">
          <strong>These types were collected at different times.</strong>
          <p>Treat them as separate copies, not one picture of the tenant at a single moment.</p>
          <TechnicalDetails>
            <RecordField copy={false} label="Observation windows differ" value={windows.join("; ")} />
          </TechnicalDetails>
        </aside>
      ) : null}

      <div className="filter-bar">
        <label className="filter-field search-field">
          <span>Find a type</span>
          <input onChange={(event) => setQuery(event.target.value)} placeholder="e.g. Conditional Access" type="search" value={query} />
        </label>
        <label className="filter-field">
          <span>Can it be restored</span>
          <select onChange={(event) => setStanding(event.target.value as RestoreStanding | "all")} value={standing}>
            <option value="all">Any</option>
            {STANDING_ORDER.map((candidate) => <option key={candidate} value={candidate}>{STANDING_LABEL[candidate]}</option>)}
          </select>
        </label>
        <label className="filter-field">
          <span>Tier</span>
          <select onChange={(event) => setTier(event.target.value)} value={tier}>
            <option value="all">All tiers</option>
            <option value="tier1">Tier 1</option>
            <option value="tier2">Tier 2</option>
            <option value="tier3">Tier 3</option>
          </select>
        </label>
      </div>

      {groups.length ? (
        <div className="coverage-groups">
          {groups.map((group) => (
            <section aria-labelledby={`coverage-${group.standing}`} className={`coverage-group group-${group.standing}`} key={group.standing}>
              <header className="group-header">
                <h3 id={`coverage-${group.standing}`}>{GROUP_TITLE[group.standing]}</h3>
                <span>{group.items.length} {group.items.length === 1 ? "type" : "types"}</span>
              </header>
              <div className="type-drawers">
                {group.items.map((item) => <TypeDrawer item={item} key={item.type} now={at} />)}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <p className="empty-state">No configuration types match these filters.</p>
      )}
    </section>
  );
}
