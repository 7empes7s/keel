import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { publishCheckpoint } from "../../engine/govern/anchor.mjs";
import { appendEvidence, explainChainBreaks } from "../../engine/govern/evidence.mjs";
import { canonicalize } from "../../engine/cir/canonicalHash.mjs";
import { createLocalStorageAdapter } from "../../engine/storage/local.mjs";
import { schemaSql } from "../../engine/store/loadSchema.mjs";
import { createIsolatedTestDatabase } from "../../engine/test/dbTestHelper.mjs";
import { ChainIndicator } from "@/components/evidence-timeline";
import { AlertRow } from "@/components/ui/alert-list";
import { AUDIT_CHECK_WORDS, auditCheckOf, dashboardAuditCheck, knownBreakLines } from "@/lib/audit-check";
import { integrityWords, recordKindWords } from "@/lib/activity-view";
import { checkAuditRecord, type ChainIntegrity, type KnownBreak } from "@/lib/evidence";
import { integrationAlerts, integrationsPageVerdict, integrationsStatus } from "@/lib/integrations-view";
import { menuStatuses } from "@/lib/menu-status";
import { buildAlerts } from "@/lib/portal-data";
import { evidenceSentence } from "@/lib/sentences";
import type { DashboardData } from "@/lib/types";

// The 31 Oct 2026 break in the audit record: a Keel bug (accepts written without the
// tenant lock, fixed in PR #876) linked 903 entries to the wrong earlier entry. One
// explanation record names the stretch, and every page shows it as a known, explained
// break in amber instead of red "Failed the check". A break outside it stays red.

const KNOWN: KnownBreak = {
  explainedBySeq: "428950", explainedAt: "2026-11-01T09:00:00.000Z", fromSeq: "425262", throughSeq: "428902",
  breakCount: 903, cause: "accepting a change wrote its audit entry without the tenant lock", fixRef: "PR #876",
  firstBreakAt: "2026-10-31T14:06:10.000Z", lastBreakAt: "2026-10-31T17:45:00.000Z",
};

test("a known, explained break is amber, never intact, and never hides a failed check", () => {
  assert.equal(auditCheckOf({ ok: false, status: "unanchored", ownChain: "intact", knownBreaks: [KNOWN] }), "known");
  assert.equal(auditCheckOf({ ok: true, status: "verified", knownBreaks: [KNOWN] }), "known");
  assert.equal(auditCheckOf({ ok: false, status: "unanchored", ownChain: "broken", knownBreaks: [KNOWN] }), "failed");
  assert.equal(auditCheckOf({ ok: false, status: "broken-at-sequence", knownBreaks: [KNOWN] }), "failed");
  assert.equal(dashboardAuditCheck({ ok: false, check: "known" }), "failed", "the Overview's own chain outranks it");
  assert.equal(dashboardAuditCheck({ ok: true, check: "known" }), "known");
});

test("Activity: amber words, the day of the break, and plain details behind Show details", () => {
  const words = integrityWords({ ok: false, status: "unanchored", ownChain: "intact", knownBreaks: [KNOWN] });
  assert.deepEqual([words.state, words.label, words.tone], ["known", "Known break, explained", "soon"]);
  assert.match(words.sentence, /31 Oct 2026/);
  assert.match(words.sentence, /no off-site copy/, "the missing off-site copy is still said");
  const lines = knownBreakLines([KNOWN]);
  assert.deepEqual(lines, [
    "On 31 Oct 2026, 903 entries were linked to the wrong earlier entry.",
    "Cause: accepting a change wrote its audit entry without the tenant lock. Fixed by PR #876.",
    "No entry was changed or removed. Any break outside this stretch still fails the check.",
  ]);
  for (const line of lines) assert.doesNotMatch(line, /425262|428902|428950/, "raw entry numbers stay in Technical details");
  const html = renderToStaticMarkup(createElement(AlertRow, { as: "div", item: { key: "audit-known", tone: "soon", icon: "alert", title: AUDIT_CHECK_WORDS.known.title, todo: "Nothing.", more: lines } }));
  assert.match(html, /data-tone="soon"[\s\S]*known break, explained[\s\S]*<details[\s\S]*Show details[\s\S]*903 entries/);
  assert.match(renderToStaticMarkup(createElement(ChainIndicator, { integrity: { ok: true, status: "verified", knownBreaks: [KNOWN] } })), /evidence-unchecked[\s\S]*Known break, explained/);
  assert.equal(recordKindWords("chain-break-explained"), "Audit record break explained");
  assert.match(evidenceSentence({ kind: "chain-break-explained", actor: "x", subject: { breakSeqs: ["1", "2"] } }, "Marouane"), /^Marouane explained a known break in the audit record: 2 entries were/);
});

test("Overview, menu and Integrations show the known break as Check soon", () => {
  const evidence: DashboardData["evidence"] = { ok: true, chainLength: 9, check: "known" };
  const alerts = buildAlerts({
    activeBaseline: { resourceCount: 3 } as DashboardData["activeBaseline"],
    lastCollection: { completedAt: "2026-10-31T10:00:00Z", status: "complete" },
    coverage: { covered: 3, failed: 0, stale: 0, neverCollected: 0, notCovered: 0, unavailable: 0, total: 3 },
    evidence,
  }).filter((alert) => alert.key === "audit");
  assert.deepEqual(alerts.map((alert) => [alert.severity, alert.title, alert.href]), [["warning", AUDIT_CHECK_WORDS.known.title, "/activity?show=records"]]);
  const unanchored = buildAlerts({
    activeBaseline: { resourceCount: 3 } as DashboardData["activeBaseline"],
    lastCollection: { completedAt: "2026-10-31T10:00:00Z", status: "complete" },
    coverage: { covered: 3, failed: 0, stale: 0, neverCollected: 0, notCovered: 0, unavailable: 0, total: 3 },
    evidence: { ...evidence, unanchored: true },
  }).filter((alert) => alert.key?.startsWith("audit"));
  assert.deepEqual(unanchored.map((alert) => alert.title), [AUDIT_CHECK_WORDS.known.title, AUDIT_CHECK_WORDS.unchecked.title], "the missing off-site copy is still asked for");
  assert.deepEqual(integrationAlerts([], [], null, "known", true).filter((alert) => alert.key.startsWith("audit")).map((alert) => alert.key), ["audit-known", "audit-unchecked"]);
  const menu = menuStatuses({
    headline: null as never,
    coverage: { covered: 3, failed: 0, notCovered: 0, neverCollected: 0, stale: 0, unavailable: 0, total: 3 },
    openDriftByBlastRadius: [], openDriftTotal: 0, evidence,
  });
  assert.deepEqual(menu["Audit log"], { tone: "soon", note: AUDIT_CHECK_WORDS.known.title });
  const integrations = integrationAlerts([], [], null, "known");
  assert.deepEqual(integrations.filter((alert) => alert.key.startsWith("audit")).map((alert) => [alert.tone, alert.title]), [["soon", AUDIT_CHECK_WORDS.known.title]]);
  assert.deepEqual(integrationsStatus(integrations), { tone: "soon", label: "Check soon" });
  assert.equal(integrationsPageVerdict([], [], null, "known").tone, "attention");
});

function hashOf(row: { prevHash: string | null; tenantRef: string; occurredAt: Date; kind: string; subject: unknown; actor: string }) {
  return createHash("sha256")
    .update(`${row.prevHash ?? ""}${row.tenantRef}${row.occurredAt.toISOString()}${row.kind}${JSON.stringify(canonicalize(row.subject, "group"))}${row.actor}`)
    .digest("hex");
}

test("the real check: an explained break reads as known with or without an off-site copy, a new break as failed", async () => {
  const database = await createIsolatedTestDatabase(import.meta.url);
  const client = await database.connect();
  const root = await mkdtemp(join(tmpdir(), "portal-known-break-"));
  const tenantRef = "known-break-portal-test";
  const append = async (n: number) => String((await appendEvidence(client, { tenantRef, kind: "action-attempt", subject: { n }, actor: "tester", eventSink: () => true })).seq);
  // The accept path before PR #876: chain onto the last row and leave the head alone.
  const legacyAccept = async (n: number) => {
    const { rows: [last] } = await client.query("SELECT record_hash FROM evidence WHERE tenant_ref = $1 ORDER BY seq DESC LIMIT 1", [tenantRef]);
    const occurredAt = new Date();
    const subject = { driftId: `d${n}` };
    await client.query(
      "INSERT INTO evidence (tenant_ref, occurred_at, kind, subject, actor, prev_hash, record_hash) VALUES ($1,$2,'disposition',$3,'tester',$4,$5)",
      [tenantRef, occurredAt, subject, last.record_hash, hashOf({ prevHash: last.record_hash, tenantRef, occurredAt, kind: "disposition", subject, actor: "tester" })],
    );
  };
  try {
    await client.query(schemaSql());
    await append(1);
    await legacyAccept(1);
    const first = await append(2);
    await legacyAccept(2);
    const last = await append(3);
    const before = await checkAuditRecord(client, { tenantRef, cache: new Map() });
    assert.equal(auditCheckOf(before), "failed", "before the explanation the break is red");

    const written = await explainChainBreaks(client, { tenantRef, fromSeq: first, throughSeq: last, cause: "accept bypassed the head", fixRef: "PR #876", actor: "tester", write: true });
    assert.equal(written.written, true);
    const unanchored: ChainIntegrity = await checkAuditRecord(client, { tenantRef, cache: new Map() });
    assert.equal(unanchored.ownChain, "intact");
    assert.equal(unanchored.knownBreaks?.[0]?.breakCount, 2);
    assert.equal(auditCheckOf(unanchored), "known");

    const key = generateKeyPairSync("ed25519");
    const storageOptions = { root, dependencies: {} };
    const anchor = { tenantRef, build: "fixture", mode: "fixture", keyId: "v1", storageRef: "independent-fixture",
      storage: createLocalStorageAdapter(storageOptions),
      trust: { independent: true, storageRef: "independent-fixture", qualification: "fixture-tested", rootKeyId: "v1", keys: { v1: { publicKey: key.publicKey, qualification: "fixture-tested" } } },
      authorize: async () => true, signer: (bytes: Buffer) => sign(null, bytes, key.privateKey), checkpointRef: "" };
    anchor.checkpointRef = await publishCheckpoint(client, anchor);
    const anchored: ChainIntegrity = await checkAuditRecord(client, { tenantRef, anchor, cache: new Map() });
    assert.equal(anchored.status, "verified");
    assert.equal(auditCheckOf(anchored), "known", "an off-site copy does not make the known break disappear");

    await legacyAccept(3);
    await append(4);
    assert.equal(auditCheckOf(await checkAuditRecord(client, { tenantRef, cache: new Map() })), "failed", "a new break is red again");
  } finally {
    await client.end();
    await database.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});
