import type { CoverageRecord, GroundedAnswer } from "@/lib/ask-view";
import { plainKind, typeService } from "@/lib/baselines-view";
import { backupHealth, backupSentence, coverageSummary } from "@/lib/protect-view";
import type { CoverageData, CoverageType } from "@/lib/types";

// Ask's "what does the backup hold" answer counted the kinds in the newest snapshot only,
// so after a run of one tier most kinds read "Not part of this backup", and it listed parts
// of a kind as kinds of their own. This rebuilds the Entra ID and Intune rows from the
// coverage report every other page reads, and counts them with the shared buckets
// (lib/protect-view.ts coverageBuckets), so Ask says what Setup and What's protected say.
// Pure: the caller loads the report.

function kindRecord(item: CoverageType, data: CoverageData, now: string, backup: CoverageRecord["backup"]): CoverageRecord {
  return {
    kind: "coverage",
    backup,
    id: `kind/${item.type}`,
    resourceType: item.type,
    name: null,
    service: typeService(item.type).name,
    outcome: item.outcome ?? "not-recorded",
    count: item.itemCount,
    lastGoodAt: item.lastCollectedAt,
    health: backupHealth(item),
    note: backupSentence(item, now),
    window: { from: item.observation?.window?.startedAt ?? null, to: item.lastCollectedAt },
    source: { kind: "collection", id: item.observation?.observationId ?? data.snapshot?.id ?? item.type, href: "/protect" },
  };
}

/**
 * The coverage answer with each kind's state from the shared coverage report. Only for a
 * reader of the whole tenant asking about no one owner: the report is tenant-wide, while
 * an owner's answer counts that owner's resources and stays as the engine built it.
 * Content backups (mail, files) are not kinds in the buckets and keep their own rows.
 */
export function withSharedCoverage(answer: GroundedAnswer, data: CoverageData, now: string): GroundedAnswer {
  if (answer.intent !== "coverage" || answer.status === "refused" || !answer.plan) return answer;
  if (!answer.scope.central || answer.plan.params.entity) return answer;
  const { params } = answer.plan;
  const asked = params.resourceTypes?.length ? new Set(params.resourceTypes) : params.resourceType ? new Set([params.resourceType]) : null;
  const needle = params.name ? params.name.toLowerCase() : null;
  const matches = (item: CoverageType) => (!asked || asked.has(item.type)) && (!needle || plainKind(item.type).toLowerCase().includes(needle));
  const types = data.types.filter(matches);
  const workloads = (data.workloads ?? []).filter(matches);
  const kinds = [...types, ...workloads];
  // A question only about part of a kind (one endpoint security family) has no kind of
  // its own in the report: keep the engine's answer.
  if (!kinds.length) return answer;

  const byWorkload = new Map(workloads.map((item) => [item.type, item]));
  const listed = new Set<string>();
  const services: CoverageRecord[] = [];
  const content: CoverageRecord[] = [];
  for (const record of answer.records) {
    if (record.kind !== "coverage" || record.backup === "settings" || record.backup === undefined) continue;
    if (record.backup === "content") { content.push(record); continue; }
    const kind = byWorkload.get(record.resourceType);
    if (!kind) { services.push(record); continue; }
    listed.add(record.resourceType);
    // The engine's row keeps the settings count from the last good read; the state is the shared one.
    services.push({ ...record, health: backupHealth(kind), note: backupSentence(kind, now) });
  }
  for (const item of workloads) if (!listed.has(item.type)) services.push(kindRecord(item, data, now, "service-settings"));
  const records = [...services, ...content, ...types.map((item) => kindRecord(item, data, now, "settings"))];
  return {
    ...answer,
    status: "answered",
    records,
    total: records.length,
    shown: records.length,
    truncated: false,
    coverage: coverageSummary(kinds),
  };
}
