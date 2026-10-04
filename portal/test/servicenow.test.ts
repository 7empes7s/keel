import "./next-async-storage";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ServiceNowPanel } from "@/components/servicenow-panel";
import { heldBackSentence, integrationsPageVerdict, serviceNowSentence } from "@/lib/integrations-view";
import { CAPABILITIES_HEADER, PRINCIPAL_ID_HEADER } from "@/lib/principal";
import { DATA_SURFACES, guardedRead } from "@/lib/read";
import { guardedServiceNowConfigure, guardedServiceNowStatus, type ServiceNowStatus } from "@/lib/servicenow";

// Roadmap task-97: the ServiceNow panel says when it is off and why, shows held-back
// updates, and keeps secrets out; its routes refuse readers without the capability.

const id = "00000000-0000-0000-0000-000000000001";
const ON: ServiceNowStatus = {
  configured: true, enabled: true, problems: [],
  mapping: {
    instanceHost: "contoso.service-now.com", table: "u_keel_gated_change",
    fields: { state: "u_gate", approver: "u_gate_owner.email", planVersion: "u_plan_rev", planDigest: "u_plan_hash", keelRequest: "u_keel_ref", keelDecision: "u_keel_outcome" },
    approvedValues: ["gate_passed"], rejectedValues: ["gate_blocked"],
    tokenRef: "env:KEEL_SERVICENOW_TOKEN", callbacks: "signed", callbackSecretRef: "env:KEEL_SERVICENOW_CALLBACK_SECRET",
  },
  mirror: { records: 3, waiting: 1, pendingUpdates: 0, heldBack: 0, conflicts: 0 },
  heldBack: [], updatedAt: "2026-10-04T00:00:00.000Z", updatedBy: id,
  docSource: { url: "https://www.servicenow.com/docs/r/api-reference/rest-apis/c_TableAPI.html", retrievedAt: "2026-10-04" },
};

test("a missing mapping turns ServiceNow off visibly, and outranks a healthy page", () => {
  const off: ServiceNowStatus = { ...ON, enabled: false, problems: [{ code: "states-rejected", message: "No state value is mapped to rejected." }] };
  assert.deepEqual(integrationsPageVerdict([], [], off), { text: "ServiceNow approvals are off until 1 missing setting is filled in.", tone: "attention" });
  const html = renderToStaticMarkup(createElement(ServiceNowPanel, { status: off }));
  assert.match(html, /No state value is mapped to rejected\./);
  assert.match(html, />Off</);
  assert.equal(serviceNowSentence({ ...ON, configured: false, mapping: null }), "ServiceNow is not set up. Approvals are decided only in KEEL.");
  // Not set up is not a problem to flag over the destinations.
  assert.equal(integrationsPageVerdict([], [], { ...ON, configured: false, enabled: false }).tone, "good");
});

test("a held-back update is shown and the decision is said to stand", () => {
  const held: ServiceNowStatus = {
    ...ON, mirror: { ...ON.mirror, heldBack: 1 },
    heldBack: [{ eventId: "keel:decision:x", kind: "decision", externalRef: "a".repeat(32), attempts: 2, reason: "rejected by adapter", lastError: "HTTP 403", createdAt: "2026-10-04T00:00:00.000Z" }],
  };
  assert.equal(integrationsPageVerdict([], [], held).text, "1 ServiceNow update is held back; KEEL's decisions stand.");
  assert.equal(heldBackSentence(held.heldBack[0]), "The decision update was held back after 2 attempts: ServiceNow refused it. KEEL's decision stands.");
  const html = renderToStaticMarkup(createElement(ServiceNowPanel, { status: held }));
  assert.match(html, /gate passed/);
  assert.match(html, /Not yet proven against a real ServiceNow instance/);
  assert.ok(!/adapter/i.test(html.replace(/<details[\s\S]*<\/details>/, "")), "no internal vocabulary outside the record");
});

test("the ServiceNow routes refuse readers and writers without the capability", async () => {
  let queries = 0;
  const deps = { databaseUrl: () => "unused", tenantRef: () => "test", connect: async () => ({
    query: async () => { queries++; return { rows: [] }; }, end: async () => {},
  }) };
  const request = (method: string, capabilities: string[]) => new Request("http://localhost/api/integrations/servicenow", {
    method, headers: { [PRINCIPAL_ID_HEADER]: id, [CAPABILITIES_HEADER]: capabilities.join(" ") },
    body: method === "PUT" ? JSON.stringify({ config: {} }) : undefined,
  });
  assert.equal((await guardedRead(DATA_SURFACES.integrationsServiceNowApi, guardedServiceNowStatus(deps))(request("GET", []))).status, 403);
  for (const capabilities of [[], ["read"]]) {
    assert.equal((await guardedServiceNowConfigure(deps)(request("PUT", capabilities))).status, 403);
  }
  assert.equal(queries > 0, true, "denials are evidenced");
});
