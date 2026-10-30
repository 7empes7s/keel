import assert from "node:assert/strict";
import { test } from "node:test";

import { recordSharePointRun } from "../../engine/collect/workloads/sharepoint.mjs";
import { detectWorkloadDrift } from "../../engine/govern/workloadDrift.mjs";
import { schemaSql } from "../../engine/store/loadSchema.mjs";
import { createIsolatedTestDatabase } from "../../engine/test/dbTestHelper.mjs";
import { typeService, plainKind } from "@/lib/baselines-view";
import { changesVerdict } from "@/lib/changes-view";
import { loadServiceChanges, loadServiceReadTotals } from "@/lib/service-changes";
import { serviceChangeFrom, serviceChangeName, serviceUndo, undoSource } from "@/lib/service-changes-view";
import type { DriftRecord } from "@/lib/types";

// Service setting changes: a change a service read finds against the read before it
// (workload_drift) is listed on the Changes page in the same list as the approved-setup
// changes, so the service filter and grouping cover every service, not only Entra ID
// and Intune.

const TENANT = "service-changes-portal-test";
const HOST = "contoso.sharepoint.com";
const FINANCE = `${HOST},11111111-1111-4111-8111-111111111111,22222222-2222-4222-8222-222222222222`;
const ARCHIVE = `${HOST},33333333-3333-4333-8333-333333333333,44444444-4444-4444-8444-444444444444`;
const observed = (operation: string) => ({ status: "observed", operation });
const GRANT = { id: "aTowaS50fG1zLnNwLmV4dGVybmFs", roles: ["write"], applications: [{ id: "a0a00000-0000-4000-8000-0000000000a1", displayName: "Payroll connector" }] };

const site = (siteId: string, displayName: string, grants: unknown[]) => ({
  siteId,
  fields: { displayName, webUrl: `https://${HOST}/sites/${displayName.toLowerCase()}`, appPermissionGrants: grants },
  fieldCoverage: { displayName: observed("sharepoint.site-properties"), webUrl: observed("sharepoint.site-properties"), appPermissionGrants: observed("sharepoint.site-permissions") },
});

const run = (at: string, sites: ReturnType<typeof site>[]) => ({
  workload: "sharepoint-site-settings", tenantHost: HOST, outcome: "complete", observedFrom: at, observedTo: at, sites,
  tenant: { fields: {}, fieldCoverage: {} }, discovery: null, fieldCounts: {}, outOfScope: [],
});

test("the loader lists the newest open change per resource in every service, with its name", async () => {
  const database = await createIsolatedTestDatabase(import.meta.url);
  const client = await database.connect();
  try {
    await client.query(schemaSql());
    const now = new Date("2026-10-15T12:00:00.000Z");
    assert.deepEqual(await loadServiceChanges(client, { tenantRef: TENANT, now }), []);

    const record = async (tenantRef: string, at: string, sites: ReturnType<typeof site>[]) => {
      const stored = await recordSharePointRun(client, { tenantRef, result: run(at, sites) });
      await detectWorkloadDrift(client, { collectionId: stored.id, hysteresis: undefined });
      return stored.id;
    };
    const mailFlow = async (at: string, state: string) => {
      const { rows: [collection] } = await client.query(
        `INSERT INTO workload_collection (tenant_ref, workload, outcome, observed_from, observed_to, created_at)
         VALUES ($1, 'exchange-mail-flow', 'complete', $2, $2, $2) RETURNING id`,
        [TENANT, at],
      );
      await client.query(
        `INSERT INTO workload_observation (collection_id, resource_key, fields) VALUES ($1, 'transport-rule:KEEL-RT-rule', $2)`,
        [collection.id, { identity: "KEEL-RT-rule", kind: "transportRule", Name: "KEEL-RT-rule", State: state }],
      );
      await detectWorkloadDrift(client, { collectionId: collection.id, hysteresis: undefined });
      return String(collection.id);
    };
    // Too old for the window: Archive's grant changed 40 days ago.
    await record(TENANT, "2026-09-04T02:00:00.000Z", [site(FINANCE, "Finance", []), site(ARCHIVE, "Archive", [])]);
    await record(TENANT, "2026-09-05T02:00:00.000Z", [site(FINANCE, "Finance", []), site(ARCHIVE, "Archive", [GRANT])]);
    // An app is given access to Finance, then Finance is renamed and Archive is gone.
    await record(TENANT, "2026-10-13T02:00:00.000Z", [site(FINANCE, "Finance", [GRANT]), site(ARCHIVE, "Archive", [GRANT])]);
    const renamed = await record(TENANT, "2026-10-14T02:00:00.000Z", [site(FINANCE, "Finance team", [GRANT])]);
    // A mail flow rule is switched on.
    await mailFlow("2026-10-13T03:00:00.000Z", "Disabled");
    const enabled = await mailFlow("2026-10-14T03:00:00.000Z", "Enabled");
    // Another tenant's change is never shown here.
    await record("other-tenant", "2026-10-13T02:00:00.000Z", [site(FINANCE, "Elsewhere", [])]);
    await record("other-tenant", "2026-10-14T02:00:00.000Z", [site(FINANCE, "Elsewhere", [GRANT])]);

    const all = await loadServiceChanges(client, { tenantRef: TENANT, now });
    assert.deepEqual(all.map((item) => [item.resourceType, item.name, item.changeType]), [
      ["exchange-mail-flow", "KEEL-RT-rule", "modified"],
      ["sharepoint-site-settings", "Finance team", "modified"],
      ["sharepoint-site-settings", "Archive", "removed"],
    ]);
    // Grouped by service, they land in Exchange and SharePoint, not only Entra ID and Intune.
    assert.deepEqual([...new Set(all.map((item) => typeService(item.resourceType).name))], ["Exchange Online", "SharePoint and OneDrive"]);
    const [rule, finance, archive] = all;
    assert.deepEqual([rule.before, rule.after], [{ State: "Disabled" }, { State: "Enabled" }]);
    assert.equal(rule.blastRadius, "access-affecting");
    assert.equal(rule.naturalKey, "exchange-mail-flow:transport-rule:KEEL-RT-rule");
    assert.equal(rule.serviceRead?.collectionId, enabled);
    assert.equal(rule.serviceRead?.alertState, "open");
    assert.equal(rule.detectedAt, "2026-10-14T03:00:00.000Z");
    // A removed site keeps the name it had in the read before, and its last copy.
    assert.equal(archive.after, null);
    assert.equal((archive.before as { displayName?: string }).displayName, "Archive");
    assert.equal(finance.serviceRead?.collectionId, renamed);
    // Compared with the approved setup, Finance still has the grant nobody accepted, so
    // the read that renamed it is not only cosmetic.
    assert.equal(finance.serviceRead?.comparedWith, "approved");
    assert.equal(finance.blastRadius, "access-affecting");
    // Undo: a mail flow rule goes back through the service restore; SharePoint cannot be
    // written back from the portal yet, and says so.
    assert.deepEqual(rule.serviceRead?.undo, { possible: true, reason: null });
    assert.equal(rule.serviceRead?.comparedWith, "approved");
    for (const site of [finance, archive]) {
      assert.equal(site.serviceRead?.undo.possible, false);
      assert.match(site.serviceRead?.undo.reason ?? "", /Keel cannot write SharePoint site settings back yet/);
    }

    // An acknowledged change stays listed as seen; a resolved one leaves the list.
    const setState = (state: string) => client.query(
      `UPDATE alert SET state = $3 WHERE tenant_ref = $1 AND resource_key = $2`,
      [TENANT, `sharepoint-site-settings:site:${FINANCE}`, state],
    );
    await setState("acknowledged");
    const seen = await loadServiceChanges(client, { tenantRef: TENANT, now });
    assert.deepEqual(seen.map((item) => [item.name, item.serviceRead?.alertState]), [["KEEL-RT-rule", "open"], ["Finance team", "acknowledged"], ["Archive", "open"]]);
    await setState("resolved");
    assert.deepEqual((await loadServiceChanges(client, { tenantRef: TENANT, now })).map((item) => item.name), ["KEEL-RT-rule", "Archive"]);
    assert.equal((await loadServiceChanges(client, { tenantRef: TENANT, now, limit: 1 })).length, 1);
  } finally {
    await client.end();
    await database.cleanup();
  }
});

test("a site template's stored XML never reaches the Changes page", async () => {
  const database = await createIsolatedTestDatabase(import.meta.url);
  const client = await database.connect();
  try {
    await client.query(schemaSql());
    const read = async (at: string, withTemplate: boolean) => {
      const { rows: [collection] } = await client.query(
        `INSERT INTO workload_collection (tenant_ref, workload, outcome, observed_from, observed_to, created_at)
         VALUES ($1, 'sharepoint-structure', 'complete', $2, $2, $2) RETURNING id`,
        [TENANT, at],
      );
      await client.query(
        `INSERT INTO workload_observation (collection_id, resource_key, fields) VALUES ($1, 'hub-site:a', $2)`,
        [collection.id, { kind: "hubSite", Title: "KEEL-RT hub" }],
      );
      if (withTemplate) {
        await client.query(
          `INSERT INTO workload_observation (collection_id, resource_key, fields) VALUES ($1, 'site-template:https://contoso.sharepoint.com/sites/keel-rt', $2)`,
          [collection.id, { kind: "siteTemplate", title: "KEEL-RT site", lists: [], templateXml: "H4sI".repeat(1000), templateSha256: "ab", templateBytes: 4000 }],
        );
      }
      await detectWorkloadDrift(client, { collectionId: collection.id, hysteresis: undefined });
    };
    await read("2026-10-13T02:00:00.000Z", false);
    await read("2026-10-14T02:00:00.000Z", true);
    const [added] = await loadServiceChanges(client, { tenantRef: TENANT, now: new Date("2026-10-15T12:00:00.000Z") });
    assert.equal(added.changeType, "added");
    assert.equal(added.name, "KEEL-RT site");
    assert.deepEqual(Object.keys(added.after ?? {}).sort(), ["kind", "lists", "title"]);
  } finally {
    await client.end();
    await database.cleanup();
  }
});

test("undo restores the active baseline's value, not the one stored with an older change", async () => {
  const database = await createIsolatedTestDatabase(import.meta.url);
  const client = await database.connect();
  try {
    await client.query(schemaSql());
    const now = new Date("2026-10-15T12:00:00.000Z");
    const mailFlow = async (at: string, fields: Record<string, unknown>, drift = true) => {
      const { rows: [collection] } = await client.query(
        `INSERT INTO workload_collection (tenant_ref, workload, outcome, observed_from, observed_to, created_at)
         VALUES ($1, 'exchange-mail-flow', 'complete', $2, $2, $2) RETURNING id`,
        [TENANT, at],
      );
      await client.query(
        `INSERT INTO workload_observation (collection_id, resource_key, fields) VALUES ($1, 'transport-rule:KEEL-RT-rule', $2)`,
        [collection.id, { identity: "KEEL-RT-rule", kind: "transportRule", Name: "KEEL-RT-rule", ...fields }],
      );
      if (drift) await detectWorkloadDrift(client, { collectionId: collection.id, hysteresis: undefined });
      return String(collection.id);
    };
    // The first read is the approved setup; the next one switches the rule on.
    const first = await mailFlow("2026-10-10T03:00:00.000Z", { State: "Disabled", Priority: 1 });
    await mailFlow("2026-10-11T03:00:00.000Z", { State: "Enabled", Priority: 1 });
    const [before] = await loadServiceChanges(client, { tenantRef: TENANT, now });
    assert.equal(before.serviceRead?.previousCollectionId, first);
    assert.deepEqual(before.serviceRead?.undoFrom, { collectionId: first, readAt: "2026-10-10T03:00:00.000Z", approved: true });

    // A new baseline version is captured later from another read and made active: it
    // repoints the approved setup (as applyBaselineWorkloads does), with Priority 2.
    const baselineRead = await mailFlow("2026-10-12T03:00:00.000Z", { State: "Disabled", Priority: 2 }, false);
    await client.query(
      `UPDATE workload_approved SET collection_id = $3, fields = (SELECT fields FROM workload_observation WHERE collection_id = $3 AND resource_key = $2)
        WHERE tenant_ref = $1 AND workload = 'exchange-mail-flow' AND resource_key = $2`,
      [TENANT, "transport-rule:KEEL-RT-rule", baselineRead],
    );
    const [after] = await loadServiceChanges(client, { tenantRef: TENANT, now });
    // The change still names the read it was compared with, but undo restores from the baseline's read.
    assert.equal(after.serviceRead?.previousCollectionId, first);
    assert.deepEqual(after.serviceRead?.undoFrom, { collectionId: baselineRead, readAt: "2026-10-12T03:00:00.000Z", approved: true });
    assert.deepEqual(after.serviceRead?.undo, { possible: true, reason: null });

    // A baseline whose read no longer holds the rule leaves nothing to put back: undo says so
    // instead of quietly falling back to the older value.
    const empty = await mailFlow("2026-10-12T04:00:00.000Z", { State: "Disabled" }, false);
    await client.query("DELETE FROM workload_observation WHERE collection_id = $1", [empty]);
    await client.query("UPDATE workload_approved SET collection_id = $2 WHERE tenant_ref = $1 AND workload = 'exchange-mail-flow'", [TENANT, empty]);
    const [gone] = await loadServiceChanges(client, { tenantRef: TENANT, now });
    assert.equal(gone.serviceRead?.undoFrom.collectionId, empty);
    assert.equal(gone.serviceRead?.undo.possible, false);

    // An active baseline that does not hold the rule at all (an older version without it was
    // reinstated) leaves no approved value: undo never falls back to the value stored with the change.
    await client.query("DELETE FROM workload_approved WHERE tenant_ref = $1 AND workload = 'exchange-mail-flow'", [TENANT]);
    const [unheld] = await loadServiceChanges(client, { tenantRef: TENANT, now });
    assert.equal(unheld.serviceRead?.undoFrom.collectionId, null);
    assert.equal(unheld.serviceRead?.undo.possible, false);
    assert.match(unheld.serviceRead?.undo.reason ?? "", /active baseline does not hold this setting/);
  } finally {
    await client.end();
    await database.cleanup();
  }
});

test("undo falls back to the read the change was compared with only when the service has no approved setup", () => {
  const row = { previous_collection_id: "c1", previous_observed_to: "2026-10-10T03:00:00.000Z" };
  assert.deepEqual(undoSource(row), { collectionId: "c1", readAt: "2026-10-10T03:00:00.000Z", approved: false });
  assert.deepEqual(undoSource({ ...row, approved_collection_id: "c3", approved_observed_to: "2026-10-12T03:00:00.000Z" }),
    { collectionId: "c3", readAt: "2026-10-12T03:00:00.000Z", approved: true });
  assert.deepEqual(undoSource({ ...row, has_approved_setup: true }), { collectionId: null, readAt: null, approved: true });
  assert.match(serviceRow({ has_approved_setup: true }).serviceRead?.undo.reason ?? "", /active baseline does not hold/);
  assert.equal(serviceRow({ has_approved_setup: true, change_type: "added" }).serviceRead?.undo.reason?.includes("never deletes settings"), true);
});

const NOW = "2026-10-15T12:00:00.000Z";
const serviceRow = (over: Record<string, unknown> = {}) => serviceChangeFrom({
  id: "d1a00000-0000-4000-8000-0000000000d1", workload: "teams-org-policies", resource_key: "external-access:Global",
  change_type: "modified", fields: [{ path: "AllowFederatedUsers", kind: "changed", before: false, after: true }], blast_radius: "access-affecting",
  collection_id: "c0110000-0000-4000-8000-0000000000c2", previous_collection_id: "c0110000-0000-4000-8000-0000000000c1",
  observed_to: "2026-10-15T02:00:00.000Z", current_fields: { identity: "Global" }, previous_fields: { identity: "Global" },
  alert_id: "a1e70000-0000-4000-8000-0000000000a1", alert_state: "open", ...over,
});

test("an undo is offered only where the service restore can write the setting back", () => {
  const rule = { workload: "exchange-mail-flow", resourceKey: "transport-rule:KEEL-RT-rule", changeType: "modified" };
  assert.deepEqual(serviceUndo(rule, { restorable: true, reason: null }), { possible: true, reason: null });
  assert.match(serviceUndo({ ...rule, changeType: "added" }, { restorable: true, reason: null }).reason ?? "", /never deletes settings/);
  assert.match(serviceUndo(rule, null).reason ?? "", /no longer has this setting/);
  assert.equal(serviceUndo(rule, { restorable: false, reason: "Deleted since this backup." }).reason, "Deleted since this backup.");
  assert.match(serviceUndo({ ...rule, workload: "exchange-mailbox-settings", resourceKey: "organization" }, { restorable: true, reason: null }).reason ?? "", /together with a mailbox/);
  for (const workload of ["sharepoint-site-settings", "power-platform-settings"]) {
    assert.equal(serviceUndo({ ...rule, workload }, { restorable: true, reason: null }).possible, false, `${workload} has no portal restore yet`);
  }
  // OneDrive sharing settings are restored from the page now.
  assert.equal(serviceUndo({ ...rule, workload: "onedrive-site-settings", resourceKey: "onedrive:https://contoso-my.sharepoint.com/personal/keel-rt-a" }, { restorable: true, reason: null }).possible, true);
});

test("each service change is named and placed in its service", () => {
  const row = serviceRow();
  assert.equal(row.name, "Global");
  assert.equal(typeService(row.resourceType).name, "Teams");
  assert.equal(plainKind(row.resourceType), "Teams organization policy");
  assert.equal(serviceChangeName("tenant", null), "Sharing settings");
  assert.equal(serviceChangeName("organization", {}), "Organization settings");
  assert.equal(serviceChangeName("site:x", { webUrl: "https://contoso.sharepoint.com/sites/hr" }), "contoso.sharepoint.com/sites/hr");
  assert.equal(serviceChangeName("dlp-policy:Block social", {}), "Block social");
  assert.equal(serviceRow({ change_type: "added", fields: [] }).before, null);
});

test("the Changes verdict counts service setting changes apart from approved-setup changes", () => {
  const two: DriftRecord[] = [serviceRow(), serviceRow({ id: "d1a00000-0000-4000-8000-0000000000d2" })];
  assert.deepEqual(changesVerdict(two, "2026-10-01T00:00:00.000Z", NOW), {
    text: "Nothing has changed since the approved setup of 14 days ago, but 2 service setting changes wait for review.", tone: "attention",
  });
  assert.equal(changesVerdict([], "2026-10-01T00:00:00.000Z", NOW).tone, "good");
  assert.match(changesVerdict(two.slice(0, 1), null, NOW).text, /; 1 service setting change waits for review\.$/);
  for (const waiting of [0, 1, 12]) {
    for (const baseline of [null, "2026-10-01T00:00:00.000Z"]) {
      const items = Array.from({ length: waiting }, (_, index) => serviceRow({ id: `id-${index}` }));
      assert.ok(changesVerdict(items, baseline, NOW).text.split(/\s+/).length <= 25);
    }
  }
});

test("the read totals give each service its newest read's settings and every open change", async () => {
  const database = await createIsolatedTestDatabase(import.meta.url);
  const client = await database.connect();
  try {
    await client.query(schemaSql());
    assert.deepEqual(await loadServiceReadTotals(client, TENANT), { held: {}, open: {} });
    const record = async (tenantRef: string, at: string, sites: ReturnType<typeof site>[]) => {
      const stored = await recordSharePointRun(client, { tenantRef, result: run(at, sites) });
      await detectWorkloadDrift(client, { collectionId: stored.id, hysteresis: undefined });
    };
    // Archive's grant changed a year ago and was never put back: it still counts.
    await record(TENANT, "2025-10-01T02:00:00.000Z", [site(FINANCE, "Finance", []), site(ARCHIVE, "Archive", [])]);
    await record(TENANT, "2025-10-02T02:00:00.000Z", [site(FINANCE, "Finance", []), site(ARCHIVE, "Archive", [GRANT])]);
    // Only the newest read's size counts: Finance is gone from it.
    await record(TENANT, "2026-10-14T02:00:00.000Z", [site(ARCHIVE, "Archive", [GRANT])]);
    await record("other-tenant", "2026-10-14T02:00:00.000Z", [site(FINANCE, "Elsewhere", []), site(ARCHIVE, "Other", [])]);
    const totals = await loadServiceReadTotals(client, TENANT);
    const newestSize = async (at: string) => (await client.query(
      `SELECT count(*)::int AS n FROM workload_observation o JOIN workload_collection c ON c.id = o.collection_id
        WHERE c.tenant_ref = $1 AND c.observed_to = $2`, [TENANT, at],
    )).rows[0].n;
    assert.deepEqual(Object.keys(totals.held), ["sharepoint-site-settings"]);
    assert.equal(totals.held["sharepoint-site-settings"], await newestSize("2026-10-14T02:00:00.000Z"));
    assert.ok(totals.held["sharepoint-site-settings"] < await newestSize("2025-10-02T02:00:00.000Z"));
    const open = totals.open["sharepoint-site-settings"];
    assert.ok(open.modified >= 1, "the year-old grant change is still open");
    assert.ok(open.removed >= 1, "Finance going is open");
  } finally {
    await client.end();
    await database.cleanup();
  }
});
