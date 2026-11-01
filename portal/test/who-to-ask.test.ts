import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { grantRole } from "../../engine/authz/administration.mjs";
import { createIsolatedTestDatabase } from "../../engine/test/dbTestHelper.mjs";
import { schemaSql } from "../../engine/store/loadSchema.mjs";
import { CompareForm } from "@/components/baselines/compare-form";
import { storageUnsetTodo } from "@/lib/compliance-view";
import { previewAlerts } from "@/lib/policy-preview-view";
import { readContacts } from "@/lib/portal-data";
import { askServerAdmin, askWho, ADMIN_ROLE, investigatorLine, orList } from "@/lib/who-to-ask";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { renderIncidentsAt } from "./render-incidents";

// UI audit D12: a page that cannot do something for the reader names who can, or links
// to where it is done. "Ask your server admin" with no name and no link is a dead end.

test("names read as a short list with the role", () => {
  assert.equal(orList(["Ana"]), "Ana");
  assert.equal(orList(["Ana", "Ben"]), "Ana or Ben");
  assert.equal(orList(["Ana", "Ben", "Cy"]), "Ana, Ben or Cy");
  assert.equal(orList(["Ana", "Ben", "Cy", "Di", "Ed"]), "Ana, Ben, Cy or 2 others");
  assert.equal(askWho(["Ana"], ADMIN_ROLE), "Ana (Keel admin)");
  assert.equal(askWho(["Ana", "Ben"], ADMIN_ROLE), "Ana or Ben (Keel admins)");
  assert.equal(askWho([], ADMIN_ROLE), "a Keel admin");
  assert.equal(askWho(null, ADMIN_ROLE), "a Keel admin");
});

test("server work names the Keel admins, and never tells an admin to ask themselves", () => {
  const task = "fix the daily off-site copy on the Keel server";
  assert.equal(askServerAdmin({ admins: ["Ana"], investigators: [] }, task), "Ask Ana (Keel admin) to fix the daily off-site copy on the Keel server.");
  assert.equal(askServerAdmin({ admins: [], investigators: [], youAreAdmin: true }, task), "As the Keel admin, fix the daily off-site copy on the Keel server.");
  assert.equal(askServerAdmin({ admins: ["Ben"], investigators: [], youAreAdmin: true }, task), "As a Keel admin, fix the daily off-site copy on the Keel server yourself or ask Ben (Keel admin).");
  assert.equal(askServerAdmin(null, task), "Ask a Keel admin to fix the daily off-site copy on the Keel server.");
  assert.match(storageUnsetTodo({ admins: ["Ana"], investigators: [] }), /^Ask Ana \(Keel admin\) to record where backups are stored/);
});

test("a reader who is not an investigator is told who is, or who can give the role", () => {
  assert.equal(investigatorLine({ admins: ["Ana"], investigators: ["Ines", "Ivo"] }, false), "Only investigators can open or change incidents. Ask Ines or Ivo (investigators).");
  assert.match(investigatorLine({ admins: [], investigators: [], youAreAdmin: true }, true), /nobody has the role yet\. You can give it to yourself/);
  assert.match(investigatorLine({ admins: ["Ana"], investigators: [] }, false), /nobody has the role yet\. Ask Ana \(Keel admin\) to give it to someone\./);
  assert.match(investigatorLine(null, false), /Ask a Keel admin who has the role, or for the role\./);
});

test("Incidents without the investigator role: names investigators, and an admin can give themselves the role", async () => {
  const contacts = { admins: ["Ana Admin"], investigators: ["Ines Investigator"] };
  const viewer = await renderIncidentsAt("", { incidents: [], selected: null, now: "2026-10-02T09:40:00Z", canInvestigate: false, contacts });
  assert.match(viewer, /data-who-to-ask="investigator"/);
  assert.match(viewer, /Ask Ines Investigator \(investigator\)\./);
  assert.doesNotMatch(viewer, />Give yourself the Investigator role</, "only an admin can add roles");

  const admin = await renderIncidentsAt("", {
    incidents: [], selected: null, now: "2026-10-02T09:40:00Z", canInvestigate: false,
    contacts: { admins: [], investigators: [], youAreAdmin: true },
    grantHref: "/principals?open=me", investigatorsHref: "/principals?role=investigator",
  });
  assert.match(admin, /href="\/principals\?open=me"[^>]*>.*Give yourself the Investigator role/);
  assert.match(admin, /href="\/principals\?role=investigator"[^>]*>See investigators/);

  const investigator = await renderIncidentsAt("", { incidents: [], selected: null, now: "2026-10-02T09:40:00Z", canInvestigate: true });
  assert.doesNotMatch(investigator, /data-who-to-ask/, "an investigator needs no one to ask");
  assert.match(investigator, />New incident</);
});

test("Compare offers a route to the tenant as it is now, not an operator on the server", () => {
  const html = renderToStaticMarkup(createElement(CompareForm, { tenants: [], input: null, quick: [] }));
  assert.match(html, /href="\/protect"[^>]*>.*Back up now/);
  assert.doesNotMatch(html, /operator on the Keel server/);
});

test("Automatic rules preview names who starts automation again", () => {
  const alerts = previewAlerts({ blockers: ["automation-halted"], limits: { automationHalted: true }, runAs: { authorized: true }, matched: [], unknowns: [], dependencies: [], unsupported: [], matchedOverCeiling: [], benchmarkFindings: { state: "read", findings: [] } } as never);
  const halted = alerts.find((alert) => alert.key === "halted");
  assert.ok(halted);
  assert.match(String(halted.todo), /^Ask a Keel admin to start automation again on the Keel server\./);
});

// Dead-end wording, anywhere in the portal: an ask with nobody named and nowhere to go.
// Use askServerAdmin / investigatorLine (lib/who-to-ask.ts), or link to where it is done.
const DEAD_ENDS = /server admin|ask an operator|done by an operator|ask whoever runs|ask your (?:it|admin)/i;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

test("no portal page leaves the reader at an anonymous dead end", () => {
  const found = ["app", "components", "lib"].flatMap((dir) => sources(dir))
    .filter((path) => readFileSync(path, "utf8").split("\n").some((line) => !/^\s*(\/\/|\*)/.test(line) && DEAD_ENDS.test(line)));
  assert.deepEqual(found, []);
});

// Who holds a role, read from People: the reader is left out and flagged instead.
let database: { url: string; connect(): Promise<Client>; cleanup(): Promise<void> };
interface Client { query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>; end(): Promise<void> }
let client: Client;

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
});

after(async () => {
  await client.end();
  await database.cleanup();
});

test("contacts list enabled role holders by name, without the reader", async () => {
  const add = async (email: string, name: string, role: string, extra = "") => {
    const { rows } = await client.query(`INSERT INTO principal (email, display_name${extra ? ", disabled_at" : ""}) VALUES ($1, $2${extra ? ", now()" : ""}) RETURNING id::text AS id`, [email, name]);
    const id = String(rows[0].id);
    await grantRole(client, { principalId: id, role, grantedBy: id });
    return id;
  };
  const me = await add("me@contoso.example", "Mo Reader", "admin");
  await add("zed@contoso.example", "Zed Admin", "admin");
  await add("ana@contoso.example", "Ana Admin", "admin");
  await add("gone@contoso.example", "Gone Admin", "admin", "disabled");
  await add("ines@contoso.example", "Ines Investigator", "investigator");
  await add("val@contoso.example", "Val Viewer", "viewer");

  const mine = await readContacts(client, me);
  assert.deepEqual(mine, { admins: ["Ana Admin", "Zed Admin"], investigators: ["Ines Investigator"], youAreAdmin: true });
  const someone = await readContacts(client, null);
  assert.deepEqual(someone.admins, ["Ana Admin", "Mo Reader", "Zed Admin"]);
  assert.equal(someone.youAreAdmin, false);
});
