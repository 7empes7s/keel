import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";

import { grantRole } from "../../engine/authz/administration.mjs";
import { canonicalHash, HASH_VERSION } from "../../engine/cir/canonicalHash.mjs";
import { complianceFindings } from "../../engine/govern/baselineCompliance.mjs";
import { STANDARDS } from "../../engine/benchmarks/standards.mjs";
import { schemaSql } from "../../engine/store/loadSchema.mjs";
import { createIsolatedTestDatabase } from "../../engine/test/dbTestHelper.mjs";
import { tenantRefFor } from "../../engine/store/tenantRef.mjs";
import { readValue } from "@/components/compliance/own-check-sheet";
import { guardedOwnCheckCreate, guardedOwnCheckRemove } from "@/lib/compliance-own-check";
import {
  controlWhat,
  coverageSentence,
  ownStandards,
  ownCheckSentence,
  standardCoverage,
  standardName,
} from "@/lib/compliance-view";
import { CAPABILITIES_HEADER, PRINCIPAL_ID_HEADER } from "@/lib/principal";
import type { ComplianceFinding, KnownStandard } from "@/lib/types";

// Your own checks and known standards on the Compliance page: the words, the coverage of
// a known standard, and the routes that write and remove a check.

const NONE = { state: "none" as const, linked: [], mismatched: [] };
const finding = (controlId: string, verdict: ComplianceFinding["verdict"], extra: Partial<ComplianceFinding> = {}): ComplianceFinding => ({
  id: `id-${controlId}`, controlId, title: null, framework: "keel-custom", edition: "1.0.0", profile: "default", evaluatorVersion: 1,
  verdict, reason: null, evaluatedAt: "2026-10-23T11:00:00Z", evidenceSeq: null, exceptionState: "none", exception: null,
  exposed: verdict === "fail", evidence: [], links: { backup: NONE, change: NONE, restorePlan: NONE }, ...extra,
});
const SCUBA = (STANDARDS as { id: string }[]).find((standard) => standard.id === "cisa-scuba") as unknown as KnownStandard;
const NIST = (STANDARDS as { id: string }[]).find((standard) => standard.id === "nist-800-53") as unknown as KnownStandard;

test("a known standard's policies take the worst result of the checks mapped to them", () => {
  const findings = [
    finding("keel-custom.conditional-access.block-legacy", "pass"),
    finding("keel-custom.role-assignment.admin-count-at-most", "fail"),
  ];
  const coverage = standardCoverage(SCUBA, findings);
  const row = (ref: string) => coverage.rows.find((entry) => entry.ref === ref)!;
  assert.equal(coverage.total, 43);
  assert.equal(coverage.checked, 3);
  assert.equal(row("MS.AAD.1.1v1").result, "passing");
  assert.equal(row("MS.AAD.7.1v1").result, "failing");
  assert.equal(row("MS.AAD.7.3v1").result, "unknown", "a mapped check with no result is never a pass");
  assert.equal(row("MS.EXO.1.1v2").result, "not-checked");
  assert.equal(row("MS.AAD.7.1v1").mapped[0].match, "partial");
  assert.equal(coverageSentence(SCUBA, coverage), "Keel checks 3 of 43 CISA SCuBA policies: 1 passes, 1 does not, 1 could not be checked.");
  assert.equal(coverageSentence(NIST, standardCoverage(NIST, [])), "Keel maps 3 NIST SP 800-53 controls: 3 could not be checked.");
  // An exception counts as not passing, as on the score.
  const excepted = standardCoverage(SCUBA, [finding("keel-custom.conditional-access.block-legacy", "fail", { exposed: false, exceptionState: "authorized" })]);
  assert.equal(excepted.rows.find((entry) => entry.ref === "MS.AAD.1.1v1")!.result, "excepted");
  assert.equal(excepted.notPassing, 1);
});

test("an own check is said in words and filed under its standard", () => {
  const own = {
    id: "c1", controlId: "own.c1", standard: "Contoso hardening", name: "Rules on", resourceType: "conditionalAccessPolicy",
    field: "state", operator: "equals" as const, expected: "enabled", appliesTo: "every" as const, severity: "high" as const, createdBy: "p", createdAt: "2026-10-23T10:00:00Z",
  };
  const mine = finding("own.c1", "fail", { framework: "own", profile: "Contoso hardening", title: "Rules on", own });
  assert.equal(standardName(mine), "Contoso hardening");
  assert.equal(controlWhat(mine), "Every one of the sign-in rules has state set to enabled.");
  assert.equal(ownCheckSentence({ ...own, operator: "not-equals", expected: false, appliesTo: "any" }), "At least one of the sign-in rules has state set to anything but Off.");
  assert.deepEqual(ownStandards([mine, finding("x", "pass"), { ...mine, own: { ...own, standard: "Audit" } }]), ["Audit", "Contoso hardening"]);
});

test("a typed value is read as the kind the setting holds", () => {
  assert.equal(readValue("true", [false]), true);
  assert.equal(readValue("false", [true]), false);
  assert.equal(readValue("5", [3]), 5);
  assert.equal(readValue("5", ["enabled"]), "5", "a text setting keeps text");
  assert.equal(readValue("enabled", []), "enabled");
  assert.equal(readValue("TRUE", []), true);
  assert.equal(readValue("12", []), 12);
});

interface Client {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}
interface Database { url: string; connect(): Promise<Client>; cleanup(): Promise<void> }
let database: Database;
let client: Client;
const TENANT = tenantRefFor("tenant-own-checks-portal");
const ADMIN = "1b2a4a00-0000-4000-8000-0000000000a1";
const OPERATOR = "1b2a4a00-0000-4000-8000-0000000000a2";
const deps = () => ({ connect: async () => database.connect(), databaseUrl: () => database.url, tenantRef: () => TENANT });
function request(path: string, body: unknown, principal = ADMIN, capabilities = ["read", "configuration"]) {
  return new Request(`http://localhost${path}`, { method: "POST", headers: {
    "content-type": "application/json", [PRINCIPAL_ID_HEADER]: principal, [CAPABILITIES_HEADER]: capabilities.join(" "),
  }, body: JSON.stringify(body) });
}
const CHECK = { standard: "Contoso hardening", name: "Every sign-in rule is on", resourceType: "conditionalAccessPolicy", field: "state", operator: "equals", expected: "enabled", appliesTo: "every", severity: "high" };

before(async () => {
  if (!process.env.KEEL_DB_TEST_URL) {
    const env = readFileSync("/etc/keel/db.env", "utf8");
    process.env.KEEL_DB_TEST_URL = /^KEEL_DB_TEST_URL=(.*)$/m.exec(env)?.[1];
  }
  database = await createIsolatedTestDatabase(import.meta.url) as Database;
  client = await database.connect();
  await client.query(schemaSql());
  await client.query("INSERT INTO principal (id, email) VALUES ($1, 'admin@own-checks.test'), ($2, 'operator@own-checks.test')", [ADMIN, OPERATOR]);
  await grantRole(client, { principalId: ADMIN, role: "admin", grantedBy: ADMIN });
  await grantRole(client, { principalId: OPERATOR, role: "operator", grantedBy: ADMIN });
  const completedAt = new Date(Date.now() - 3_600_000);
  const coverage = { conditionalAccessPolicy: { outcome: "complete", itemCount: 2 } };
  const snapshot = (await client.query(
    "INSERT INTO snapshot (tenant_ref, status, started_at, completed_at, coverage_digest) VALUES ($1, 'complete', $2, $3, $4) RETURNING id",
    [TENANT, new Date(completedAt.getTime() - 600_000), completedAt, coverage],
  )).rows[0].id;
  for (const payload of [
    { id: "ca-1", displayName: "KEEL-RT-mfa", state: "enabled" },
    { id: "ca-2", displayName: "KEEL-RT-old", state: "disabled" },
  ]) {
    await client.query(`INSERT INTO resource_version
      (snapshot_id, natural_key, resource_type, payload, payload_hash, hash_version, criticality, blast_radius, fidelity, provenance)
      VALUES ($1, $2, 'conditionalAccessPolicy', $3, $4, $5, 'tier1', 'access-affecting', 'full', '{}')`,
    [snapshot, `conditionalAccessPolicy:${payload.displayName}`, payload, canonicalHash(payload, "conditionalAccessPolicy"), HASH_VERSION]);
  }
});
after(async () => {
  await client?.end();
  await database?.cleanup();
});

test("writing a check needs configuration, refuses a bad one, and checks it at once", async () => {
  const create = guardedOwnCheckCreate(deps());
  assert.equal((await create(request("/api/actions/compliance/own-check", CHECK, OPERATOR, ["read", "collect"]))).status, 403, "the guard needs configuration");
  assert.equal((await create(request("/api/actions/compliance/own-check", CHECK, OPERATOR))).status, 403, "the engine re-checks the role itself");
  const bad = await create(request("/api/actions/compliance/own-check", { ...CHECK, expected: ["a"] }));
  assert.deepEqual([bad.status, (await bad.json()).error], [400, "invalid_request"]);
  assert.equal((await create(request("/api/actions/compliance/own-check", { ...CHECK, expected: undefined }))).status, 400, "a value is required");

  const saved = await create(request("/api/actions/compliance/own-check", CHECK));
  assert.equal(saved.status, 201);
  const body = await saved.json() as { check: { id: string; standard: string }; verdict: string; evaluationId: string };
  assert.equal(body.verdict, "fail", "one rule is off");
  assert.equal(body.check.standard, "Contoso hardening");
  const { findings } = await complianceFindings(client, { tenantRef: TENANT, now: new Date() }) as { findings: ComplianceFinding[] };
  assert.deepEqual(findings.map((entry) => [entry.controlId, entry.verdict]), [[`own.${body.check.id}`, "fail"]], "only the new check ran");

  const remove = guardedOwnCheckRemove(deps());
  assert.equal((await remove(request("/api/actions/compliance/own-check/remove", { checkId: "nope" }))).status, 400);
  assert.equal((await remove(request("/api/actions/compliance/own-check/remove", { checkId: body.check.id }, OPERATOR))).status, 403);
  assert.equal((await remove(request("/api/actions/compliance/own-check/remove", { checkId: body.check.id }))).status, 200);
  assert.equal((await remove(request("/api/actions/compliance/own-check/remove", { checkId: body.check.id }))).status, 404, "already removed");
  assert.equal(((await complianceFindings(client, { tenantRef: TENANT, now: new Date() })) as { findings: unknown[] }).findings.length, 0);
});
