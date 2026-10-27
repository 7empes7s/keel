import "./next-async-storage";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { createIsolatedTestDatabase } from "../../engine/test/dbTestHelper.mjs";
import { schemaSql } from "../../engine/store/loadSchema.mjs";
import { appendEvidence } from "../../engine/govern/evidence.mjs";
import { anonymityNamer, pseudonym, setAnonymity } from "../../engine/insights/anonymity.mjs";
import { GET as alertsRoute } from "@/app/api/alerts/route";
import { GET as escalationRoute } from "@/app/api/escalation-rules/route";
import { GET as policiesRoute } from "@/app/api/policies/route";
import { actorsForFilter, getActivityNames, hideAddresses, hideEntries, hideSubject } from "@/lib/activity-names";
import { activityCsv, activityRows } from "@/lib/activity-view";
import type { AlertInboxData } from "@/lib/alerts-view";
import { principalPerson, shownAccount, shownTypedPerson } from "@/lib/people-names";
import { withExceptionPeople } from "@/lib/portal-data";
import { ownerName, ownerPerson } from "@/lib/compliance-view";
import { CAPABILITIES_HEADER, PRINCIPAL_ID_HEADER } from "@/lib/principal";
import { tenantRef } from "@/lib/runtime-config";
import type { ComplianceFinding } from "@/lib/types";
import { getValueReport } from "@/lib/value-report";

// "Hide people's names" (Track A3) on the pages that read people straight from the
// principal table: alerts, notification owners, automatic rules, compliance exception
// owners, Activity's raw audit entries and the value report's estimate owner. With the
// setting on, nothing a person is known by (name or address) leaves the server.

const CODE_NAME = /^Person [A-HJ-NP-Z2-9]{4}$/;
const REAL = /Amara|Okafor|Lee Chen|amara@|lee@|contoso\.example/i;

interface TestClient { query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>; end(): Promise<void> }
let database: { url: string; connect(): Promise<TestClient>; cleanup(): Promise<void> };
let client: TestClient;
const AMARA = randomUUID();
const LEE = randomUUID();
let directory = "";

before(async () => {
  if (!process.env.KEEL_DB_TEST_URL) {
    for (const line of readFileSync("/etc/keel/db.env", "utf8").split("\n")) {
      const match = /^KEEL_DB_TEST_URL=(.*)$/.exec(line.trim());
      if (match) process.env.KEEL_DB_TEST_URL = match[1];
    }
  }
  database = await createIsolatedTestDatabase(import.meta.url) as typeof database;
  client = await database.connect();
  await client.query(schemaSql());
  directory = mkdtempSync(join(tmpdir(), "keel-portal-anonymity-pages-"));
  writeFileSync(join(directory, "tenant.json"), JSON.stringify({ tenantId: "anonymity-pages-test" }));
  process.env.KEEL_DB_URL = database.url;
  process.env.KEEL_TENANT_CONFIG_PATH = join(directory, "tenant.json");
  await client.query(
    "INSERT INTO principal (id, email, display_name) VALUES ($1, 'amara@contoso.example', 'Amara Okafor'), ($2, 'lee@contoso.example', 'Lee Chen')",
    [AMARA, LEE],
  );
  for (const role of ["viewer", "admin", "operator", "restorer"]) {
    await client.query("INSERT INTO role_grant (principal_id, role, granted_by) VALUES ($1, $2, 'test')", [AMARA, role]);
  }
  await client.query("INSERT INTO role_grant (principal_id, role, granted_by) VALUES ($1, 'restorer', 'test')", [LEE]);
});

after(async () => {
  await client.end();
  await database.cleanup();
});

async function hidden<T>(run: () => Promise<T>): Promise<T> {
  await setAnonymity(client, { tenantRef: tenantRef(), enabled: true, actor: AMARA });
  try {
    return await run();
  } finally {
    await setAnonymity(client, { tenantRef: tenantRef(), enabled: false, actor: AMARA });
  }
}

function request(path: string, capabilities: string[]): Request {
  return new Request(`http://localhost${path}`, { headers: { [PRINCIPAL_ID_HEADER]: AMARA, [CAPABILITIES_HEADER]: capabilities.join(" ") } });
}

test("the helpers code-name people, addresses and typed owners only while names are hidden", () => {
  const namer = anonymityNamer({ enabled: true, salt: "salt-a" });
  const row = { id: AMARA, email: "amara@contoso.example", display_name: "Amara Okafor", system_kind: null };
  assert.equal(principalPerson(row, null).name, "Amara Okafor");
  const shown = principalPerson(row, namer);
  assert.equal(shown.name, pseudonym("salt-a", "amara@contoso.example"));
  assert.equal(shown.email, null);
  assert.equal(shown.pseudonym, true);
  // Keel's own accounts keep their names.
  assert.equal(principalPerson({ id: "s", email: "scheduler@keel.local", display_name: "Scheduler", system_kind: "scheduler" }, namer).name, "Scheduler");
  // A stored address takes the person's code name; a stored id stays (Technical details).
  assert.equal(shownAccount("Amara@Contoso.example ", namer), shown.name);
  assert.equal(shownAccount(AMARA, namer), AMARA);
  assert.equal(shownAccount("amara@contoso.example", null), "amara@contoso.example");
  // A typed owner gets a code name whether it is an address or a name.
  assert.equal(shownTypedPerson("amara@contoso.example", namer), shown.name);
  assert.match(String(shownTypedPerson("Finance team", namer)), CODE_NAME);
});

test("Activity: actors recorded by email, addresses and owners in a subject become code names; ids and keys stay", () => {
  const namer = anonymityNamer({ enabled: true, salt: "salt-a" })!;
  const amara = pseudonym("salt-a", "amara@contoso.example");
  assert.deepEqual(hideSubject({ owner: "Amara Okafor", reason: "asked by lee@contoso.example", count: 2, owners: [AMARA], ownerPrincipalId: AMARA, nested: { mail: "amara@contoso.example" } }, namer), {
    owner: pseudonym("salt-a", "amara okafor"), reason: `asked by ${pseudonym("salt-a", "lee@contoso.example")}`, count: 2, owners: [AMARA], ownerPrincipalId: AMARA, nested: { mail: amara },
  });
  // A key prefix stays, and the address inside it gets the person's own code name.
  assert.equal(hideSubject("user:amara@contoso.example", namer), `user:${amara}`);
  assert.equal(hideSubject("Asked by amara@contoso.example.", namer), `Asked by ${amara}.`);
  assert.equal(hideSubject("roleAssignment:global:GlobalAdministrator@user:amara@contoso.example@/", namer), `roleAssignment:global:GlobalAdministrator@user:${amara}@/`);
  const person = { kind: "person", id: amara, name: amara, email: null, readable: true, system: false, pseudonym: true };
  const { entries, people } = hideEntries([
    { seq: "2", occurred_at: "2026-10-01T08:00:00Z", kind: "access-denied", actor: "amara@contoso.example", subject: { action: "restore" } },
    { seq: "1", occurred_at: "2026-10-01T07:00:00Z", kind: "benchmark-exception", actor: AMARA, subject: { owner: "lee@contoso.example" } },
  ], { "amara@contoso.example": person, [AMARA]: { ...person, id: AMARA } }, namer);
  assert.equal(entries[0].actor, amara);
  assert.equal(entries[1].actor, AMARA);
  assert.deepEqual(entries[1].subject, { owner: pseudonym("salt-a", "lee@contoso.example") });
  assert.deepEqual(Object.keys(people).sort(), [AMARA, amara].sort());
  // The spreadsheet made from these rows names nobody.
  const csv = activityCsv(activityRows([], entries, people, {}, "2026-10-02T00:00:00Z"));
  assert.doesNotMatch(csv, REAL);
  assert.match(csv, new RegExp(amara));
});

test("Activity: the page data and the Who filter carry code names, and the filter still finds the stored actor", async () => {
  await appendEvidence(client, { tenantRef: tenantRef(), kind: "access-denied", actor: "amara@contoso.example", subject: { action: "restore", note: "by lee@contoso.example" } });
  const entries = (await client.query("SELECT seq::text AS seq, occurred_at::text AS occurred_at, kind, actor, subject FROM evidence WHERE actor = 'amara@contoso.example'")).rows as never[];
  assert.ok(entries.length > 0);
  // Off: unchanged.
  const shown = await getActivityNames(["amara@contoso.example"], [], entries);
  assert.equal(shown.entries, undefined);
  assert.deepEqual(await actorsForFilter(["amara@contoso.example"]), ["amara@contoso.example"]);
  await hidden(async () => {
    const names = await getActivityNames(["amara@contoso.example", AMARA], [], entries);
    assert.ok(names.entries);
    const code = names.entries![0].actor;
    assert.match(code, CODE_NAME);
    assert.doesNotMatch(JSON.stringify(names), REAL);
    assert.equal(names.people[code]?.name, code);
    // The Keel user and the same person recorded by address share one code name.
    assert.equal(names.people[AMARA]?.name, code);
    // A "Who" filter by code name reads back to the stored address for the audit query.
    assert.deepEqual(await actorsForFilter([code]), ["amara@contoso.example"]);
    assert.deepEqual(await actorsForFilter([code, AMARA]), [AMARA, "amara@contoso.example"]);
    // A code name in the filter alone is still a person, never "Keel".
    const filtered = await getActivityNames(["Person ZZZZ"], [], []);
    assert.equal(filtered.people["Person ZZZZ"]?.system, false);
    assert.equal(filtered.people["Person ZZZZ"]?.pseudonym, true);
  });
});

test("Activity: when the names lookup fails, addresses are blanked rather than sent", () => {
  const [entry] = hideAddresses([{ seq: "1", occurred_at: "2026-10-01T07:00:00Z", kind: "access-denied", actor: "amara@contoso.example", subject: { note: "by lee@contoso.example", key: "user:lee@contoso.example" } }]);
  assert.equal(entry.actor, "a person");
  assert.doesNotMatch(JSON.stringify(entry), REAL);
});

test("Alerts: owner, who acknowledged and who acted show by code names", async () => {
  const { rows: [alert] } = await client.query(
    `INSERT INTO alert (tenant_ref, resource_key, control, condition, state, condition_active, severity, first_opened_at, occurrence_started_at,
                        last_firing_at, last_observed_at, last_event_id, owner_principal_id, acknowledged_by, acknowledged_at)
     VALUES ($1, 'group:Finance', 'drift', 'changed', 'acknowledged', true, 'warning', now(), now(), now(), now(), 'e1', $2, $3, now()) RETURNING id`,
    [tenantRef(), LEE, AMARA],
  );
  assert.ok(alert);
  const plain = await (await alertsRoute(request("/api/alerts", ["read"]))).json() as AlertInboxData;
  assert.equal(plain.alerts[0].owner?.name, "Lee Chen");
  const body = await hidden(async () => await (await alertsRoute(request("/api/alerts", ["read"]))).json() as AlertInboxData);
  assert.match(body.alerts[0].owner?.name ?? "", CODE_NAME);
  assert.equal(body.alerts[0].owner?.pseudonym, true);
  assert.match(body.alerts[0].acknowledgedByName ?? "", CODE_NAME);
  assert.doesNotMatch(JSON.stringify(body), REAL);
});

test("Notifications: an escalation owner shows by code name, without an email", async () => {
  const { rows: [channel] } = await client.query("INSERT INTO channel (kind, config) VALUES ('webhook', '{\"url\":\"https://hooks.example.org/x\"}') RETURNING id");
  await client.query(
    "INSERT INTO alert_escalation_rule (tenant_ref, min_severity, ack_within_ms, owner_principal_id, escalate_channel_id, created_by) VALUES ($1, 'warning', 3600000, $2, $3, $4)",
    [tenantRef(), LEE, channel.id, AMARA],
  );
  const plain = await (await escalationRoute(request("/api/escalation-rules", ["read", "configuration"]))).json() as { escalationRules: Record<string, unknown>[] };
  assert.equal(plain.escalationRules[0].owner_name, "Lee Chen");
  const body = await hidden(async () => await (await escalationRoute(request("/api/escalation-rules", ["read", "configuration"]))).json() as { escalationRules: Record<string, unknown>[] });
  assert.match(String(body.escalationRules[0].owner_name), CODE_NAME);
  assert.equal(body.escalationRules[0].owner_email, null);
  assert.doesNotMatch(JSON.stringify(body), REAL);
});

test("Automatic rules: the account a rule acts as shows by code name", async () => {
  await client.query(
    "INSERT INTO policy (tenant_ref, name, action, max_blast_radius, created_by, run_as_principal_id, enabled) VALUES ($1, 'Undo sharing changes', 'auto_remediate', 'cosmetic', $2, $3, false)",
    [tenantRef(), AMARA, LEE],
  );
  type Listed = { policies: { run_as_principal: { name: string | null; email: string | null } | null }[] };
  const plain = await (await policiesRoute(request("/api/policies", ["policies"]))).json() as Listed;
  assert.equal(plain.policies[0].run_as_principal?.name, "Lee Chen");
  const body = await hidden(async () => await (await policiesRoute(request("/api/policies", ["policies"]))).json() as Listed);
  assert.match(body.policies[0].run_as_principal?.name ?? "", CODE_NAME);
  assert.equal(body.policies[0].run_as_principal?.email, null);
  assert.doesNotMatch(JSON.stringify(body), REAL);
});

test("Compliance: an exception owner shows by code name, and the typed value is not sent", async () => {
  const finding = (owner: string) => ({ exception: { id: randomUUID(), owner, reason: "agreed", grantedBy: AMARA, grantedAt: null, expiresAt: null } }) as unknown as ComplianceFinding;
  const plain = await withExceptionPeople(client, [finding("amara@contoso.example"), finding("Finance team")]);
  assert.equal(ownerName(plain[0]), "Amara Okafor");
  const shown = await hidden(() => withExceptionPeople(client, [finding("amara@contoso.example"), finding("Finance team")]));
  assert.match(ownerName(shown[0]), CODE_NAME);
  assert.equal(ownerPerson(shown[0])?.pseudonym, true);
  assert.match(ownerName(shown[1]), CODE_NAME);
  assert.equal(shown[0].exception?.owner, null);
  assert.match(shown[0].exception?.grantedByRef?.name ?? "", CODE_NAME);
  assert.equal(shown[0].exception?.grantedByRef?.name, ownerName(shown[0]), "the same person keeps one code name");
  assert.doesNotMatch(JSON.stringify(shown), REAL);
});

test("Value report: the estimate owner is a code name on the page and in its downloads", async () => {
  const estimate = join(directory, "estimate.json");
  writeFileSync(estimate, JSON.stringify({ minutesPerVerifiedOutcome: { restore: 30 }, assumptions: ["A restore takes half an hour by hand"], owner: "amara@contoso.example" }));
  process.env.KEEL_VALUE_ESTIMATE_PATH = estimate;
  try {
    const period = { from: new Date(Date.now() - 7 * 86_400_000).toISOString(), to: new Date().toISOString() } as Parameters<typeof getValueReport>[0]["period"];
    const plain = await getValueReport({ scope: { central: true, entities: [] }, period });
    assert.equal(plain.hoursSaved?.owner, "amara@contoso.example");
    const report = await hidden(() => getValueReport({ scope: { central: true, entities: [] }, period }));
    assert.match(report.hoursSaved?.owner ?? "", CODE_NAME);
    assert.doesNotMatch(JSON.stringify(report), REAL);
  } finally {
    delete process.env.KEEL_VALUE_ESTIMATE_PATH;
  }
});
