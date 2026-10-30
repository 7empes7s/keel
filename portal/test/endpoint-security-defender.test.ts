import assert from "node:assert/strict";
import { test } from "node:test";

import { itemKindName, itemService, kindLine, serviceSummaries } from "@/lib/baselines-view";
import { plainType, restoreService } from "@/lib/restore-view";
import { itemKind, kindParts } from "@/lib/type-groups";

// Antivirus, firewall, attack surface reduction and the other Endpoint security policies
// are made in Intune and stored as settings catalog policies, but they are Defender for
// Endpoint settings: every list files them under Defender, as "Endpoint security".

const antivirus = { resourceType: "configurationPolicy", service: "Intune", name: "KEEL-RT-Antivirus", templateFamily: "endpointSecurityAntivirus" };
const firewall = { resourceType: "configurationPolicy", service: "Intune", name: "KEEL-RT-Firewall", templateFamily: "endpointSecurityFirewall" };
const plain = { resourceType: "configurationPolicy", service: "Intune", name: "KEEL-RT-Wi-Fi", templateFamily: "none" };
const baseline = { resourceType: "configurationPolicy", service: "Intune", name: "KEEL-RT-Baseline", templateFamily: "baseline" };

test("endpoint security policies sit under Defender on Restore and Changes", () => {
  assert.equal(restoreService(antivirus), "Defender");
  assert.equal(restoreService(firewall), "Defender");
  assert.equal(itemService(antivirus).code, "Defender");
  assert.equal(itemService(antivirus).name, "Defender");
});

test("plain settings catalog policies, baselines and old rows with no family stay under Intune", () => {
  for (const item of [plain, baseline, { resourceType: "configurationPolicy", service: "Intune", name: "KEEL-RT-Old" }]) {
    assert.equal(restoreService(item), "Intune", item.name);
    assert.equal(itemService(item).code, "Intune", item.name);
    assert.equal(itemKind(item), "configurationPolicy", item.name);
  }
});

test("each row says which area it covers, and that it is set in Intune", () => {
  assert.equal(itemKindName(antivirus), "Antivirus policy");
  assert.equal(itemKindName({ ...firewall, templateFamily: "endpointSecurityAttackSurfaceReduction" }), "Attack surface reduction policy");
  assert.equal(kindLine({ ...firewall, changeType: "modified" }), "Firewall policy · changed");
  assert.equal(plainType(itemKind(antivirus)), "Endpoint security policy");
});

test("inside Defender they form one Endpoint security group", () => {
  const rows = [antivirus, firewall, { resourceType: "defenderDetectionRule", service: "Defender", name: "KEEL-RT-Rule" }];
  const parts = kindParts(rows, itemKind, "Defender");
  assert.deepEqual(parts.map((part) => [part.label, part.items.map((item) => item.name)]), [
    ["Endpoint security", ["KEEL-RT-Antivirus", "KEEL-RT-Firewall"]],
    ["Threat policies and rules", ["KEEL-RT-Rule"]],
  ]);
});

test("the Changes summary counts an endpoint security change under Defender", () => {
  const summaries = serviceSummaries(null, [{ ...antivirus, blastRadius: "access-affecting" }], ["configurationPolicy"]);
  const defender = summaries.find((summary) => summary.service.code === "Defender");
  assert.equal(defender?.changed, 1);
});

test("the summary lists the endpoint security kind under Defender and keeps Intune policies in line", () => {
  const summaries = serviceSummaries({ capture: { types: ["configurationPolicy"] } } as never, [{ ...antivirus, blastRadius: "access-affecting" }], ["configurationPolicy"]);
  const defender = summaries.find((summary) => summary.service.code === "Defender");
  const intune = summaries.find((summary) => summary.service.code === "Intune");
  assert.deepEqual(defender?.changedKinds, ["defenderEndpointSecurityPolicy"]);
  assert.deepEqual(intune?.inLine, ["configurationPolicy"]);
});
