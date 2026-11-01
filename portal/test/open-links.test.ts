import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

import { grantRole } from "../../engine/authz/administration.mjs";
import { applyConditionEvent } from "../../engine/notify/alerts.mjs";
import { schemaSql } from "../../engine/store/loadSchema.mjs";
import { tenantRefFor } from "../../engine/store/tenantRef.mjs";
import { createIsolatedTestDatabase } from "../../engine/test/dbTestHelper.mjs";
import { CLOSED_LIMIT, guardedAlertInbox } from "@/lib/alerts";
import type { AlertInboxData, AlertItem } from "@/lib/alerts-view";
import { COVERAGE_LINKS } from "@/lib/overview-view";
import { coverageBuckets, matchesHealth } from "@/lib/protect-view";
import { CAPABILITIES_HEADER, PRINCIPAL_ID_HEADER } from "@/lib/principal";
import type { CoverageType } from "@/lib/types";
import { renderAlertsAt } from "./render-alerts";

// A link that opens one item on another page (`/alerts?open=<id>`) must open that item,
// or say plainly that it is not there. Before this, "Review the sign-in" on Emergency
// access could land on the plain Alerts list: the inbox lists every open alert but only
// the most recent closed ones (CLOSED_LIMIT), and an older closed sign-in fell outside.

const portal = fileURLToPath(new URL("../", import.meta.url));

function sources(directory: string): { file: string; text: string }[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sources(path);
    return /\.tsx?$/.test(entry.name) ? [{ file: path, text: readFileSync(path, "utf8") }] : [];
  });
}

// Every page another page links into with `?open=`, and the component that reads it.
const OPEN_TARGETS: Record<string, string> = {
  "/alerts": "components/alerts/alerts-page.tsx",
  "/drift": "components/baselines/change-list.tsx",
  "/principals": "components/people/people-page.tsx",
  "/schedules": "components/schedules/schedules-page.tsx",
};

test("every ?open= link goes to a page that opens the item or says it is not there", () => {
  const found = new Set<string>();
  for (const { text } of ["app", "components", "lib"].flatMap((dir) => sources(resolve(portal, dir)))) {
    for (const match of text.matchAll(/["'`](\/[a-z][a-z0-9/-]*)\?open=/g)) found.add(match[1]);
  }
  assert.ok(found.size >= 3, "the scan finds the links");
  for (const route of found) {
    assert.ok(OPEN_TARGETS[route], `${route}?open= is linked to: add its page to OPEN_TARGETS and show MissingOpened there`);
  }
  for (const [route, file] of Object.entries(OPEN_TARGETS)) {
    const text = readFileSync(resolve(portal, file), "utf8");
    assert.match(text, /view\.get\("open"\)/, `${route} reads open= from the address`);
    assert.match(text, /<MissingOpened /, `${route} says when the linked item is not there`);
  }
});

const NOW = "2026-10-02T09:40:00Z";
const item = (id: string, name: string): AlertItem => ({
  id, resourceKey: `user:${name}`, name, control: "break-glass", condition: "emergency-account-used",
  state: "open", conditionActive: true, severity: "critical", occurrence: 1, firstOpenedAt: "2026-10-01T09:00:00Z",
  occurrenceStartedAt: "2026-10-01T09:00:00Z", lastFiringAt: "2026-10-01T09:00:00Z", ackDeadlineAt: null,
  acknowledgedAt: null, acknowledgedByName: null, owner: null, escalated: false, escalationError: null,
  cause: { changeType: null, resourceType: "user", snapshotId: null }, lastEventId: "e", history: [],
});
const LISTED = item("a1e70000-0000-4000-8000-000000000001", "Emergency admin 1");
const LINKED = item("a1e70000-0000-4000-8000-000000000094", "Emergency admin 2");

// The panel itself is a portal, so opening the linked alert is covered in Playwright.
test("Alerts: a linked alert is not added to the list, and a missing one says so", async () => {
  const props = { alerts: [LISTED], now: NOW, canRespond: true, canMute: true };
  const linked = await renderAlertsAt("", { ...props, linked: LINKED });
  assert.equal([...linked.matchAll(/class="al-row-link"/g)].length, 1, "the list still holds only the listed alert");
  assert.doesNotMatch(linked, /Emergency admin 2/, "nor its counts or records");
  const missing = await renderAlertsAt("open=a1e70000-0000-4000-8000-0000000000ff", props);
  assert.match(missing, /data-missing-opened/);
  assert.match(missing, /The alert this link points to is not here/);
  const plain = await renderAlertsAt("", props);
  assert.doesNotMatch(plain, /data-missing-opened/);
});

// The ring's parts and the What's protected filters they open are the same coverage
// buckets (coverageBuckets): each filter lists exactly the kinds its part counts.
test("Overview's Not backed up and Not on this tenant open What's protected filtered to their bucket", () => {
  assert.equal(COVERAGE_LINKS.uncovered, "/protect?health=not-backed-up");
  assert.equal(COVERAGE_LINKS.unavailable, "/protect?health=not-on-tenant");
  const kind = (over: Partial<CoverageType>) => ({ type: "group", adapter: "groups", protectionState: "covered", outcome: "complete", reportStatus: "covered", lastCollectedAt: NOW, stale: false, itemCount: 3, ...over }) as unknown as CoverageType;
  const kinds = [
    kind({}),
    kind({ type: "never", reportStatus: "never-collected", lastCollectedAt: null }),
    kind({ type: "none", protectionState: "not-covered", adapter: null }),
    kind({ type: "stale", stale: true }),
    kind({ type: "failed", outcome: "failed" }),
    kind({ type: "unavailable", outcome: "unavailable" }),
  ];
  const buckets = coverageBuckets(kinds);
  const listed = (filter: Parameters<typeof matchesHealth>[1]) => kinds.filter((entry) => matchesHealth(entry, filter));
  assert.equal(listed("not-backed-up").length, buckets.notCollected, "Not backed up lists the kinds the ring counts");
  assert.equal(listed("not-on-tenant").length, buckets.unavailable, "Not on this tenant lists the kinds the ring counts");
  assert.equal(matchesHealth(kinds[2], "not-backed-up"), true, "no collector yet");
  assert.equal(matchesHealth(kinds[1], "not-backed-up"), false, "never backed up is in Out of date or never");
  assert.equal(matchesHealth(kinds[0], "not-backed-up"), false, "backed up");
  assert.equal(matchesHealth(kinds[3], "not-backed-up"), false, "out of date is its own tile");
  assert.equal(matchesHealth(kinds[4], "not-backed-up"), false, "failed is its own tile");
});

interface Client { query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>; end(): Promise<void> }
interface Database { url: string; connect(): Promise<Client>; cleanup(): Promise<void> }
let database: Database;
let client: Client;
const TENANT = tenantRefFor("tenant-open-links");
const OTHER = tenantRefFor("tenant-open-links-other");
const VIEWER = "1b2a4a00-0000-4000-8000-0000000000b1";
const T0 = Date.parse("2026-10-01T00:00:00Z");
const deps = () => ({ connect: async () => database.connect(), databaseUrl: () => database.url, tenantRef: () => TENANT });
const inbox = async (search = "") => {
  const response = await guardedAlertInbox(deps())(new Request(`http://localhost/api/alerts${search}`, { headers: { [PRINCIPAL_ID_HEADER]: VIEWER, [CAPABILITIES_HEADER]: "read" } }));
  assert.equal(response.status, 200);
  return await response.json() as AlertInboxData;
};
let oldest = "";
let elsewhere = "";

before(async () => {
  if (!process.env.KEEL_DB_TEST_URL) {
    const env = readFileSync("/etc/keel/db.env", "utf8");
    process.env.KEEL_DB_TEST_URL = /^KEEL_DB_TEST_URL=(.*)$/m.exec(env)?.[1];
  }
  database = await createIsolatedTestDatabase(import.meta.url) as Database;
  client = await database.connect();
  await client.query(schemaSql());
  await client.query("INSERT INTO principal (id, email) VALUES ($1, 'viewer@open-links.test')", [VIEWER]);
  await grantRole(client, { principalId: VIEWER, role: "viewer", grantedBy: VIEWER });
  const fire = (tenantRef: string, key: string, seconds: number) => applyConditionEvent(client, {
    tenantRef, resourceKey: key, control: "baseline", condition: "drift", status: "firing", eventId: `e-${key}`, occurredAt: new Date(T0 + seconds * 1000), hysteresis: undefined,
  });
  // CLOSED_LIMIT + 1 closed alerts: the newest fill the inbox's closed part, the first
  // one is left past it. Open alerts are all listed, so only a closed one can fall out.
  oldest = String((await fire(TENANT, "user:bg2", 0)).alert.id);
  for (let index = 1; index <= CLOSED_LIMIT; index += 1) await fire(TENANT, `group:g${index}`, index);
  await client.query("UPDATE alert SET state = 'resolved' WHERE tenant_ref = $1", [TENANT]);
  await client.query("UPDATE alert SET updated_at = $2 WHERE id = $1", [oldest, new Date(T0 - 86_400_000)]);
  elsewhere = String((await fire(OTHER, "user:bg9", 0)).alert.id);
});
after(async () => {
  await client?.end();
  await database?.cleanup();
});

test("the alerts read sends a linked closed alert past the list, apart from it", async () => {
  const plain = await inbox();
  assert.equal(plain.alerts.length, CLOSED_LIMIT);
  assert.ok(!plain.alerts.some((alert) => alert.id === oldest), "the oldest alert is past the inbox's limit");
  assert.equal(plain.linked, undefined);

  const opened = await inbox(`?open=${oldest}`);
  assert.equal(opened.linked?.id, oldest, "the link's alert comes back");
  assert.equal(opened.linked?.resourceKey, "user:bg2");
  assert.equal(opened.alerts.length, CLOSED_LIMIT, "the list stays the same");
  assert.deepEqual(opened.counts, plain.counts, "and so do the counts");
  assert.ok(!opened.alerts.some((alert) => alert.id === oldest));

  const listed = plain.alerts[0].id;
  assert.equal((await inbox(`?open=${listed}`)).linked, undefined, "an alert already listed is not sent twice");
  assert.equal((await inbox(`?open=${elsewhere}`)).linked, undefined, "another tenant's alert is never sent");
  assert.equal((await inbox("?open=not-an-id")).linked, undefined);
  assert.equal((await inbox(`?open=${oldest.toUpperCase()}`)).linked?.id, oldest, "an upper-case id still finds it");
});
