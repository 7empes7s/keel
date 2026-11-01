import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";

import type { AlertItem } from "@/lib/alerts-view";
import { alertService } from "@/lib/alerts-view";
import { approvalPreview, type ApprovalRequestRecord } from "@/lib/approval-inbox";
import { answerSummary, recordKind, recordService, type ChangeRecord, type GroundedAnswer } from "@/lib/ask-view";
import { actionKindLine } from "@/lib/policy-view";
import { EMPTY_REFERENCES } from "@/lib/sentences";

// An endpoint security policy (antivirus, firewall…) made in Intune is stored as a
// settings catalog policy but is a Defender setting. Every page that lists one object
// files it by the object (itemService / itemKind), never by its stored type alone.

const PORTAL = join(import.meta.dirname, "..");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

// typeService and typeInfo(…).service answer for a kind. Handed one object's stored type
// (`row.resourceType`, `row.resource_type`, a key's type), they file an Intune antivirus
// policy under Intune. Pass the object to itemService, or its kind (itemKind) instead.
const BY_STORED_TYPE = [
  /typeService\((?:[^()]|\([^()]*\))*?(?:\.resourceType\b|\.resource_type\b|keyType\()/g,
  /typeInfo\((?:String\()?[\w.]+\.(?:resourceType|resource_type)\)?\)\.service/g,
];
// The restore list keeps each row's stored service and refines it per object (restoreService).
const ALLOWED = new Set(["lib/portal-data.ts"]);
// A line about a whole kind, not one object (a coverage row), says so with this marker.
const KIND_LEVEL = "kind-level";

test("no page files one object under its service by its stored type alone", () => {
  const found: string[] = [];
  for (const dir of ["lib", "components", "app"]) {
    for (const path of sources(join(PORTAL, dir))) {
      const name = relative(PORTAL, path);
      if (ALLOWED.has(name)) continue;
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (line.includes(KIND_LEVEL)) continue;
        for (const pattern of BY_STORED_TYPE) for (const match of line.matchAll(pattern)) found.push(`${name}: ${match[0]}`);
      }
    }
  }
  assert.deepEqual(found, []);
});

test("the guard catches a page that goes back to the stored type", () => {
  for (const line of ["typeService(row.resourceType).name", "typeService(keyType(key)).name", "typeInfo(String(row.resource_type)).service"]) {
    assert.ok(BY_STORED_TYPE.some((pattern) => new RegExp(pattern.source).test(line)), line);
  }
  assert.ok(!BY_STORED_TYPE.some((pattern) => new RegExp(pattern.source).test("typeService(itemKind(item))")));
});

const ANTIVIRUS = "endpointSecurityAntivirus";

function alert(templateFamily: string | null): AlertItem {
  return {
    id: "a1", resourceKey: "configurationPolicy:p1", name: "KEEL-RT-Antivirus", control: "drift", condition: "changed",
    state: "open", conditionActive: true, severity: "warning", occurrence: 1,
    firstOpenedAt: "2026-10-30T10:00:00.000Z", occurrenceStartedAt: "2026-10-30T10:00:00.000Z", lastFiringAt: "2026-10-30T10:00:00.000Z",
    ackDeadlineAt: null, acknowledgedAt: null, acknowledgedByName: null, owner: null, escalated: false, escalationError: null,
    cause: { changeType: "modified", resourceType: "configurationPolicy", snapshotId: null },
    ...(templateFamily ? { templateFamily } : {}),
    lastEventId: "e1", history: [],
  };
}

test("alerts group an endpoint security policy under Defender", () => {
  assert.equal(alertService(alert(ANTIVIRUS)).code, "Defender");
  assert.equal(alertService(alert(null)).code, "Intune");
  assert.equal(alertService(alert("baseline")).code, "Intune");
});

test("a rule's actions say what the policy is and that it is a Defender setting", () => {
  const action = { resource_type: "configurationPolicy", change_type: "modified", name: "KEEL-RT-Antivirus" };
  assert.equal(actionKindLine({ ...action, template_family: ANTIVIRUS }), "Antivirus policy · Defender · changed");
  assert.equal(actionKindLine(action), "Settings catalog policy · Intune · changed");
});

function change(templateFamily: string | null): ChangeRecord {
  return {
    kind: "change", id: "d1", resourceType: "configurationPolicy", ...(templateFamily ? { templateFamily } : {}),
    naturalKey: "configurationPolicy:p1", name: "KEEL-RT-Antivirus", changeType: "modified", impact: "access-affecting",
    decision: null, seenAt: "2026-10-30T10:00:00.000Z", window: { from: null, to: "2026-10-30T10:00:00.000Z" },
    source: { kind: "change", id: "d1", href: "/changes" },
  };
}

test("Ask lists and counts an endpoint security change under Defender", () => {
  assert.equal(recordService(change(ANTIVIRUS)).code, "Defender");
  assert.equal(recordKind(change(ANTIVIRUS)), "Antivirus policy");
  assert.equal(recordService(change(null)).code, "Intune");
  const answer = {
    intent: "changes",
    summary: [
      { resourceType: "configurationPolicy", templateFamily: ANTIVIRUS, changeType: "modified", impact: "access-affecting", count: 2 },
      { resourceType: "configurationPolicy", changeType: "modified", impact: "access-affecting", count: 1 },
    ],
    records: [],
  } as unknown as GroundedAnswer;
  const summary = answerSummary(answer)!;
  assert.deepEqual(summary.services.map((row) => [row.key, row.count]), [["Defender", 2], ["Intune", 1]]);
  assert.deepEqual(summary.kinds.map((row) => [row.key, row.count]), [["defenderEndpointSecurityPolicy", 2], ["configurationPolicy", 1]]);
});

test("an approval's preview counts an endpoint security policy under Defender", async () => {
  const drift = (id: string, family: string | null) => ({
    id, natural_key: `configurationPolicy:${id}`, resource_type: "configurationPolicy", change_type: "modified",
    before_payload: { name: `KEEL-RT-${id}`, templateReference: family ? { templateFamily: family } : {} },
    after_payload: { name: `KEEL-RT-${id}`, settingCount: 2, templateReference: family ? { templateFamily: family } : {} },
    before_hash: "a", after_hash: "b", same_content: false,
  });
  const rows = [drift("av", ANTIVIRUS), drift("wifi", "none")];
  const client = { query: async (sql: string) => ({ rows: /FROM drift/.test(sql) ? rows : [] }) };
  // The preview reads the tenant from its config file; the test brings its own.
  const dir = mkdtempSync(join(tmpdir(), "keel-endpoint-security-"));
  const previous = process.env.KEEL_TENANT_CONFIG_PATH;
  writeFileSync(join(dir, "tenant.json"), JSON.stringify({ tenantId: "endpoint-security-test" }));
  process.env.KEEL_TENANT_CONFIG_PATH = join(dir, "tenant.json");
  const request = {
    id: "req-1", action: "remediate", params: { driftIds: ["av", "wifi"] }, requestedBy: "someone", justification: null,
    status: "pending", decidedBy: null, decidedAt: null, reason: null, createdAt: null, expiresAt: null, references: EMPTY_REFERENCES,
  } as unknown as ApprovalRequestRecord;
  let preview;
  try {
    preview = await approvalPreview(client as never, request);
  } finally {
    if (previous === undefined) delete process.env.KEEL_TENANT_CONFIG_PATH; else process.env.KEEL_TENANT_CONFIG_PATH = previous;
    rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(preview?.services, [{ name: "Defender", count: 1 }, { name: "Intune", count: 1 }]);
  assert.deepEqual(preview?.changes.map((entry) => entry.kind), ["Antivirus policy", "Settings catalog policy"]);
});
