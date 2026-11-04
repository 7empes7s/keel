import assert from "node:assert/strict";
import { test } from "node:test";

import { backupHealth, backupSentence, matchesHealth, protectCounts, protectProblems, protectVerdict, provenAt, recoveryDecisionSentence, restoreProof, restoreStanding, STANDING_LABEL, standingSentence } from "@/lib/protect-view";
import { serviceStatus } from "@/lib/setup-services";
import { normalizeCoverageType } from "@/lib/portal-data";
import { qualificationFor } from "../../engine/coverage/qualification.mjs";
import type { CapabilityClaim, CoverageData, CoverageType, WriteOperationCapability } from "@/lib/types";

const NOW = "2026-10-15T18:00:00.000Z";

function op(claim: CapabilityClaim, live?: boolean): WriteOperationCapability {
  return {
    claim, credentialMode: claim === "unsupported" ? null : "restorer", idOutcome: null, handler: null, proofRef: null,
    projection: "reviewed-empty",
    liveRecord: live === undefined ? null : { live, observedAt: "2026-10-14T10:00:00.000Z", expiresAt: "2026-11-13T10:00:00.000Z", reason: null },
  };
}

// A type collected today, declared read-only because no restore drill has measured it.
function readOnlyType(overrides: Partial<CoverageType> = {}): CoverageType {
  return {
    type: "tokenLifetimePolicy",
    reportStatus: "covered",
    protectionState: "read-only",
    stale: false,
    itemCount: 1,
    lastCollectedAt: "2026-10-15T15:00:00.000Z",
    adapter: "graph-native/tokenLifetimePolicy",
    outcome: "complete",
    detail: null,
    fidelity: { declared: "read-only", measured: null, verifiedAt: null },
    criticality: "tier2",
    blastRadius: "access-affecting",
    remappable: false,
    qualification: { decision: "automated", reason: null, softRestoreCandidate: false, remapping: {} },
    writeCapability: {
      resourceType: "tokenLifetimePolicy",
      operations: { create: op("fixture-tested"), update: op("fixture-tested"), delete: op("unsupported"), "restore-soft-deleted": op("unsupported") },
    },
    ...overrides,
  };
}

test("a read-only-declared type with a tested writer is restorable, tested but not yet proven", () => {
  const item = readOnlyType();
  assert.equal(restoreStanding(item), "unproven");
  assert.equal(restoreProof(item), "tested");
  assert.equal(standingSentence(item), "Backed up. Keel's restore passes its tests but has not yet been proven on this tenant.");
});

test("a write that ran live on this tenant proves the restore, the same rule every count uses", () => {
  const item = readOnlyType({
    writeCapability: {
      resourceType: "tokenLifetimePolicy",
      operations: { create: op("live-qualified", true), update: op("live-qualified", true), delete: op("unsupported"), "restore-soft-deleted": op("unsupported") },
    },
  });
  assert.equal(restoreStanding(item), "proven");
  assert.equal(restoreProof(item), "proven");
  assert.equal(provenAt(item), "2026-10-14T10:00:00.000Z");
  assert.match(standingSentence(item), /^Restore proven on this tenant by a live run on 14 Oct 2026\./);
  assert.equal(matchesHealth(item, "proven"), true, "the Restore proven filter lists it");
  // A live record that no longer counts does not prove anything.
  const lapsed = readOnlyType({
    writeCapability: {
      resourceType: "tokenLifetimePolicy",
      operations: { create: op("live-qualified", false), update: op("fixture-tested"), delete: op("unsupported"), "restore-soft-deleted": op("unsupported") },
    },
  });
  assert.equal(restoreProof(lapsed), "tested");
  assert.equal(matchesHealth(lapsed, "proven"), false);
});

test("read-only types without an automated, tested writer still cannot be restored", () => {
  assert.equal(restoreStanding(readOnlyType({ qualification: { decision: "manual", reason: null, softRestoreCandidate: false, remapping: {} } })), "cannot-restore");
  assert.equal(restoreStanding(readOnlyType({ qualification: null })), "cannot-restore");
  assert.equal(restoreStanding(readOnlyType({ writeCapability: null })), "cannot-restore");
  const declaredOnly = readOnlyType({
    writeCapability: {
      resourceType: "tokenLifetimePolicy",
      operations: { create: op("declared"), update: op("declared"), delete: op("unsupported"), "restore-soft-deleted": op("unsupported") },
    },
  });
  assert.equal(restoreStanding(declaredOnly), "cannot-restore");
  assert.equal(restoreStanding(readOnlyType({ fidelity: { declared: "unprotectable", measured: null, verifiedAt: null }, protectionState: "unprotectable" })), "cannot-restore");
});

test("a type the tenant cannot have is unavailable, not failed", () => {
  const unavailable = readOnlyType({ type: "lifecycleWorkflow", reportStatus: "failed", protectionState: "failed", outcome: "unavailable", itemCount: null });
  assert.equal(backupHealth(unavailable), "unavailable");
  assert.match(backupSentence(unavailable, NOW), /^Not available on this tenant/);
  assert.equal(restoreStanding(unavailable), "cannot-restore");
  assert.match(standingSentence(unavailable), /licence or feature/);

  const data: CoverageData = {
    generatedAt: NOW, snapshot: null,
    summary: { covered: 1, failed: 0, partial: 0, notCovered: 0, neverCollected: 0, stale: 0, unavailable: 1, total: 2 },
    types: [readOnlyType(), unavailable],
  };
  assert.deepEqual(protectProblems(data, NOW), []);
  assert.deepEqual(protectVerdict(data, NOW), { text: "The one setting type was backed up in the last 3 hours.", tone: "good" });
});

test("a refused read that is not a missing prerequisite still counts as failed", () => {
  const failed = readOnlyType({ reportStatus: "failed", protectionState: "failed", outcome: "failed" });
  assert.equal(backupHealth(failed), "failed");
});

// Kinds Microsoft owns (the tenant itself, licences, built-in roles) hold nothing to
// restore: never "Cannot be restored", never a manual step, and out of "of N" counts.
test("a nothing-to-restore kind reads as nothing to restore and stays out of restore counts", () => {
  const nothing = readOnlyType({
    type: "organization",
    qualification: { decision: "manual", reason: null, softRestoreCandidate: false, nothingToRestore: true, remapping: {} },
    writeCapability: null,
  });
  const manual = readOnlyType({ type: "domain", qualification: { decision: "manual", reason: null, softRestoreCandidate: false, remapping: {} }, writeCapability: null });
  assert.equal(restoreStanding(nothing), "nothing-to-restore");
  assert.equal(STANDING_LABEL[restoreStanding(nothing)], "Nothing to restore");
  assert.match(standingSentence(nothing), /^Nothing to restore/);
  assert.doesNotMatch(recoveryDecisionSentence(nothing) ?? "", /manual step;/);
  assert.match(recoveryDecisionSentence(manual) ?? "", /manual step/);
  assert.equal(restoreStanding(manual), "cannot-restore", "a by-hand kind with no writer is still a gap");

  const counts = protectCounts([readOnlyType(), nothing, manual]);
  assert.equal(counts.restorable, 1);
  assert.equal(counts.nothingToRestore, 1);
  const status = serviceStatus("entra", [readOnlyType(), nothing, manual], NOW);
  assert.match(status.restore.text, /^1 of 2 can be put back/);
});

test("the portal reads nothing to restore from the engine's Microsoft-managed completeness state", () => {
  const entry = (type: string) => normalizeCoverageType({
    type, status: "covered", stale: false, itemCount: 1, lastCollectedAt: NOW, adapter: `graph/${type}`, outcome: "complete",
    detail: null, fidelity: { declared: "read-only", verifiedBy: null }, criticality: "tier3", blastRadius: null, remappable: null,
    qualification: qualificationFor(type),
  });
  assert.equal(entry("organization").qualification?.nothingToRestore, true);
  assert.equal(restoreStanding(entry("organization")), "nothing-to-restore");
  assert.equal(entry("domain").qualification?.nothingToRestore, false);
  assert.equal(restoreStanding(entry("domain")), "cannot-restore");
});
