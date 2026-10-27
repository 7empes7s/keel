import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, afterEach, before, test } from "node:test";

import { createIsolatedTestDatabase } from "../../engine/test/dbTestHelper.mjs";
import { canonicalHash } from "../../engine/cir/canonicalHash.mjs";
import { recordEvaluation } from "../../engine/benchmarks/evaluate.mjs";
import { schemaSql } from "../../engine/store/loadSchema.mjs";
import { tenantRefFor } from "../../engine/store/tenantRef.mjs";
import { askFixApproval, planFix, readFixProgress } from "@/lib/compliance-change";
import { guardedComplianceFix } from "@/lib/compliance-fix";
import { queueableRestoreCredentialPaths } from "@/lib/restore-config";
import {
  canFixOn,
  complianceVerdict,
  fixAction,
  fixEffect,
  fixCandidates,
  fixObjectName,
  fixPlanProblem,
  fixRefusal,
  fixSetting,
  fixValue,
  fixableSentence,
} from "@/lib/compliance-view";
import { CAPABILITIES_HEADER, PRINCIPAL_ID_HEADER } from "@/lib/principal";
import type { ComplianceData, ComplianceFinding } from "@/lib/types";
import { renderComplianceAt } from "./render-compliance";

// "Make it pass" (CoreView gap 6): the Compliance words, the route that plans a fix as
// a dry run only, and the calls the panel makes.

const NOW = "2026-10-22T12:00:00Z";
const NONE = { state: "none" as const, linked: [], mismatched: [] };
const LOCATION = "keel-custom.named-location.no-untrusted-all-countries";
const KEY = "namedLocation:KEEL-RT-Anywhere";
const CANDIDATE = { naturalKey: KEY, resourceType: "namedLocation", name: "KEEL-RT-Anywhere", field: "includeUnknownCountriesAndRegions", from: true, to: false, snapshotId: "s1", seenAt: "2026-10-22T09:00:00Z" };
const finding = (verdict: ComplianceFinding["verdict"], extra: Partial<ComplianceFinding> = {}): ComplianceFinding => ({
  id: "e7a10000-0000-4000-8000-0000000000f1", controlId: LOCATION, title: "Registry wording", framework: "keel-custom", edition: "1", profile: "default", evaluatorVersion: 1,
  verdict, reason: null, evaluatedAt: "2026-10-22T11:00:00Z", evidenceSeq: null, exceptionState: "none", exception: null,
  exposed: verdict === "fail", evidence: [], links: { backup: NONE, change: NONE, restorePlan: NONE },
  fix: { resourceType: "namedLocation", field: "includeUnknownCountriesAndRegions", to: false }, fixCandidates: [CANDIDATE], ...extra,
});
const FAILING = finding("fail");
const DATA: ComplianceData = {
  generatedAt: NOW, activeBaseline: null,
  summary: { controls: 1, exposed: 1, excepted: 0, expiredExceptions: 0, incompleteExceptions: 0, passing: 0, unknown: 0, notApplicable: 0 },
  storage: { configured: false, provider: null, region: null, boundary: null, immutability: "unsupported", generatedAt: null, certifies: null, source: "/x" } as unknown as ComplianceData["storage"],
  findings: [FAILING],
};

test("Make it pass words: only a failing control with a fix, values in words, refusals in plain language", () => {
  assert.deepEqual(fixCandidates(FAILING).map((c) => c.naturalKey), [KEY]);
  assert.deepEqual(fixCandidates(finding("pass")), [], "a passing control offers no fix");
  assert.deepEqual(fixCandidates(finding("fail", { fix: null })), [], "a control with no fix offers none");
  assert.equal(canFixOn(FAILING, true), true);
  assert.equal(canFixOn(FAILING, false), false, "only someone who may restore");
  assert.equal(fixAction(FAILING), "Stop trusting unknown countries");
  assert.equal(fixSetting(FAILING), "Takes in unknown countries");
  // The plain words follow the setting, whichever control checks it.
  assert.equal(fixSetting(finding("fail", { controlId: "custom.other" })), "Takes in unknown countries");
  assert.deepEqual([fixValue(true), fixValue(false), fixValue(null), fixValue("on")], ["Yes", "No", "Not set", "on"]);
  assert.equal(fixObjectName(CANDIDATE), "KEEL-RT-Anywhere");
  assert.equal(fixObjectName({ ...CANDIDATE, name: null }), "A trusted location with no name");
  assert.equal(fixableSentence(FAILING), "Keel can fix it for you, after an approval.");
  assert.match(complianceVerdict(DATA).detail ?? "", /let Keel fix it after an approval/);
  assert.equal(fixRefusal(409, "not_failing"), "This control passes now, so there is nothing to fix.");
  assert.equal(fixRefusal(403, "forbidden"), "You need the restore permission to fix a control.");
  assert.equal(fixPlanProblem("compliance fix refused: namedLocation:X already passes this control; nothing to fix"), "This object already passes in the live tenant. Nothing needs to change.");
  assert.doesNotMatch(fixPlanProblem("weird"), /namedLocation|refused/);
});

test("Compliance page: a fixable failing control shows Make it pass to someone who may restore", async () => {
  const restorer = await renderComplianceAt("", { data: DATA, canConfigure: false, canRestore: true, now: NOW });
  assert.match(restorer, /Make it pass<\/a>/);
  assert.match(restorer, /Keel can fix it for you, after an approval\./);
  const viewer = await renderComplianceAt("", { data: DATA, canConfigure: false, canRestore: false, now: NOW });
  assert.doesNotMatch(viewer, /Make it pass<\/a>/);
});

// ------------------------------------------------------------------ calls

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test("the panel plans with the compliance route, reads the dry run or the job, and asks the approvers", async () => {
  const calls: { url: string; body?: unknown }[] = [];
  const answers: Response[] = [
    Response.json({ artifactId: "a1", job: { id: "j1" } }, { status: 202 }),
    Response.json({ error: "not_found" }, { status: 404 }),
    Response.json({ job: { status: "running", error: null } }),
    Response.json({ error: "not_found" }, { status: 404 }),
    Response.json({ job: { status: "failed", error: { message: "compliance fix refused: x already passes this control" } } }),
    Response.json({ artifact: { id: "a1", status: "completed", complianceFix: { field: "f", from: true, to: false, naturalKey: KEY } } }),
    new Response("{}", { status: 202 }),
  ];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return answers.shift()!;
  }) as typeof fetch;
  assert.deepEqual(await planFix(FAILING.id, KEY), { ok: true, artifactId: "a1", jobId: "j1" });
  assert.deepEqual(calls[0], { url: "/api/actions/compliance/fix", body: { evaluationId: FAILING.id, naturalKey: KEY } });
  assert.deepEqual(await readFixProgress("a1", "j1"), { state: "planning" });
  assert.deepEqual(await readFixProgress("a1", "j1"), { state: "failed", message: "compliance fix refused: x already passes this control" });
  assert.equal((await readFixProgress("a1", "j1")).state, "planned");
  assert.deepEqual(await askFixApproval("a1", "Close the gap"), { ok: true });
  assert.deepEqual(calls.at(-1), { url: "/api/actions/restore", body: { artifactId: "a1", justification: "Close the gap" } });
});

// ------------------------------------------------------------------ route

interface Client {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}
interface Database { url: string; connect(): Promise<Client>; cleanup(): Promise<void> }
let database: Database;
let client: Client;
const TENANT = tenantRefFor("tenant-gap6-portal");
const OPERATOR = "1b2a4a00-0000-4000-8000-0000000000f6";
let failing: string;

const route = () => guardedComplianceFix({
  connect: async () => database.connect(),
  databaseUrl: () => database.url,
  tenantRef: () => TENANT,
  credentialPaths: () => ({ collectorConfig: "/etc/keel/tenant.json", targetConfig: "/etc/keel/restorer.json" }),
});
function request(body: unknown, capabilities = ["read", "restore"]) {
  return new Request("http://localhost/api/actions/compliance/fix", { method: "POST", headers: {
    "content-type": "application/json", [PRINCIPAL_ID_HEADER]: OPERATOR, [CAPABILITIES_HEADER]: capabilities.join(" "),
  }, body: JSON.stringify(body) });
}
const evaluate = (verdict: string, at: string) => recordEvaluation(client, {
  tenantRef: TENANT, actor: "test",
  result: { controlId: LOCATION, framework: "keel-custom", edition: "1.0.0", profile: "default", evaluatorVersion: 1, verdict, reason: null, evidenceRefs: [], observationWindows: [], evaluatedAt: at },
}) as Promise<{ id: string }>;

before(async () => {
  if (!process.env.KEEL_DB_TEST_URL) {
    const env = readFileSync("/etc/keel/db.env", "utf8");
    process.env.KEEL_DB_TEST_URL = /^KEEL_DB_TEST_URL=(.*)$/m.exec(env)?.[1];
  }
  database = await createIsolatedTestDatabase(import.meta.url) as Database;
  client = await database.connect();
  await client.query(schemaSql());
  await client.query("INSERT INTO principal (id, email) VALUES ($1, 'operator@compliance-fix.test')", [OPERATOR]);
  const snapshot = (await client.query("INSERT INTO snapshot (tenant_ref, status, completed_at) VALUES ($1, 'complete', now()) RETURNING id", [TENANT])).rows[0].id;
  for (const payload of [
    { id: "nl-1", displayName: "KEEL-RT-Anywhere", isTrusted: true, includeUnknownCountriesAndRegions: true },
    { id: "nl-2", displayName: "KEEL-RT-Office", isTrusted: true, includeUnknownCountriesAndRegions: false },
  ]) {
    await client.query(`INSERT INTO resource_version
      (snapshot_id, natural_key, resource_type, payload, payload_hash, criticality, blast_radius, fidelity, provenance)
      VALUES ($1, $2, 'namedLocation', $3, $4, 'tier1', 'tenant-lockout', 'full', '{}')`,
    [snapshot, `namedLocation:${payload.displayName}`, payload, canonicalHash(payload, "namedLocation")]);
  }
  failing = String((await evaluate("fail", "2026-10-22T11:00:00Z")).id);
});
after(async () => {
  await client?.end();
  await database?.cleanup();
});

test("the fix route plans a dry run only, for a candidate of the newest failing result, with the server's configs", async () => {
  assert.equal((await route()(request({ evaluationId: failing, naturalKey: KEY }, ["read"]))).status, 403, "restore permission required");
  assert.equal((await route()(request({ evaluationId: "nope", naturalKey: KEY }))).status, 400);
  const extra = await route()(request({ evaluationId: failing, naturalKey: KEY, field: "isTrusted" }));
  assert.equal(extra.status, 400, "the setting is the control's, never the caller's");
  assert.equal((await route()(request({ evaluationId: "e7a10000-0000-4000-8000-000000000999", naturalKey: KEY }))).status, 404);
  const other = await route()(request({ evaluationId: failing, naturalKey: "namedLocation:KEEL-RT-Office" }));
  assert.deepEqual([other.status, (await other.json()).error], [409, "not_a_candidate"]);

  const planned = await route()(request({ evaluationId: failing, naturalKey: KEY }));
  assert.equal(planned.status, 202);
  const body = await planned.json() as { artifactId: string; job: { id: string } };
  const { rows: [job] } = await client.query("SELECT kind, params, requested_by FROM job WHERE id = $1", [body.job.id]);
  assert.equal(job.kind, "restore");
  assert.deepEqual(job.params, {
    complianceFix: { controlId: LOCATION, naturalKey: KEY },
    collectorConfig: "/etc/keel/tenant.json", targetConfig: "/etc/keel/restorer.json", artifactId: body.artifactId,
  });
  assert.ok(!("mode" in (job.params as object)), "never an enforce job");
  assert.equal(job.requested_by, OPERATOR);

  // A newer pass makes the old result stale, and the new one has nothing to fix.
  const passing = String((await evaluate("pass", "2026-10-22T11:30:00Z")).id);
  const stale = await route()(request({ evaluationId: failing, naturalKey: KEY }));
  assert.deepEqual([stale.status, (await stale.json()).error], [409, "not_newest"]);
  const fixed = await route()(request({ evaluationId: passing, naturalKey: KEY }));
  assert.deepEqual([fixed.status, (await fixed.json()).error], [409, "not_failing"]);
});

test("a Defender email fix names each row's own setting and shows mail values in plain words", () => {
  const spam = finding("fail", { controlId: "keel-custom.defender-email.anti-spam-phish-quarantined", fix: { resourceType: "exchangeAntiSpamPolicy", field: null, to: null, settings: { PhishSpamAction: "Quarantine" } } });
  const row = { naturalKey: "anti-spam-policy:g#PhishSpamAction", resourceType: "exchangeAntiSpamPolicy", name: "KEEL-RT-Sales", field: "PhishSpamAction", from: "MoveToJmf", to: "Quarantine", snapshotId: "1", seenAt: null };
  assert.equal(fixSetting(spam, row), "Phishing goes to");
  assert.equal(fixAction(spam), "Quarantine phishing");
  assert.match(fixEffect(spam) ?? "", /quarantine/);
  assert.deepEqual([fixValue(row.from, row.field), fixValue(row.to, row.field)], ["Junk folder", "Quarantine"]);
  assert.deepEqual([fixValue(false, "PhishZapEnabled"), fixValue(true, "PhishZapEnabled")], ["Off", "On"]);
  assert.deepEqual([fixValue(true, "includeUnknownCountriesAndRegions"), fixValue(false, "includeUnknownCountriesAndRegions")], ["Yes", "No"], "a yes/no setting keeps its words in the fix");
  assert.deepEqual([fixValue(["fabrikam.example"], "AllowedSenderDomains"), fixValue(null, "AllowedSenderDomains")], ["fabrikam.example", "None"]);
  assert.equal(fixPlanProblem("compliance fix refused: the live read of antiSpamPolicy was denied, so anti-spam-policy:g could not be checked"), "Keel could not read this policy in the live tenant just now. Try again in a few minutes.");
});

test("the fix route refuses before queueing when the server's restore settings path is outside /etc/keel", async () => {
  const misplaced = () => guardedComplianceFix({
    connect: async () => database.connect(),
    databaseUrl: () => database.url,
    tenantRef: () => TENANT,
    credentialPaths: () => queueableRestoreCredentialPaths({ ...process.env, KEEL_RESTORER_CONFIG_PATH: "/srv/keel/restorer.json" }),
  });
  // The newest result fails again, so only the settings path stands in the way.
  const failingAgain = String((await evaluate("fail", "2026-10-22T12:00:00Z")).id);
  const { rows: before } = await client.query("SELECT id FROM job WHERE kind = 'restore'");
  const refused = await misplaced()(request({ evaluationId: failingAgain, naturalKey: KEY }));
  assert.equal(refused.status, 503);
  const body = await refused.json() as { error: string; message: string };
  assert.equal(body.error, "restore_settings_path");
  assert.match(body.message, /must be a \.json file in \/etc\/keel\. Ask whoever runs the Keel server to fix KEEL_RESTORER_CONFIG_PATH\.$/);
  const { rows: after } = await client.query("SELECT id FROM job WHERE kind = 'restore'");
  assert.equal(after.length, before.length, "nothing is queued");
});

test("the fix panel shows the server's plain reason when the settings path is refused", async () => {
  const message = "Keel's restore settings file must be a .json file in /etc/keel. Ask whoever runs the Keel server to fix KEEL_RESTORER_CONFIG_PATH.";
  const saved = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ error: "restore_settings_path", message }, { status: 503 })) as typeof fetch;
  try {
    assert.deepEqual(await planFix(FAILING.id, KEY), { ok: false, reason: message });
  } finally {
    globalThis.fetch = saved;
  }
});
