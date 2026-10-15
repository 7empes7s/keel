import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { compareSettings } from "../../engine/govern/compare.mjs";
import { CompareView } from "@/components/compare-view";
import { NAV_MAP, visibleNavLinks } from "@/components/nav-links";
import {
  compareInputFrom, compareValueWords, compareVerdict, containerWords, defaultInput, labelTenants,
  type CompareData, type CompareResult, type SettingsSection,
} from "@/lib/compare-view";

// Wave 2 CMP: the Compare page's words, fed by the engine's own settings compare so the
// view reads the shapes the engine returns.

const OWN = "sha256:00000000000000a1";
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const row = (key: string, payload: Record<string, unknown>, hash: string) => ({
  natural_key: key, resource_type: key.split(":")[0], payload, payload_hash: hash, hash_version: 2, blast_radius: "access-affecting",
});

function result(settings: SettingsSection): CompareResult {
  return {
    version: 1, mode: "snapshots", portable: false, generatedAt: "2026-10-03T00:00:00.000Z",
    left: { kind: "snapshot", tenantRef: OWN, snapshotId: ID(1), at: "2026-10-01T00:00:00.000Z" },
    right: { kind: "snapshot", tenantRef: OWN, snapshotId: ID(2), at: "2026-10-02T00:00:00.000Z" },
    settings, workloads: null, content: null,
  };
}

const TENANTS = labelTenants([
  { tenantRef: "sha256:00000000000000b2", snapshots: [{ id: ID(3), completedAt: "2026-10-02T00:00:00.000Z", resourceCount: 2 }] },
  { tenantRef: OWN, snapshots: [{ id: ID(2), completedAt: "2026-10-02T00:00:00.000Z", resourceCount: 2 }, { id: ID(1), completedAt: "2026-10-01T00:00:00.000Z", resourceCount: 2 }] },
], OWN);

test("the address names two snapshots or none, and the default is this tenant's two newest", () => {
  assert.deepEqual(compareInputFrom({ from: ID(1), to: ID(2) }), { from: ID(1), to: ID(2) });
  assert.equal(compareInputFrom({ from: "x", to: ID(2) }), null);
  assert.equal(compareInputFrom({}), null);
  assert.deepEqual(TENANTS.map((tenant) => tenant.label), ["This tenant", "Other tenant 1"]);
  assert.deepEqual(defaultInput(TENANTS), { from: ID(1), to: ID(2) });
  assert.equal(defaultInput([{ ...TENANTS[0], snapshots: TENANTS[0].snapshots.slice(0, 1) }]), null);
});

test("the verdict counts differences, and says when nothing differs", () => {
  const changed = compareSettings(
    { rows: [row("group:Finance", { displayName: "Finance", securityEnabled: true }, "a")], coverage: null },
    { rows: [row("group:Finance", { displayName: "Finance", securityEnabled: false }, "b")], coverage: null },
  ) as SettingsSection;
  const data: CompareData = { generatedAt: "2026-10-03T00:00:00.000Z", tenants: TENANTS, input: { from: ID(1), to: ID(2) }, result: result(changed), problem: null };
  assert.equal(compareVerdict(data).text, "1 difference between the two snapshots.");
  const same = compareSettings({ rows: [], coverage: null }, { rows: [], coverage: null }) as SettingsSection;
  assert.deepEqual(compareVerdict({ ...data, result: result(same) }), { text: "Nothing differs between the two snapshots.", tone: "good" });
  assert.equal(compareVerdict({ ...data, result: null, problem: "too-few-snapshots" }).tone, "attention");
  // Objects that cannot be matched across tenants are never "nothing differs".
  const unmatched = { ...same, totals: { ...same.totals, unmatched: 1 }, unmatched: [{ resourceType: "user", service: "Entra ID", left: 3, right: 2 }] };
  assert.equal(compareVerdict({ ...data, result: { ...result(unmatched), portable: true } }).tone, "attention");

  const html = renderToStaticMarkup(createElement(CompareView, { data }));
  assert.match(html, /Finance/);
  assert.match(html, /Security enabled/);
  assert.match(html, /method="get"/);
  assert.doesNotMatch(html, /method="post"/);
});

test("values read as names, never as ids or address codes", () => {
  assert.equal(compareValueWords(["ref:group:Break-glass admins", "<id>"]), "Break-glass admins (group), an id");
  assert.equal(compareValueWords(ID(9)), "an id");
  assert.equal(compareValueWords("smtp:a@b.example"), "a@b.example (SMTP address)");
  assert.equal(containerWords(`mailbox/${ID(4)}/items/inbox`), "Mailbox · items › inbox");
  assert.equal(containerWords(`drive:${ID(4)}`), "Drive");
});

test("Compare sits under Changes and needs read", () => {
  assert.ok(NAV_MAP.Changes.some((route) => route.href === "/compare"));
  assert.equal(visibleNavLinks({}).some((link) => link.href === "/compare"), false);
  assert.equal(visibleNavLinks({ canRead: true }).some((link) => link.href === "/compare"), true);
});
