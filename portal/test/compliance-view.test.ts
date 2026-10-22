import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { addDays, endOfDay, grantException } from "@/lib/compliance-change";
import {
  complianceCounts,
  complianceStatus,
  complianceVerdict,
  controlName,
  controlService,
  exceptionChip,
  exceptionRefusal,
  findingTypes,
  grantLabel,
  lastChecked,
  linkedChangeName,
  orderFindings,
  ownerName,
  reasonWords,
  resultLine,
  resultOf,
  storageSentence,
} from "@/lib/compliance-view";
import { databaseIsLocal } from "@/lib/runtime-config";
import type { ComplianceData, ComplianceFinding } from "@/lib/types";
import { renderComplianceAt } from "./render-compliance";

const NOW = "2026-10-02T09:40:00Z";
const NONE = { state: "none" as const, linked: [], mismatched: [] };
const finding = (id: string, controlId: string, verdict: ComplianceFinding["verdict"], extra: Partial<ComplianceFinding> = {}): ComplianceFinding => ({
  id: `e7a10000-0000-4000-8000-0000000000${id}`, controlId, title: "Registry wording", framework: "keel-custom", edition: "1", profile: "default", evaluatorVersion: 1,
  verdict, reason: null, evaluatedAt: "2026-10-02T09:20:00Z", evidenceSeq: null, exceptionState: "none", exception: null,
  exposed: verdict === "fail", evidence: [], links: { backup: NONE, change: NONE, restorePlan: NONE }, ...extra,
});
const ROLE = "keel-custom.role-assignment.admin-count-at-most";
const LOCATION = "keel-custom.named-location.no-untrusted-all-countries";
const GROUP = "keel-custom.group.role-assignable-not-synced";
const ENDED = finding("e1", ROLE, "fail", {
  exceptionState: "expired",
  exception: { id: "x1", owner: "secops@contoso.com", reason: "Migration", grantedBy: "p1", grantedAt: "2026-09-01T10:00:00Z", expiresAt: "2026-09-30T09:40:00Z" },
  links: { backup: NONE, restorePlan: NONE, change: { state: "linked", mismatched: [], linked: [{ id: "d1", naturalKey: "roleAssignment:Global Administrator · adele.vance@contoso.com", resourceType: "roleAssignment", changeType: "added", snapshotId: "s1", detectedAt: "2026-10-02T09:14:00Z" }] } },
});
const ACCEPTED = finding("e2", LOCATION, "fail", {
  exposed: false, exceptionState: "authorized",
  exception: { id: "x2", owner: "amara@contoso.example", reason: "Proxy", grantedBy: "p1", grantedAt: "2026-09-15T10:00:00Z", expiresAt: "2026-11-30T00:00:00Z", ownerRef: { kind: "person", id: "p2", name: "Amara Okafor", href: "/principals" } },
});
const STALE = finding("e3", GROUP, "unknown", { reason: "group:stale-observation" });
const PASS = finding("e4", "keel-custom.conditional-access.block-legacy", "pass");
const DATA: ComplianceData = {
  generatedAt: NOW, activeBaseline: null,
  summary: { controls: 4, exposed: 1, excepted: 1, expiredExceptions: 1, incompleteExceptions: 0, passing: 1, unknown: 1, notApplicable: 0 },
  storage: { configured: true, provider: "local-disk", region: "westeurope", boundary: null, immutability: "unsupported", generatedAt: null, certifies: null, source: "/x" } as ComplianceData["storage"],
  findings: [PASS, STALE, ACCEPTED, ENDED],
};

test("Compliance words: plain titles, results, reasons, owners and the verdict", () => {
  assert.equal(controlName(ENDED), "No more than 5 people hold the top admin role");
  assert.equal(controlName(finding("e9", "custom.unknown", "pass", { title: null })), "A control Keel no longer holds");
  assert.equal(findingTypes(ACCEPTED), "trusted locations");
  assert.equal(controlService(STALE).name, "Entra ID");
  assert.deepEqual([ENDED, ACCEPTED, STALE, PASS].map(resultOf), ["failing", "excepted", "unknown", "passing"]);
  assert.deepEqual(orderFindings(DATA.findings).map((item) => item.id), [ENDED.id, ACCEPTED.id, STALE.id, PASS.id]);
  assert.equal(resultLine(ENDED, NOW), "Exception ended 2 days ago");
  assert.equal(resultLine(ACCEPTED, NOW), "Accepted until 30 Nov 2026");
  assert.equal(reasonWords(STALE), "The newest group backup is too old for this check.");
  assert.equal(reasonWords(finding("e8", ROLE, "unknown", { reason: "roleAssignment:no-observation" })), "No backup of admin role assignments has been made yet.");
  assert.equal(ownerName(ENDED), "Secops");
  assert.equal(ownerName(ACCEPTED), "Amara Okafor");
  assert.deepEqual(exceptionChip(ENDED, NOW), { tone: "urgent", label: "Ended 2 days ago" });
  assert.equal(grantLabel(ENDED), "Renew the exception");
  assert.equal(grantLabel(finding("e7", ROLE, "fail")), "Grant an exception");
  assert.equal(linkedChangeName(ENDED.links.change.linked[0]), "Global Administrator · Adele Vance added");

  const counts = complianceCounts(DATA.findings);
  assert.deepEqual([counts.failing, counts.excepted, counts.unknown, counts.passing, counts.ended], [1, 1, 1, 1, 1]);
  assert.deepEqual(complianceStatus(counts), { tone: "urgent", label: "1 failing" });
  assert.equal(complianceVerdict(DATA).text, "1 control fails, and its exception ended 2 days ago.");
  assert.equal(complianceVerdict({ ...DATA, findings: [PASS, ACCEPTED] }).text, "All 2 checked controls pass or have a current exception.");
  assert.equal(complianceVerdict({ ...DATA, findings: [PASS, STALE] }).text, "No control fails; 1 control could not be checked.");
  assert.deepEqual(complianceStatus(complianceCounts([])), { tone: "low", label: "Not checked yet" });
  assert.equal(storageSentence(DATA.storage), "Backups are kept on this server's disk (West Europe).");
  assert.equal(exceptionRefusal(400, "expiry_in_future"), "Pick an end date after today.");
  assert.equal(exceptionRefusal(403, "forbidden"), "You need the configuration permission to grant an exception.");
});

test("Compliance body: a tile sets result=, the filter shows only that result, no email or code in view", async () => {
  const all = await renderComplianceAt("", { data: DATA, canConfigure: true, now: NOW });
  assert.match(all, /href="\/benchmarks\?result=failing"/);
  for (const name of ["No more than 5 people hold the top admin role", "No trusted location trusts unknown countries", "Groups that grant admin roles are not copied from on-premises", "Old sign-in methods are blocked"]) assert.ok(all.includes(name), name);
  assert.match(all, /href="\/benchmarks\?open=e7a10000-0000-4000-8000-0000000000e1"/);
  assert.match(all, /Renew exception/);
  const failing = await renderComplianceAt("result=failing", { data: DATA, canConfigure: true, now: NOW });
  assert.match(failing, /Showing <b>1<\/b> of 4 controls/);
  assert.match(failing, /href="\/benchmarks\?result=failing%2Cpassing"/, "Passing adds to Failing");
  const list = failing.slice(failing.indexOf('aria-labelledby="cp-controls-heading"'));
  assert.ok(list.includes("No more than 5 people hold the top admin role"));
  assert.ok(!list.slice(0, list.indexOf("cp-storage")).includes("Old sign-in methods are blocked"));

  const visible = all
    .replace(/<details class="technical-details"[\s\S]*?<\/details>/g, "")
    .replace(/\s(data-row-id|href|title|id|for|aria-labelledby)="[^"]*"/g, "")
    .replace(/<[^>]+>/g, " ");
  for (const banned of ["@contoso", "westeurope", "KEEL", "Baseline", "Conditional Access", "Named location", "keel-custom"]) assert.ok(!visible.includes(banned), banned);
  assert.doesNotMatch(visible, /[0-9a-f]{8}-[0-9a-f]{4}-/);

  const viewer = await renderComplianceAt("", { data: DATA, canConfigure: false, now: NOW });
  assert.doesNotMatch(viewer, /Renew exception|Grant exception|btn-primary/);
});

test("Nothing checked yet: every empty state names the next step with a button", async () => {
  const unset = { configured: false, provider: null, region: null, boundary: null, immutability: "unknown", generatedAt: null, certifies: null, source: null } as ComplianceData["storage"];
  const empty: ComplianceData = { ...DATA, findings: [], storage: unset, summary: { ...DATA.summary, controls: 0 } };
  assert.equal(complianceVerdict(empty).detail, "Keel checks these after each backup. Results show here after the next backup or check.");
  assert.equal(lastChecked([], NOW), null);
  assert.equal(lastChecked(DATA.findings, NOW), "Last checked 20 minutes ago.");

  // Someone who runs backups: Check now in the verdict and in the empty list.
  const operator = await renderComplianceAt("", { data: empty, canConfigure: false, canCheck: true, now: NOW });
  assert.match(operator, /<button[^>]*class="btn btn-primary primary"[^>]*>Check now<\/button>/);
  assert.equal((operator.match(/>Check now<\/button>/g) ?? []).length, 2);
  assert.match(operator, /Keel checks these after each backup\./);
  assert.doesNotMatch(operator, /does not run these checks/);
  // Storage not known: tinted, says what to do, and links to the storage section.
  assert.match(operator, /class="cp-storage" data-tone="soon"/);
  assert.match(operator, /Ask whoever runs the Keel server to record where backups are stored\./);
  assert.match(operator, /href="\/resilience#storage"[^>]*>.*See backup storage<\/a>/);

  // A viewer cannot run a check: a link to when backups run, never a dead end.
  const viewer = await renderComplianceAt("", { data: empty, canConfigure: false, now: NOW });
  assert.doesNotMatch(viewer, /Check now/);
  assert.match(viewer, /href="\/schedules"[^>]*>See when backups run<\/a>/);

  // With results: when they were made, and Check now beside it; storage known has no button.
  const checked = await renderComplianceAt("", { data: DATA, canConfigure: true, canCheck: true, now: NOW });
  assert.match(checked, /Results come from the last check\. Last checked 20 minutes ago\./);
  assert.equal((checked.match(/>Check now<\/button>/g) ?? []).length, 1);
  assert.doesNotMatch(checked, /See backup storage/);
});

test("Backups sit on this server when Keel's database does", () => {
  for (const url of ["postgres://keel@localhost:5432/keel", "postgresql://keel:pw@127.0.0.1/keel", "postgres://[::1]/keel", "postgres:///keel", "postgres://keel@/keel?host=/var/run/postgresql"]) {
    assert.equal(databaseIsLocal(url), true, url);
  }
  for (const url of ["postgres://keel@db.example.com/keel", "postgres://keel@10.0.0.4/keel", "not a url"]) assert.equal(databaseIsLocal(url), false, url);
});

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test("Grant an exception posts to the compliance route and words a refusal", async () => {
  const calls: { url: string; body: unknown }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return calls.length === 1 ? new Response("{}", { status: 201 }) : Response.json({ error: "expiry_in_future" }, { status: 400 });
  }) as typeof fetch;
  const body = { evaluationId: ENDED.id, owner: "secops@contoso.com", reason: "Cut-over", expiresAt: endOfDay(addDays("2026-10-02", 90))! };
  assert.deepEqual(await grantException(body), { ok: true });
  assert.deepEqual(await grantException(body), { ok: false, reason: "Pick an end date after today." });
  assert.equal(calls[0].url, "/api/actions/compliance/exception");
  assert.deepEqual(calls[0].body, { ...body, expiresAt: "2026-12-31T23:59:59.000Z" });
});
