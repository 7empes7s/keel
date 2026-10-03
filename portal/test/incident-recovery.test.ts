import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { grantRole, revokeRole } from "../../engine/authz/administration.mjs";
import { createIsolatedTestDatabase } from "../../engine/test/dbTestHelper.mjs";

import { POST as incidentsRoute } from "@/app/api/actions/incidents/route";
import { POST as dryRunRoute } from "@/app/api/actions/restore/dry-run/route";
import {
  IncidentQualificationSummary, RecoveryPointTable, parseExclusions, recoveryPointStatusLabel,
} from "@/components/incident-recovery";
import { visibleNavLinks } from "@/components/nav-links";
import { getIncidentRecoveryData, type IncidentDetail } from "@/lib/portal-data";
import { CAPABILITIES_HEADER, PRINCIPAL_ID_HEADER } from "@/lib/principal";
import { tenantRef } from "@/lib/runtime-config";

// ------------------------------------------------------------------ rendering

const detail: IncidentDetail = {
  incident: { id: "11111111-1111-4111-8111-111111111111", title: "Admin consent phishing", owner: "inv", status: "open", openedAt: "2026-10-01T08:00:00Z", closedAt: null },
  intervals: [{ id: "w", startsAt: "2026-09-30T00:00:00Z", endsAt: null, reason: "first malicious sign-in", recordedBy: "inv" }],
  pins: [{ id: "p1", snapshotId: "aaaaaaaa-0000-4000-8000-000000000001", reason: "last known good", pinnedBy: "inv", pinnedAt: "2026-10-01T09:00:00Z" }],
  points: [
    {
      snapshotId: "bbbbbbbb-0000-4000-8000-000000000002", observedFrom: "2026-10-01T05:55:00Z", observedTo: "2026-10-01T06:00:00Z",
      inCompromiseWindow: true, status: "unsuitable", stale: false, reasons: ["observed during a compromise interval", "assessed compromised (v1)"], pinned: false,
      assessment: { version: 1, verdict: "compromised", exclusions: [], assessedBy: "inv", assessedAt: "2026-10-01T10:00:00Z", fingerprint: "f1" },
    },
    {
      snapshotId: "aaaaaaaa-0000-4000-8000-000000000001", observedFrom: "2026-09-25T05:55:00Z", observedTo: "2026-09-25T06:00:00Z",
      inCompromiseWindow: false, status: "qualified", stale: false, reasons: ["assessed clean with 1 malicious-field exclusion(s) (v2)"], pinned: true,
      assessment: {
        version: 2, verdict: "clean", exclusions: [{ naturalKey: "group:backdoor", field: null, reason: "attacker-created group" }],
        assessedBy: "inv", assessedAt: "2026-10-01T10:05:00Z", fingerprint: "f2",
      },
    },
  ],
  recommended: "aaaaaaaa-0000-4000-8000-000000000001",
};

test("statuses have plain-language labels", () => {
  assert.equal(recoveryPointStatusLabel("qualified"), "Qualified");
  assert.equal(recoveryPointStatusLabel("unsuitable"), "Unsuitable");
  assert.equal(recoveryPointStatusLabel("unassessed"), "Unassessed");
});

test("the table marks the engine's recommended point, not the newest, and never presents a pin as clean", () => {
  const html = renderToStaticMarkup(createElement(RecoveryPointTable, { detail }));
  const rows = html.split("<tr").slice(2);
  assert.match(rows[0], /Unsuitable/);
  assert.doesNotMatch(rows[0], /Recommended/, "the newest (compromised) point is not recommended");
  assert.match(rows[1], /Qualified[\s\S]*Recommended/);
  assert.match(rows[1], /Excluded <code>group:backdoor<\/code>/);
  assert.match(rows[1], /Pinned[\s\S]*not proof of a clean state/);
  assert.match(rows[0], /Restore \(override needed\)/);
  assert.match(rows[1], /href="\/restore\?snapshot=aaaaaaaa-0000-4000-8000-000000000001&amp;incident=11111111-1111-4111-8111-111111111111"/);
  assert.doesNotMatch(html, />Assess<|>Authorize override<|>Release pin<|>Pin</, "read-only without investigate");

  const actionable = renderToStaticMarkup(createElement(RecoveryPointTable, { detail, canInvestigate: true }));
  assert.match(actionable, /Authorize override/);
  assert.match(actionable, /Release pin/);
});

test("exclusions parse one per line and reject a line without a reason", () => {
  assert.deepEqual(parseExclusions("group:backdoor | attacker group\n\n group:board#description | defaced | twice "), {
    exclusions: [
      { naturalKey: "group:backdoor", field: null, reason: "attacker group" },
      { naturalKey: "group:board", field: "description", reason: "defaced | twice" },
    ],
    error: null,
  });
  assert.match(parseExclusions("group:backdoor").error ?? "", /Line 1/);
});

test("the restore review shows the incident qualification, override and post-restore checks", () => {
  const html = renderToStaticMarkup(createElement(IncidentQualificationSummary, {
    context: {
      incidentId: detail.incident.id, qualification: "overridden", status: "unassessed", reasons: ["not assessed for this incident"],
      assessment: null, exclusions: [], override: { reason: "only point with the new membership", authorizedBy: "inv-2" },
      postRestoreChecks: [{ naturalKey: "group:backdoor", field: null, expectation: "absent" }],
    },
  }));
  assert.match(html, /Override of a unassessed point/);
  assert.match(html, /only point with the new membership/);
  assert.match(html, /<code>group:backdoor<\/code> must be absent/);
});

test("the incidents page is linked under Recovery", () => {
  const link = visibleNavLinks({}).find((entry) => entry.href === "/incidents");
  assert.equal(link?.group, "Recovery");
});

// ------------------------------------------------------- routes and loader (DB)

interface TestClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

let database: { url: string; connect(): Promise<TestClient>; cleanup(): Promise<void> };
let client: TestClient;
let investigator: { id: string; grantId: string };
let snapshotId: string;

before(async () => {
  if (!process.env.KEEL_DB_TEST_URL) {
    for (const line of readFileSync("/etc/keel/db.env", "utf8").split("\n")) {
      const match = /^KEEL_DB_TEST_URL=(.*)$/.exec(line.trim());
      if (match) process.env.KEEL_DB_TEST_URL = match[1];
    }
  }
  database = (await createIsolatedTestDatabase(import.meta.url)) as typeof database;
  client = await database.connect();
  await client.query(readFileSync(new URL("../../engine/store/schema.sql", import.meta.url), "utf8"));
  const dir = mkdtempSync(join(tmpdir(), "keel-portal-incident-test-"));
  writeFileSync(join(dir, "tenant.json"), JSON.stringify({ tenantId: "task-71-incident-portal-test" }));
  process.env.KEEL_DB_URL = database.url;
  process.env.KEEL_TENANT_CONFIG_PATH = join(dir, "tenant.json");

  const { rows } = await client.query("INSERT INTO principal (email) VALUES ('investigator@contoso.example') RETURNING id");
  const id = String(rows[0].id);
  const grant = (await grantRole(client, { principalId: id, role: "investigator", grantedBy: id })) as { id: string };
  investigator = { id, grantId: grant.id };
  const { rows: snapshots } = await client.query(
    "INSERT INTO snapshot (tenant_ref, status, started_at, completed_at) VALUES ($1, 'complete', now() - interval '2 days', now() - interval '2 days') RETURNING id",
    [tenantRef()],
  );
  snapshotId = String(snapshots[0].id);
});

after(async () => {
  await client.end();
  await database.cleanup();
});

function post(path: string, body: unknown, principalId: string, capabilities: string[]): Request {
  const headers = new Headers({ "content-type": "application/json" });
  headers.set(PRINCIPAL_ID_HEADER, principalId);
  headers.set(CAPABILITIES_HEADER, capabilities.join(" "));
  return new Request(`http://localhost${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

const incidents = (body: unknown, capabilities = ["read", "investigate"], principalId = investigator.id) =>
  incidentsRoute(post("/api/actions/incidents", body, principalId, capabilities));

test("incident changes require investigate, re-checked against current grants", async () => {
  assert.equal((await incidents({ op: "open", title: "x" }, ["read", "restore", "approve"])).status, 403);
  assert.equal((await incidents({ op: "nope" })).status, 400);

  const opened = await incidents({ op: "open", title: "Token theft" });
  assert.equal(opened.status, 200);
  const incidentId = ((await opened.json()) as { incident: { id: string } }).incident.id;

  assert.equal((await incidents({ op: "interval", incidentId, startsAt: new Date(Date.now() - 86_400_000).toISOString(), reason: "first malicious sign-in" })).status, 200);
  const assessed = await incidents({ op: "assess", incidentId, snapshotId, verdict: "maybe", rationale: "r" });
  assert.equal(assessed.status, 409);
  assert.equal((await incidents({ op: "assess", incidentId, snapshotId, verdict: "clean", rationale: "before the window" })).status, 200);
  assert.equal((await incidents({ op: "pin", incidentId, snapshotId, reason: "last known good" })).status, 200);
  assert.equal((await incidents({ op: "pin", incidentId: "00000000-0000-4000-8000-000000000000", snapshotId, reason: "r" })).status, 404);

  // The loader returns the engine's qualification for this tenant only.
  const data = await getIncidentRecoveryData(incidentId);
  assert.equal(data.selected?.recommended, snapshotId);
  assert.equal(data.selected?.points[0].status, "qualified");
  assert.equal(data.selected?.points[0].pinned, true);

  // A header still claiming investigate after the grant is revoked is refused by the engine.
  await revokeRole(client, { principalId: investigator.id, grantId: investigator.grantId, revokedBy: investigator.id });
  assert.equal((await incidents({ op: "pin", incidentId, snapshotId, reason: "again" })).status, 403);
});

test("a dry run may carry an incident id, which reaches the job and nothing else", async () => {
  const base = { snapshotId, selection: ["group:board"], collectorConfig: "/etc/keel/c.json", targetConfig: "/etc/keel/r.json" };
  const refused = await dryRunRoute(post("/api/actions/restore/dry-run", { ...base, incidentId: "not-an-id" }, "restorer", ["restore"]));
  assert.equal(refused.status, 400);

  const incidentId = "22222222-2222-4222-8222-222222222222";
  const response = await dryRunRoute(post("/api/actions/restore/dry-run", { ...base, incidentId }, "restorer", ["restore"]));
  assert.equal(response.status, 202);
  const { job } = (await response.json()) as { job: { id: string } };
  const { rows } = await client.query("SELECT params FROM job WHERE id = $1", [job.id]);
  assert.equal((rows[0].params as { incidentId: string }).incidentId, incidentId);
});
