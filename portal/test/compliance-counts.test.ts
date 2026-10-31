import assert from "node:assert/strict";
import { test } from "node:test";

import { KEEL_TWINS, SCUBA_POLICY_IDS } from "../../engine/benchmarks/standards.mjs";
import { controlFor } from "../../engine/benchmarks/registry.mjs";
import {
  complianceCounts,
  complianceVerdict,
  countsFromSummary,
  foldedFindings,
  resultLine,
  resultOf,
  scubaPolicyUrl,
  twinLine,
  unknownAction,
} from "@/lib/compliance-view";
import type { ComplianceData, ComplianceFinding } from "@/lib/types";

// The Compliance page's counts are honest: CISA's checks to do by hand are never
// "could not check", never offer a backup, and a Keel check that tests what a CISA
// policy tests shows once.

const NONE = { state: "none" as const, linked: [], mismatched: [] };
const finding = (controlId: string, verdict: ComplianceFinding["verdict"], extra: Partial<ComplianceFinding> = {}): ComplianceFinding => ({
  id: `id-${controlId}`, controlId, title: null, framework: controlId.startsWith("scubagear.") ? "cisa-scuba" : "keel-custom",
  edition: "1.0.0", profile: "aad", evaluatorVersion: 1, verdict, reason: null, evaluatedAt: "2026-10-31T11:00:00Z",
  evidenceSeq: null, exceptionState: "none", exception: null, exposed: verdict === "fail", evidence: [],
  links: { backup: NONE, change: NONE, restorePlan: NONE }, ...extra,
});
const DATA = (findings: ComplianceFinding[]): ComplianceData => ({ findings, generatedAt: "2026-10-31T12:00:00Z" } as unknown as ComplianceData);

const BY_HAND = finding("scubagear.MS.AAD.2.2v1", "unknown", { reason: "scubagear:check-by-hand" });
const NOT_READ = finding("scubagear.MS.TEAMS.1.1v1", "unknown", { reason: "scubagear:not-read:teams_meeting_policies" });
const NEEDS_LIST = finding("scubagear.MS.SECURITYSUITE.2.3v1", "unknown", { reason: "scubagear:needs-setting:partner-domains" });
const STALE = finding("keel-custom.group.role-assignable-not-synced", "unknown", { reason: "group:stale" });

test("a rule CISA leaves to a person is 'Check by hand', counted apart from 'could not check'", () => {
  assert.equal(resultOf(BY_HAND), "by-hand");
  assert.equal(resultOf(NOT_READ), "unknown");
  assert.equal(resultLine(BY_HAND, "2026-10-31T12:00:00Z"), "CISA lists this as a check to do by hand");
  const counts = complianceCounts([BY_HAND, NOT_READ, STALE, finding("scubagear.MS.AAD.3.2v2", "pass")]);
  assert.deepEqual([counts.unknown, counts["by-hand"], counts.passing], [2, 1, 1]);
  // The engine's summary counts by-hand rules inside its unknowns; the page takes them out.
  const summary = countsFromSummary({ controls: 10, exposed: 0, excepted: 0, expiredExceptions: 0, incompleteExceptions: 0, passing: 4, unknown: 6, byHand: 5, notApplicable: 0 });
  assert.deepEqual([summary.unknown, summary["by-hand"]], [1, 5]);
  // An older summary without the field leaves every unknown as "could not check".
  assert.equal(countsFromSummary({ controls: 1, exposed: 0, excepted: 0, expiredExceptions: 0, incompleteExceptions: 0, passing: 0, unknown: 1, notApplicable: 0 }).unknown, 1);
});

test("only a missing or old backup offers 'Run a backup'; CISA's own rules link to CISA's steps", () => {
  assert.deepEqual(unknownAction(STALE), { kind: "backup", href: "/protect" });
  assert.deepEqual(unknownAction(NEEDS_LIST), { kind: "list", href: null });
  assert.deepEqual(unknownAction(BY_HAND), { kind: "how-to", href: "https://github.com/cisagov/ScubaGear/blob/v2.0.0/PowerShell/ScubaGear/baselines/aad.md#msaad22v1" });
  assert.equal(unknownAction(NOT_READ).kind, "how-to", "no backup Keel makes answers it, so the steps are the useful action");
  assert.equal(unknownAction(finding("scubagear.MS.AAD.3.2v2", "pass")).kind, null);
  // Every pinned policy gets a link to its own heading in the baseline it belongs to.
  for (const ref of SCUBA_POLICY_IDS as readonly string[]) {
    assert.match(scubaPolicyUrl(`scubagear.${ref}`) ?? "", /^https:\/\/github\.com\/cisagov\/ScubaGear\/blob\/v2\.0\.0\/PowerShell\/ScubaGear\/baselines\/(aad|exo|powerbi|powerplatform|securitysuite|sharepoint|teams)\.md#ms[a-z]+\d+v\d+$/, ref);
  }
  assert.equal(scubaPolicyUrl("keel-custom.conditional-access.block-legacy"), null);
});

test("the verdict never blames a backup for rules no backup answers", () => {
  assert.equal(complianceVerdict(DATA([STALE, finding("scubagear.MS.AAD.3.2v2", "pass")])).detail, "The backup each one needs is missing or too old.");
  assert.equal(complianceVerdict(DATA([NOT_READ, STALE])).detail, "Open each one to see why, and what you can do about it.");
  const byHand = complianceVerdict(DATA([BY_HAND, finding("scubagear.MS.AAD.3.2v2", "pass")]));
  assert.equal(byHand.text, "No control fails; 1 control is a check to do by hand.");
  assert.equal(byHand.tone, "fine");
});

test("a Keel check and the CISA rule that tests the same thing show once", () => {
  // Each twin is a real Keel check and a pinned CISA policy.
  for (const [keelId, ref] of Object.entries(KEEL_TWINS)) {
    assert.ok(controlFor(keelId), keelId);
    assert.ok((SCUBA_POLICY_IDS as readonly string[]).includes(ref), ref);
  }
  const keel = finding("keel-custom.conditional-access.block-legacy", "fail");
  const other = finding("keel-custom.named-location.no-untrusted-all-countries", "pass");
  // Both judged: CISA's rule stays, Keel's rides along as its twin.
  const both = foldedFindings([keel, finding("scubagear.MS.AAD.1.1v1", "fail"), other]);
  assert.deepEqual(both.map((entry) => entry.controlId), ["scubagear.MS.AAD.1.1v1", "keel-custom.named-location.no-untrusted-all-countries"]);
  assert.equal(both[0].twin?.controlId, keel.controlId);
  assert.equal(twinLine(both[0]), "Keel's own check tests the same and agrees");
  assert.equal(twinLine(both[1]), null);
  // CISA's rule could not run but Keel's could: Keel's stays, so a result is not lost.
  const keelOnly = foldedFindings([keel, finding("scubagear.MS.AAD.1.1v1", "unknown", { reason: "scubagear:not-read:x" })]);
  assert.deepEqual(keelOnly.map((entry) => entry.controlId), ["keel-custom.conditional-access.block-legacy"]);
  assert.equal(twinLine(keelOnly[0]), "CISA MS.AAD.1.1v1 tests the same: could not check");
  // A Keel check with no CISA result loaded is left alone.
  assert.deepEqual(foldedFindings([keel, other]).map((entry) => entry.controlId), [keel.controlId, other.controlId]);
  // Folding counts one result per setting.
  assert.equal(complianceCounts(both).failing, 1);
});
