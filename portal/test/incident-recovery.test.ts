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
import { GET as snapshotItemsRoute } from "@/app/api/snapshots/[id]/items/route";
import { IncidentQualificationSummary } from "@/components/incident-recovery";
import { incidentAction, utcInstant } from "@/lib/incident-calls";
import {
  exclusionLabel, failureWords, incidentStatus, incidentVerdict, itemLabel, orderBackups, parseExclusions, recoveryPointStatusLabel, timeline,
} from "@/lib/incidents-view";
import { visibleNavEntries, visibleNavLinks } from "@/components/nav-links";
import { getIncidentRecoveryData, type IncidentDetail } from "@/lib/portal-data";
import { CAPABILITIES_HEADER, PRINCIPAL_ID_HEADER } from "@/lib/principal";
import { tenantRef } from "@/lib/runtime-config";
import { renderIncidentsAt } from "./render-incidents";
import { schemaSql } from "../../engine/store/loadSchema.mjs";
import { recordValues } from "./record-fields";

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
        assessedBy: inv, assessedAt: "2026-10-01T10:05:00Z", fingerprint: "f2".repeat(32), rationale: "matches the day before",
      },
    },
  ],
  recommended: OLD_ID,
};

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** Text outside every [data-layer="record"] block (the contract's identifier test). */
function outsideRecord(html: string): string {
  return html.replace(/<details class="technical-details" data-layer="record">[\s\S]*?<\/details>/g, "")
    .replace(/\s(?:data-row-id|href|title|id|for|aria-labelledby|aria-label)="[^"]*"/g, "")
    .replace(/<[^>]+>/g, " ");
}

test("states have plain-language labels", () => {
  assert.equal(recoveryPointStatusLabel("qualified"), "Cleared");
  assert.equal(recoveryPointStatusLabel("unsuitable"), "Unsafe");
  assert.equal(recoveryPointStatusLabel("unassessed"), "Not checked");
});

test("the verdict names the newest CLEARED backup in one short sentence, with one action", () => {
  const verdict = incidentVerdict({ incidents: [detail.incident], selected: detail, now: NOW });
  assert.equal(verdict.text, "Restore from the backup of 25 Sept 2026, 06:00 UTC, the newest one cleared for “Admin consent phishing”.");
  assert.ok(verdict.text.split(/\s+/).length <= 25);
  assert.equal(verdict.detail, "It leaves out 1 harmful item: Helpdesk Tier 0 (group).");
  assert.equal(verdict.action?.label, "Restore from this backup");
  assert.match(verdict.action?.href ?? "", new RegExp(`snapshot=${OLD_ID}`));

  const none = incidentVerdict({ incidents: [detail.incident], selected: { ...detail, recommended: null } });
  assert.equal(none.tone, "urgent");
  assert.equal(none.action, null);
  assert.match(incidentVerdict({ incidents: [], selected: null }).text, /No security incidents/);
  const closed = incidentVerdict({ incidents: [detail.incident], selected: { ...detail, incident: { ...detail.incident, status: "closed", closedAt: "2026-10-02T08:40:00Z" } }, now: NOW });
  assert.equal(closed.text, "“Admin consent phishing” was closed 1 hour ago. Its checks and kept backups stay as a record.");
  assert.equal(closed.action, null, "a closed incident offers no amber action");
});

test("the status pill says whether a backup is cleared for the open incident", () => {
  assert.deepEqual(incidentStatus([detail.incident], detail), { tone: "soon", label: "Incident open, backup cleared" });
  assert.deepEqual(incidentStatus([detail.incident], { ...detail, recommended: null }), { tone: "urgent", label: "No backup cleared" });
  assert.deepEqual(incidentStatus([], null), { tone: "fine", label: "No open incident" });
  const closed = { ...detail.incident, status: "closed" as const };
  assert.deepEqual(incidentStatus([closed], { ...detail, incident: closed }), { tone: "fine", label: "No open incident" });
});

test("backups list the recommended one first, then unsafe, then newest", () => {
  assert.deepEqual(orderBackups(detail.points, detail.recommended).map((point) => point.snapshotId), [OLD_ID, NEW_ID]);
});

test("rows name backups and people; every id stays in Technical details", async () => {
  const html = await renderIncidentsAt("", { incidents: [detail.incident], selected: detail, now: NOW, canInvestigate: false });
  const visible = outsideRecord(html);
  assert.doesNotMatch(visible, UUID, "no id outside the record layer");
  assert.doesNotMatch(visible, /\bgroup:backdoor\b/, "no resource key outside the record layer");
  assert.doesNotMatch(visible, /qualif|natural key|fingerprint|snapshot/i, "no internal vocabulary outside the record layer");
  assert.doesNotMatch(visible, /@/, "no email outside the record layer");
  assert.match(visible, /Checked by\s+Ines Investigator\s+· 23 hours ago/);
  assert.match(visible, /Marked unsafe by\s+Ines Investigator/);
  assert.match(visible, /Taken during the attack/);
  assert.match(visible, /Only investigators can change incidents\./);
  const rows = html.split('class="ir-row"').slice(1).map((row) => row.split("ir-row-acts")[0]);
  assert.match(rows[0], /25 Sept 2026, 06:00 UTC[\s\S]*Cleared[\s\S]*Recommended[\s\S]*Kept/, "the recommended, kept backup comes first");
  assert.doesNotMatch(rows[1], /Recommended/, "the newest (unsafe) backup is not recommended");
  assert.match(html, /class="btn btn-sm" href="\/restore\?snapshot=aaaaaaaa-[^"]*">Restore from this backup</);
  assert.doesNotMatch(html, />Record your check<|>Record a new check<|>Close incident<|>Add attack window<|>New incident</, "read-only without investigate");
  // Record completeness: each id is still there, labelled.
  assert.ok(recordValues(html, "Recommended snapshot ID").some((value) => value.startsWith(`<code>${OLD_ID}</code>`)));
  assert.ok(recordValues(html, "Retention pin ID").some((value) => value.startsWith("<code>44444444-")));

  const actionable = await renderIncidentsAt("", { incidents: [detail.incident], selected: detail, now: NOW, canInvestigate: true });
  assert.match(actionable, />Record a new check</);
  assert.match(actionable, />New incident</);
  assert.match(actionable, />Close incident</);
  assert.match(actionable, /href="\/incidents\?open=bbbbbbbb-0000-4000-8000-000000000002&amp;do=check"/, "a check opens in its sheet, kept in the URL");

  const closed = { ...detail, incident: { ...detail.incident, status: "closed" as const, closedAt: "2026-10-02T08:40:00Z" } };
  const readOnly = await renderIncidentsAt("", { incidents: [closed.incident], selected: closed, now: NOW, canInvestigate: true });
  assert.match(readOnly, /This incident is closed, so nothing on it can change/);
  assert.doesNotMatch(readOnly, />Record a new check<|>Close incident<|>Add attack window</, "a closed incident is a record");
});

test("a tile filters the list by state and keeps it in the URL", async () => {
  const html = await renderIncidentsAt("state=unsafe", { incidents: [detail.incident], selected: detail, now: NOW, canInvestigate: true });
  assert.match(html, /Showing <b>1<\/b> of 2 backups/);
  assert.equal(html.split('class="ir-row"').length - 1, 1);
  assert.match(html, /href="\/incidents\?state=cleared%2Cunsafe"/, "Cleared adds to the picked state");
  const both = await renderIncidentsAt("state=unsafe,cleared", { incidents: [detail.incident], selected: detail, now: NOW, canInvestigate: true });
  assert.match(both, /Showing <b>2<\/b> of 2 backups/);
});

test("engine refusals become plain sentences, with no key or id in them", () => {
  assert.equal(failureWords(409, "exclusion group:x is not in this snapshot"), "One of the items you left out is not in this backup. Pick it again from the list.");
  assert.match(failureWords(409, "a compromised verdict refuses the whole point — exclusions apply only to a clean verdict"), /refused as a whole/);
  assert.match(failureWords(409, "this point is already qualified — no override is needed"), /already cleared/);
  assert.match(failureWords(409, "the incident is closed"), /closed/);
  assert.match(failureWords(403), /no longer change incidents/);
  for (const message of ["exclusion group:x field description is not in this snapshot", "endsAt must be after startsAt", "rationale is required"]) {
    assert.doesNotMatch(failureWords(409, message), /group:|endsAt|rationale/);
  }
});

test("the item picker shows names and kinds, never stored keys", () => {
  assert.deepEqual(itemLabel({ naturalKey: "servicePrincipal:Mail Sync Helper", resourceType: "servicePrincipal", name: "Mail Sync Helper" }), { label: "Mail Sync Helper", kind: "enterprise app" });
  const unnamed = itemLabel({ naturalKey: "conditionalAccessPolicy:Block legacy auth", resourceType: "conditionalAccessPolicy", name: null });
  assert.equal(unnamed.label, "Block legacy auth");
  assert.doesNotMatch(unnamed.label, /:/);
});

test("the timeline puts a backup taken in the attack window inside its band", () => {
  const line = timeline(detail, NOW);
  const band = line.bands[0];
  const inside = line.dots.find((dot) => dot.id === NEW_ID)!;
  const before = line.dots.find((dot) => dot.id === OLD_ID)!;
  assert.ok(inside.x >= band.x && inside.x <= band.x + band.width, "the newest backup sits inside the window");
  assert.ok(before.x < band.x, "the cleared backup is before the attacker got in");
  assert.equal(band.ongoing, true);
  assert.equal(before.recommended, true);
});

test("dates and times read as UTC; a bad time is refused", () => {
  assert.equal(utcInstant("2026-09-30", "22:40"), "2026-09-30T22:40:00.000Z");
  assert.equal(utcInstant("2026-09-30", "7:05"), "2026-09-30T07:05:00.000Z");
  assert.equal(utcInstant("2026-09-30", "25:00"), null);
  assert.equal(utcInstant(null, "10:00"), null);
});

test("each step posts its op to the incidents route with its own idempotency key", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(calls.length === 2 ? { error: "refused", message: "this snapshot is already pinned for this incident" } : { pin: {} }), { status: calls.length === 2 ? 409 : 200 });
  }) as typeof fetch;
  try {
    assert.deepEqual(await incidentAction("pin", { incidentId: "i", snapshotId: "s1", reason: "evidence" }), { ok: true, body: { pin: {} } });
    assert.deepEqual(await incidentAction("pin", { incidentId: "i", snapshotId: "s2", reason: "evidence" }), { ok: false, reason: "This backup is already kept for this incident." });
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(calls[0].url, "/api/actions/incidents");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { op: "pin", incidentId: "i", snapshotId: "s1", reason: "evidence" });
  const keys = calls.map((call) => new Headers(call.init.headers).get("idempotency-key"));
  assert.ok(keys[0] && keys[1] && keys[0] !== keys[1]);
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
  assert.ok(recordValues(html, "Authorized by (principal ID)").some((value) => value.startsWith("<code>3f9c2b1e-")));
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
  await client.query(schemaSql());
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
  assert.equal(data.selected?.points[0].assessment?.rationale, "before the window", "the check's own words reach the panel");

  // A restore allowed anyway on an unchecked backup is read back, with who allowed it.
  const { rows: others } = await client.query(
    "INSERT INTO snapshot (tenant_ref, status, started_at, completed_at) VALUES ($1, 'complete', now() - interval '3 days', now() - interval '3 days') RETURNING id",
    [tenantRef()],
  );
  const unchecked = String(others[0].id);
  assert.equal((await incidents({ op: "override", incidentId, snapshotId: unchecked, reason: "only backup with the old membership" })).status, 200);
  const allowed = await getIncidentRecoveryData(incidentId);
  assert.equal(allowed.selected?.overrides?.length, 1);
  assert.equal(allowed.selected?.overrides?.[0].snapshotId, unchecked);
  assert.equal(allowed.selected?.overrides?.[0].authorizedBy?.name, "investigator@contoso.example");
  assert.equal((await incidents({ op: "revoke-override", overrideId: allowed.selected?.overrides?.[0].id })).status, 200);
  assert.equal((await getIncidentRecoveryData(incidentId)).selected?.overrides?.length, 0, "a withdrawn permission is no longer listed");

  // A header still claiming investigate after the grant is revoked is refused by the engine.
  await revokeRole(client, { principalId: investigator.id, grantId: investigator.grantId, revokedBy: investigator.id });
  assert.equal((await incidents({ op: "pin", incidentId, snapshotId, reason: "again" })).status, 403);
});

test("a backup's items are read with the read permission, by this tenant's backup id", async () => {
  const get = (id: string, capabilities: string[]) => {
    const headers = new Headers();
    headers.set(PRINCIPAL_ID_HEADER, investigator.id);
    headers.set(CAPABILITIES_HEADER, capabilities.join(" "));
    return snapshotItemsRoute(new Request(`http://localhost/api/snapshots/${id}/items`, { headers }));
  };
  assert.equal((await get(snapshotId, [])).status, 403);
  assert.equal((await get("not-an-id", ["read"])).status, 400);
  const response = await get(snapshotId, ["read"]);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { snapshotId: string; resources: unknown[] };
  assert.equal(body.snapshotId, snapshotId);
  assert.deepEqual(body.resources, []);
});

test("a dry run may carry an incident id, which reaches the job and nothing else", async () => {
  const base = { snapshotId, selection: ["group:board"] };
  const refused = await dryRunRoute(post("/api/actions/restore/dry-run", { ...base, incidentId: "not-an-id" }, "restorer", ["restore"]));
  assert.equal(refused.status, 400);

  const incidentId = "22222222-2222-4222-8222-222222222222";
  const response = await dryRunRoute(post("/api/actions/restore/dry-run", { ...base, incidentId }, "restorer", ["restore"]));
  assert.equal(response.status, 202);
  const { job } = (await response.json()) as { job: { id: string } };
  const { rows } = await client.query("SELECT params FROM job WHERE id = $1", [job.id]);
  assert.equal((rows[0].params as { incidentId: string }).incidentId, incidentId);
});
