import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishCheckpoint } from "../../engine/govern/anchor.mjs";
import { createLocalStorageAdapter } from "../../engine/storage/local.mjs";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { appendEvidence } from "../../engine/govern/evidence.mjs";
import { createIsolatedTestDatabase } from "../../engine/test/dbTestHelper.mjs";
import { guardedEvidenceList, guardedEvidenceVerify, type EvidenceData } from "@/lib/evidence";
import { ChainIndicator, EvidenceTimeline } from "@/components/evidence-timeline";
import { GET as listRoute } from "@/app/api/evidence/route";
import { GET as verifyRoute } from "@/app/api/evidence/verify/route";
import { CAPABILITIES_HEADER, PRINCIPAL_ID_HEADER } from "@/lib/principal";

function request(query = "", capabilities = "read") {
  return new Request(`http://localhost/api/evidence${query}`, { headers: {
    [PRINCIPAL_ID_HEADER]: "viewer", [CAPABILITIES_HEADER]: capabilities,
  } });
}

test("both exported evidence routes refuse non-read principals before opening a database", async () => {
  for (const route of [listRoute, verifyRoute]) {
    for (const capabilities of ["", "collect", "policies"]) {
      const response = await route(request("", capabilities));
      assert.equal(response.status, 403);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.deepEqual(await response.json(), { error: "forbidden" });
    }
  }
});

test("evidence routes verify real hashes, detect tampering and truncation, and paginate a tenant timeline", async () => {
  const database = await createIsolatedTestDatabase(import.meta.url);
  const fixture = await database.connect();
  const tenant = "evidence-portal-test";
  const deps = { databaseUrl: () => database.url, connect: () => database.connect(), tenantRef: () => tenant };
  const list = guardedEvidenceList(deps);
  const root = await mkdtemp(join(tmpdir(), "portal-anchor-"));
  const key = generateKeyPairSync("ed25519");
  const storageOptions = { root, dependencies: {} };
  const options = { tenantRef: tenant, build: "fixture", mode: "fixture", keyId: "v1",
    storageRef: "independent-fixture", storage: createLocalStorageAdapter(storageOptions),
    trust: { independent: true, storageRef: "independent-fixture", qualification: "fixture-tested",
      rootKeyId: "v1", keys: { v1: { publicKey: key.publicKey, qualification: "fixture-tested" } } },
    authorize: async () => true, signer: (bytes: Buffer) => sign(null, bytes, key.privateKey), checkpointRef: "" };
  const verify = guardedEvidenceVerify(deps, async () => options);
  try {
    await fixture.query(readFileSync(new URL("../../engine/store/schema.sql", import.meta.url), "utf8"));
    for (let index = 0; index < 5; index++) {
      await appendEvidence(fixture, { tenantRef: tenant, kind: index === 0 ? "action-attempt" : "policy-evaluation", subject: { index, decision: "<safe>" }, actor: "operator" });
    }
    await appendEvidence(fixture, { tenantRef: "other-tenant", kind: "policy-evaluation", subject: { secret: true }, actor: "other" });
    const { rows } = await fixture.query("SELECT * FROM evidence WHERE tenant_ref = $1 ORDER BY seq DESC", [tenant]);
    assert.equal((await (await guardedEvidenceVerify(deps)(request())).json()).status, "unanchored");
    options.checkpointRef = await publishCheckpoint(fixture, options);
    assert.equal((await (await verify(request())).json()).status, "verified");
    const query = "kind=policy-evaluation&from=2000-01-01&to=2100-01-01&limit=2";
    const firstResponse = await list(request(`?${query}`));
    assert.equal(firstResponse.headers.get("cache-control"), "no-store");
    const first: EvidenceData = await firstResponse.json();
    assert.deepEqual(first.entries.map((entry) => entry.seq), rows.slice(0, 2).map((row: { seq: string }) => row.seq));
    assert.equal(first.nextBefore, rows[1].seq);
    const firstHtml = renderToStaticMarkup(createElement(EvidenceTimeline, { data: first, query }));
    assert.ok(firstHtml.indexOf(`#${rows[0].seq}`) < firstHtml.indexOf(`#${rows[1].seq}`));
    assert.match(firstHtml, /\{\n  &quot;index&quot;: 4,/);
    assert.match(firstHtml, /&lt;safe&gt;/);
    assert.ok(firstHtml.includes(`before=${first.nextBefore}`));
    assert.ok(firstHtml.includes("kind=policy-evaluation&amp;from=2000-01-01&amp;to=2100-01-01&amp;limit=2"));
    const secondQuery = `${query}&before=${first.nextBefore}`;
    const second: EvidenceData = await (await list(request(`?${secondQuery}`))).json();
    assert.deepEqual(second.entries.map((entry) => entry.seq), rows.slice(2, 4).map((row: { seq: string }) => row.seq));
    assert.equal(second.nextBefore, null);
    const secondHtml = renderToStaticMarkup(createElement(EvidenceTimeline, { data: second, query: secondQuery }));
    assert.ok(secondHtml.indexOf(`#${rows[2].seq}`) < secondHtml.indexOf(`#${rows[3].seq}`));
    assert.ok(!secondHtml.includes("Older entries"));
    assert.ok(secondHtml.includes("Newest entries"));
    assert.ok(!secondHtml.includes("before="));
    const empty: EvidenceData = await (await list(request("?to=2000-01-01"))).json();
    assert.equal(empty.entries.length, 0);
    assert.match(renderToStaticMarkup(createElement(EvidenceTimeline, { data: empty, query: "" })), /No evidence matches/);
    for (const filter of ["limit=0", "limit=201", "before=-1", "before=9223372036854775808", "from=bad", "from=2026-02-31", "from=2100-01-01&to=2000-01-01"]) {
      assert.equal((await list(request(`?${filter}`))).status, 400, filter);
    }
    // Corruption is confined to this disposable test schema. The real verifier must detect it.
    await fixture.query("UPDATE evidence SET record_hash = $1 WHERE seq = $2", ["tampered", rows[2].seq]);
    const tampered = await (await verify(request())).json();
    assert.deepEqual(tampered, { ok: false, brokenAtSeq: rows[2].seq, status: "broken-at-sequence" as const });
    assert.match(renderToStaticMarkup(createElement(ChainIndicator, { integrity: tampered })), /evidence-broken/);
    await fixture.query("UPDATE evidence SET record_hash = $1 WHERE seq = $2", [rows[2].record_hash, rows[2].seq]);
    await fixture.query("DELETE FROM evidence WHERE seq = $1", [rows[0].seq]);
    assert.deepEqual(await (await verify(request())).json(), { ok: false, status: "truncated", expectedSeq: rows[0].seq, actualSeq: rows[1].seq });
  } finally {
    await fixture.end();
    await database.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test("chain indicator distinguishes verified, failed, and unavailable states", () => {
  assert.match(renderToStaticMarkup(createElement(ChainIndicator, { integrity: { ok: true, status: "verified", anchoredThroughSeq: "5", unanchoredRecords: 0 } })), /evidence-intact/);
  assert.match(renderToStaticMarkup(createElement(ChainIndicator, { integrity: { ok: false, status: "unanchored" } })), /Evidence chain unanchored/);
  const unavailable = renderToStaticMarkup(createElement(ChainIndicator, { integrity: null }));
  assert.match(unavailable, /Chain integrity unavailable/);
  assert.doesNotMatch(unavailable, /evidence-intact|evidence-broken/);
});
