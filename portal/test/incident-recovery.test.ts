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
  IncidentQualificationSummary, RecoveryPointTable, exclusionLabel, incidentVerdict, parseExclusions, recoveryPointStatusLabel,
} from "@/components/incident-recovery";
import { visibleNavEntries, visibleNavLinks } from "@/components/nav-links";
import { getIncidentRecoveryData, type IncidentDetail } from "@/lib/portal-data";
import { CAPABILITIES_HEADER, PRINCIPAL_ID_HEADER } from "@/lib/principal";
import { tenantRef } from "@/lib/runtime-config";

// ------------------------------------------------------------------ rendering

const NOW = "2026-10-02T09:40:00Z";
const person = (id: string, name: string) => ({ kind: "person", id, name, href: "/principals" });
const inv = person("3f9c2b1e-0000-4000-8000-0000000000aa", "Ines Investigator");
const snap = (id: string, name: string) => ({ kind: "snapshot", id, name, href: `/restore?snapshot=${id}` });
const NEW_ID = "bbbbbbbb-0000-4000-8000-000000000002";
const OLD_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const detail: IncidentDetail = {
  incident: { id: "11111111-1111-4111-8111-111111111111", title: "Admin consent phishing", owner: inv, status: "open", openedAt: "2026-10-01T08:00:00Z", closedAt: null },
  intervals: [{ id: "22222222-0000-4000-8000-000000000003", startsAt: "2026-09-30T00:00:00Z", endsAt: null, reason: "first malicious sign-in", recordedBy: inv }],
  pins: [{ id: "44444444-0000-4000-8000-000000000004", snapshotId: OLD_ID, reason: "last known good", pinnedBy: inv, pinnedAt: "2026-10-01T09:00:00Z" }],
  points: [
    {
      snapshotId: NEW_ID, snapshot: snap(NEW_ID, "Snapshot of 1 Oct 2026, 06:00 UTC"), observedFrom: "2026-10-01T05:55:00Z", observedTo: "2026-10-01T06:00:00Z",
      inCompromiseWindow: true, status: "unsuitable", stale: false, reasons: ["observed during a compromise interval", "assessed compromised (v1)"], pinned: false,
      assessment: { version: 1, verdict: "compromised", exclusions: [], assessedBy: inv, assessedAt: "2026-10-01T10:00:00Z", fingerprint: "f1".repeat(32) },
    },
    {
      snapshotId: OLD_ID, snapshot: snap(OLD_ID, "Snapshot of 25 Sept 2026, 06:00 UTC"), observedFrom: "2026-09-25T05:55:00Z", observedTo: "2026-09-25T06:00:00Z",
      inCompromiseWindow: false, status: "qualified", stale: false, reasons: ["assessed clean with 1 malicious-field exclusion(s) (v2)"], pinned: true,
      assessment: {
        version: 2, verdict: "clean", exclusions: [{ naturalKey: "group:backdoor", field: null, reason: "attacker-created group", displayName: "Helpdesk Tier 0" }],
        assessedBy: inv, assessedAt: "2026-10-01T10:05:00Z", fingerprint: "f2".repeat(32),
      },
    },
  ],
  recommended: OLD_ID,
};

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** Text outside every [data-layer="record"] block (the contract's identifier test). */
function outsideRecord(html: string): string {
  return html.replace(/<details class="technical-details" data-layer="record">[\s\S]*?<\/details>/g, "")
    .replace(/<[^>]+>/g, " ");
}

test("statuses have plain-language labels", () => {
  assert.equal(recoveryPointStatusLabel("qualified"), "Cleared");
  assert.equal(recoveryPointStatusLabel("unsuitable"), "Unsafe");
  assert.equal(recoveryPointStatusLabel("unassessed"), "Not checked");
});

test("the verdict names the newest CLEARED snapshot in one short sentence, with one action", () => {
  const verdict = incidentVerdict({ incidents: [detail.incident], selected: detail });
  assert.equal(verdict.text, "Restore from the snapshot of 25 Sept 2026, 06:00 UTC, the newest one cleared for “Admin consent phishing”.");
  assert.ok(verdict.text.split(/\s+/).length <= 25);
  assert.equal(verdict.action?.label, "Restore from this snapshot");
  assert.match(verdict.action?.href ?? "", new RegExp(`snapshot=${OLD_ID}`));

  const none = incidentVerdict({ incidents: [detail.incident], selected: { ...detail, recommended: null } });
  assert.equal(none.tone, "critical");
  assert.equal(none.action, null);
  assert.match(incidentVerdict({ incidents: [], selected: null }).text, /No security incidents/);
});

test("rows name snapshots, people and resources; every id is labelled inside Technical details", () => {
  const html = renderToStaticMarkup(createElement(RecoveryPointTable, { detail, now: NOW }));
  const visible = outsideRecord(html);
  assert.doesNotMatch(visible, UUID, "no id outside the record layer");
  assert.doesNotMatch(visible, /\bgroup:backdoor\b/, "no resource key outside the record layer");
  assert.doesNotMatch(visible, /qualif|natural key|fingerprint/i, "no internal vocabulary outside the record layer");
  assert.match(visible, /Cleared by\s+Ines Investigator\s+23 hours ago/);
  assert.match(visible, /Helpdesk Tier 0 \(group\): attacker-created group/);
  assert.match(visible, /Kept by\s+Ines Investigator\s+until released\. Being kept does not mean it is clean/);
  assert.match(visible, /Taken while the attacker had access/);
  const rows = html.split("<tr").slice(2);
  assert.doesNotMatch(rows[0], /Recommended/, "the newest (unsafe) snapshot is not recommended");
  assert.match(rows[1], /Cleared[\s\S]*Recommended/);
  // Record completeness: each id is still there, labelled.
  assert.match(html, new RegExp(`Snapshot ID</dt><dd><code>${OLD_ID}</code>`));
  assert.match(html, /Retention pin ID<\/dt><dd><code>44444444-/);
  assert.match(html, /Exclusion<\/dt><dd><code>group:backdoor<\/code>/);
  assert.doesNotMatch(html, />Record a check<|>Approve an override<|>Stop keeping<|>Keep</, "read-only without investigate");

  const actionable = renderToStaticMarkup(createElement(RecoveryPointTable, { detail, now: NOW, canInvestigate: true }));
  assert.match(actionable, />Approve an override</);
  assert.match(actionable, />Stop keeping</);
});

test("exclusions parse one per line and reject a line without a reason; labels read as names", () => {
  assert.deepEqual(parseExclusions("group:backdoor | attacker group\n\n group:board#description | defaced | twice "), {
    exclusions: [
      { naturalKey: "group:backdoor", field: null, reason: "attacker group" },
      { naturalKey: "group:board", field: "description", reason: "defaced | twice" },
    ],
    error: null,
  });
  assert.match(parseExclusions("group:backdoor").error ?? "", /Line 1/);
  assert.equal(exclusionLabel({ naturalKey: "group:board", field: "description", displayName: "Board" }), "the “description” setting of Board (group)");
  assert.equal(exclusionLabel({ naturalKey: "conditionalAccessPolicy:Block legacy auth", field: null }), "Block legacy auth (Conditional Access policy)");
});

test("the restore review names the incident, the approver and the checked resources", () => {
  const html = renderToStaticMarkup(createElement(IncidentQualificationSummary, {
    context: {
      incidentId: detail.incident.id, qualification: "overridden", status: "unassessed", reasons: ["not assessed for this incident"],
      assessment: null, exclusions: [], override: { id: "55555555-0000-4000-8000-000000000005", reason: "only point with the new membership", authorizedBy: inv.id },
      postRestoreChecks: [{ naturalKey: "group:backdoor", field: null, expectation: "absent" }],
    },
    view: { incidentTitle: "Admin consent phishing", authorizedBy: inv, checks: [{ label: "Helpdesk Tier 0 (group)", expectation: "absent" }] },
  }));
  const visible = outsideRecord(html);
  assert.doesNotMatch(visible, UUID);
  assert.match(visible, /not checked for “Admin consent phishing”; an override allows it/);
  assert.match(visible, /Override approved by\s+Ines Investigator\s*: only point with the new membership/);
  assert.match(visible, /Helpdesk Tier 0 \(group\) must be gone/);
  assert.match(html, /Authorized by \(principal ID\)<\/dt><dd><code>3f9c2b1e-/);
});

test("incident recovery is a page inside Restore, not a new navigation entry", () => {
  const capabilities = { canRead: true, canPolicies: true, canUsers: true, canApprove: true };
  assert.equal(visibleNavEntries(capabilities).some((entry) => entry.href === "/incidents"), false);
  assert.equal(visibleNavLinks(capabilities).find((page) => page.href === "/incidents")?.group, "Restore");
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
  // References arrive resolved to names, never bare ids.
  assert.equal(data.selected?.incident.owner.name, "investigator@contoso.example");
  assert.equal(data.selected?.points[0].assessment?.assessedBy?.name, "investigator@contoso.example");
  assert.match(data.selected?.points[0].snapshot.name ?? "", /^Snapshot of /);

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
