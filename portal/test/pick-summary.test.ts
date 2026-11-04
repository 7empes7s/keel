import assert from "node:assert/strict";
import { test } from "node:test";

import { changePick, findingPick } from "@/lib/pick-items";
import { pickCounts } from "@/lib/pick-summary";
import type { ComplianceFinding, DriftRecord } from "@/lib/types";

const change = (id: string, resourceType: string, name: string, blastRadius: string): DriftRecord => ({
  id, naturalKey: `${resourceType}:${name}`, resourceType, name, blastRadius, changeType: "modified", detectedAt: "2026-10-01T00:00:00Z",
} as unknown as DriftRecord);

test("a confirm panel counts changes by risk (most serious first), service and kind", () => {
  const items = [
    change("1", "user", "Ada", "access-affecting"),
    change("2", "conditionalAccessPolicy", "Block legacy auth", "tenant-lockout"),
    change("3", "user", "Grace", "access-affecting"),
    change("4", "group", "Finance", "cosmetic"),
  ].map(changePick);
  const counts = pickCounts(items);
  assert.deepEqual(counts.risks.map(({ facet, count }) => [facet.key, facet.tone, count]), [
    ["tenant-lockout", "urgent", 1],
    ["access-affecting", "soon", 2],
    ["cosmetic", "low", 1],
  ]);
  assert.deepEqual(counts.services.map(({ facet, count }) => [facet.label, count]), [["Entra ID", 4]]);
  // Kinds keep the service's order: users, then groups, then policies.
  const kinds = counts.kinds.map(({ facet, count }) => [facet.label, count]);
  assert.equal(kinds.length, 3);
  assert.deepEqual(kinds.map(([, count]) => count), [2, 1, 1]);
  assert.equal(counts.kinds.reduce((sum, entry) => sum + entry.count, 0), 4);
  // A change is named by its name, never by its key or id.
  assert.equal(items[1].name, "Block legacy auth");
});

test("controls are counted by how serious they are and by standard; no severity, no risk", () => {
  const finding = (id: string, severity: string | null) => ({
    id, controlId: `keel-custom.${id}`, title: `Control ${id}`, severity, framework: "keel-custom", edition: "1", profile: "baseline", verdict: "fail", evidence: [],
  } as unknown as ComplianceFinding);
  const counts = pickCounts([finding("a", "medium"), finding("b", "high"), finding("c", null)].map(findingPick));
  assert.deepEqual(counts.risks.map(({ facet, count }) => [facet.label, count]), [["High", 1], ["Medium", 1]]);
  assert.deepEqual(counts.kinds.map(({ facet, count }) => [facet.label, count]), [["Keel checks", 3]]);
});
