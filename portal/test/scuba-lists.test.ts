import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";

import { grantRole } from "../../engine/authz/administration.mjs";
import { schemaSql } from "../../engine/store/loadSchema.mjs";
import { createIsolatedTestDatabase } from "../../engine/test/dbTestHelper.mjs";
import { tenantRefFor } from "../../engine/store/tenantRef.mjs";
import { SCUBA_LIST_NAMES } from "../../engine/benchmarks/scubagear/config.mjs";
import {
  neededList,
  reasonWords,
  SCUBA_LIST_INFO,
  scubaListEntryProblem,
  scubaListResultWords,
  scubaListsMissing,
  splitListEntries,
} from "@/lib/compliance-view";
import { CAPABILITIES_HEADER, PRINCIPAL_ID_HEADER } from "@/lib/principal";
import { guardedScubaListUpdate } from "@/lib/scuba-lists";
import { evidenceSentence } from "@/lib/sentences";
import type { ComplianceFinding } from "@/lib/types";

// ScubaGear lists on the Compliance page: the words, the checks on what is typed, and
// the route that saves a list and checks its rule again.

const NONE = { state: "none" as const, linked: [], mismatched: [] };
const finding = (reason: string): ComplianceFinding => ({
  id: "id-1", controlId: "scubagear.MS.SECURITYSUITE.2.1v1", title: null, framework: "cisa-scuba", edition: "2.0.0", profile: "securitysuite", evaluatorVersion: 1,
  verdict: "unknown", reason, evaluatedAt: "2026-10-23T11:00:00Z", evidenceSeq: null, exceptionState: "none", exception: null,
  exposed: false, evidence: [], links: { backup: NONE, change: NONE, restorePlan: NONE },
});

test("a rule waiting for a list says which list, in plain words", () => {
  assert.equal(reasonWords(finding("scubagear:needs-setting:sensitive-users")), "This rule needs your list of sensitive users. Add it under ScubaGear lists.");
  assert.equal(reasonWords(finding("scubagear:needs-setting:partner-domains")), "This rule needs your list of partner domains. Add it under ScubaGear lists.");
  assert.equal(neededList(finding("scubagear:needs-setting:partner-domains")), "partner-domains");
  assert.equal(neededList(finding("scubagear:not-read:spf_records")), null);
  // Every list the engine keeps has words here.
  assert.deepEqual(Object.keys(SCUBA_LIST_INFO).sort(), [...SCUBA_LIST_NAMES].sort());
});

test("what is typed or pasted is split, lower-cased and checked like the engine checks it", () => {
  assert.deepEqual(splitListEntries(" Ada@Contoso.com, ben@contoso.com;\nada@contoso.com "), ["ada@contoso.com", "ben@contoso.com"]);
  assert.equal(scubaListEntryProblem("sensitive-users", "ada@contoso.com"), null);
  assert.equal(scubaListEntryProblem("sensitive-users", "Ada Lovelace"), "\"Ada Lovelace\" is not an email address.");
  assert.equal(scubaListEntryProblem("partner-domains", "fabrikam.com"), null);
  assert.equal(scubaListEntryProblem("partner-domains", "https://fabrikam.com/about"), "Leave out \"https://\": write fabrikam.com only.");
  assert.equal(scubaListEntryProblem("partner-domains", "fabrikam"), "\"fabrikam\" is not a domain name.");
  assert.deepEqual(scubaListsMissing({ lists: [{ list: "sensitive-users", entries: ["a@b.com"] }, { list: "partner-domains", entries: [] }] }), ["partner-domains"]);
  assert.equal(scubaListResultWords("pass", 2), "its rule passes on the newest backup.");
  assert.equal(scubaListResultWords("unknown", 2), "its rule is checked after the next backup.");
  assert.equal(scubaListResultWords(null, 0), "cleared, so its rule could not be checked.");
});

test("a list change reads as a sentence on Activity", () => {
  const entry = (subject: Record<string, unknown>) => ({ kind: "scuba-config-list", subject, occurredAt: "2026-10-30T10:00:00Z" });
  assert.equal(evidenceSentence(entry({ list: "sensitive-users", count: 3 }) as never, "Amara"), "Amara set the ScubaGear list of sensitive users to 3 entries");
  assert.equal(evidenceSentence(entry({ list: "partner-domains", count: 0 }) as never, "Amara"), "Amara cleared the ScubaGear list of partner domains");
});

interface Client {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}
interface Database { url: string; connect(): Promise<Client>; cleanup(): Promise<void> }
let database: Database;
let client: Client;
const TENANT = tenantRefFor("tenant-scuba-lists-portal");
const ADMIN = "1b2a4a00-0000-4000-8000-0000000000b1";
const OPERATOR = "1b2a4a00-0000-4000-8000-0000000000b2";
const deps = () => ({ connect: async () => database.connect(), databaseUrl: () => database.url, tenantRef: () => TENANT });
function request(body: unknown, principal = ADMIN, capabilities = ["read", "configuration"]) {
  return new Request("http://localhost/api/actions/compliance/scuba-lists", { method: "POST", headers: {
    "content-type": "application/json", [PRINCIPAL_ID_HEADER]: principal, [CAPABILITIES_HEADER]: capabilities.join(" "),
  }, body: JSON.stringify(body) });
}

before(async () => {
  if (!process.env.KEEL_DB_TEST_URL) {
    const env = readFileSync("/etc/keel/db.env", "utf8");
    process.env.KEEL_DB_TEST_URL = /^KEEL_DB_TEST_URL=(.*)$/m.exec(env)?.[1];
  }
  database = await createIsolatedTestDatabase(import.meta.url) as Database;
  client = await database.connect();
  await client.query(schemaSql());
  await client.query("INSERT INTO principal (id, email) VALUES ($1, 'admin@scuba-lists.test'), ($2, 'operator@scuba-lists.test')", [ADMIN, OPERATOR]);
  await grantRole(client, { principalId: ADMIN, role: "admin", grantedBy: ADMIN });
  await grantRole(client, { principalId: OPERATOR, role: "operator", grantedBy: ADMIN });
});
after(async () => {
  await client?.end();
  await database?.cleanup();
});

test("saving a list needs configuration, refuses a bad entry, and checks its rule again", async () => {
  const save = guardedScubaListUpdate(deps());
  const users = { list: "sensitive-users", entries: ["Ada@contoso.com"] };
  assert.equal((await save(request(users, OPERATOR, ["read", "collect"]))).status, 403, "the guard needs configuration");
  assert.equal((await save(request(users, OPERATOR))).status, 403, "the engine re-checks the role itself");
  assert.equal((await save(request({ list: "other", entries: [] }))).status, 400);
  const bad = await save(request({ list: "sensitive-users", entries: ["ada"] }));
  assert.deepEqual([bad.status, ((await bad.json()) as { detail: string }).detail], [400, "not an email address: ada"]);

  const saved = await save(request(users));
  assert.equal(saved.status, 200);
  const body = await saved.json() as { changed: boolean; list: { entries: string[]; changedBy: { name: string } | null }; verdict: string; reason: string };
  assert.equal(body.changed, true);
  assert.deepEqual(body.list.entries, ["ada@contoso.com"]);
  // The rule ran at once; this tenant has no mail backup yet, so that is what it waits for.
  assert.deepEqual([body.verdict, body.reason], ["unknown", "exchange-mail-flow:no-observation"]);
  const { rows: ran } = await client.query("SELECT count(*)::int AS n FROM benchmark_evaluation WHERE tenant_ref = $1 AND control_id = 'scubagear.MS.SECURITYSUITE.2.1v1'", [TENANT]);
  assert.equal(ran[0].n, 1);

  // The same list again changes nothing and checks nothing.
  const same = await (await save(request(users))).json() as { changed: boolean; verdict: string | null };
  assert.deepEqual([same.changed, same.verdict], [false, null]);

  const cleared = await (await save(request({ list: "sensitive-users", entries: [] }))).json() as { changed: boolean; list: { entries: string[] } };
  assert.deepEqual([cleared.changed, cleared.list.entries], [true, []]);
  const { rows } = await client.query("SELECT subject FROM evidence WHERE tenant_ref = $1 AND kind = 'scuba-config-list' ORDER BY seq", [TENANT]);
  assert.deepEqual(rows.map((row) => (row.subject as { count: number }).count), [1, 0]);
});
