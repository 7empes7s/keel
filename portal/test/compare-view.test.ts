import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { MAX_ITEMS, compareSettings } from "../../engine/govern/compare.mjs";
import { CompareView } from "@/components/compare-view";
import { NAV_MAP, visibleNavLinks } from "@/components/nav-links";
import {
  compareInputFrom, compareValueWords, compareVerdict, containerWords, defaultInput, groupKind, labelTenants, notComparedReasons, settingsByKind,
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
  assert.equal(compareVerdict(data).text, "1 difference between the two backups.");
  const same = compareSettings({ rows: [], coverage: null }, { rows: [], coverage: null }) as SettingsSection;
  assert.deepEqual(compareVerdict({ ...data, result: result(same) }), { text: "Nothing differs between the two backups.", tone: "good" });
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
  assert.equal(compareValueWords(["ref:group:Break-glass admins", "<id>"]), "Break-glass admins (group), an object Keel could not name");
  assert.equal(compareValueWords(ID(9)), "an object Keel has no name for");
  assert.equal(compareValueWords([ID(9)], { [ID(9).toLowerCase()]: "Finance approvers" }), "Finance approvers");
  assert.equal(compareValueWords("smtp:a@b.example"), "a@b.example (SMTP address)");
  assert.equal(containerWords(`mailbox/${ID(4)}/items/inbox`), "Inbox (mailbox)");
  assert.equal(containerWords(`drive:${ID(4)}`), "Drive");
});

test("Compare sits under Baselines and needs read", () => {
  assert.ok(NAV_MAP.Baselines.some((route) => route.href === "/compare"));
  assert.equal(visibleNavLinks({}).some((link) => link.href === "/compare"), false);
  assert.equal(visibleNavLinks({ canRead: true }).some((link) => link.href === "/compare"), true);
});

test("not compared folds into a few reasons, worst first, never a sentence per kind", () => {
  const reasons = notComparedReasons([
    { resourceType: "accessPackage", service: "Entra ID", left: "complete", right: "not-requested" },
    { resourceType: "deviceConfiguration", service: "Intune", left: "complete", right: "failed" },
    { resourceType: "accessReview", service: "Entra ID", left: "complete", right: "not-requested" },
    { resourceType: "namedLocation", service: "Entra ID", left: "partial", right: "complete-empty" },
    { resourceType: "user", service: "Entra ID", left: "failed", right: "failed" },
  ]);
  assert.deepEqual(reasons.map((reason) => [reason.reason, reason.side, reason.tone, reason.entries.length]), [
    ["Could not be read", "after", "failed", 1],
    ["Could not be read", "both", "failed", 1],
    ["Read only in part", "before", "partial", 1],
    ["Not in that backup", "after", "neutral", 2],
  ]);
});

test("whole added and removed objects are one line with a badge, settings folded; no There or Not there", () => {
  const section = compareSettings(
    { rows: [row("group:Old team", { displayName: "Old team", description: "Closed" }, "a"), row("group:Finance", { displayName: "Finance", securityEnabled: true }, "b")], coverage: null },
    { rows: [row("group:New team", { displayName: "New team" }, "c"), row("group:Finance", { displayName: "Finance", securityEnabled: false }, "d")], coverage: null },
  ) as SettingsSection;
  const settings: SettingsSection = { ...section, notCompared: [
    { resourceType: "accessPackage", service: "Entra ID", left: "complete", right: "not-requested" },
    { resourceType: "accessReview", service: "Entra ID", left: "complete", right: "not-requested" },
  ] };
  const data: CompareData = { generatedAt: "2026-10-03T00:00:00.000Z", tenants: TENANTS, input: { from: ID(1), to: ID(2) }, result: result(settings), problem: null };
  const html = renderToStaticMarkup(createElement(CompareView, { data }));
  assert.match(html, /data-change="removed"[^>]*>.*?Removed/);
  assert.match(html, /data-change="added"[^>]*>.*?Added/);
  assert.match(html, /Show its 2 settings/);
  // Settings of a whole item stay folded, and a changed object is one line that opens
  // its settings in the details panel: the list itself shows no before/after rows.
  assert.equal((html.match(/class="cc-row"/g) ?? []).length, 0);
  assert.match(html, /1 setting differs: Security enabled\./);
  assert.match(html, /aria-label="See what changed in Finance"/);
  assert.doesNotMatch(html, />(Not )?[Tt]here</);
  assert.doesNotMatch(html, /not there/i);
  assert.match(html, /Not in that backup/);
  assert.doesNotMatch(html, /First side read in full/);
});

test("endpoint security policies are listed under Defender, by area, not as Intune settings catalog policies", () => {
  const policy = (name: string, family: string | null, description = "") => row(`configurationPolicy:${name}`, {
    name, description, platforms: "windows10", technologies: "mdm", ...(family ? { templateReference: { templateFamily: family } } : {}),
  }, `${name}${description}`);
  const section = compareSettings(
    { rows: [policy("KEEL-RT-AV", "endpointSecurityAntivirus"), policy("KEEL-RT-Wifi", null), policy("KEEL-RT-Same", null)], coverage: null },
    { rows: [policy("KEEL-RT-AV", "endpointSecurityAntivirus", "now"), policy("KEEL-RT-Wifi", null, "now"), policy("KEEL-RT-FW", "endpointSecurityFirewall"), policy("KEEL-RT-Same", null)], coverage: null },
  ) as SettingsSection;
  assert.equal(section.groups.length, 1, "the engine keeps one group per stored type");

  const groups = settingsByKind(section.groups);
  assert.deepEqual(groups.map((group) => [groupKind(group), group.resourceType, group.added, group.removed, group.changed, group.unchanged, group.total, group.items.map((item) => item.name)]), [
    ["configurationPolicy", "configurationPolicy", 0, 0, 1, 1, 1, ["KEEL-RT-Wifi"]],
    ["defenderEndpointSecurityPolicy", "configurationPolicy", 1, 0, 1, 0, 2, ["KEEL-RT-AV", "KEEL-RT-FW"]],
  ]);
  // A type with no endpoint security policy among its items stays as it is.
  const plain = settingsByKind([{ ...section.groups[0], families: undefined, items: section.groups[0].items.filter((item) => !item.templateFamily) }]);
  assert.equal(plain.length, 1);
  assert.equal(plain[0].kind, undefined);
  // Only endpoint security policies: no empty Intune group is left behind.
  assert.deepEqual(settingsByKind([{ ...section.groups[0], changed: 1, added: 1, items: section.groups[0].items.filter((item) => item.templateFamily) }]).map(groupKind), ["defenderEndpointSecurityPolicy"]);

  const data: CompareData = { generatedAt: "2026-10-03T00:00:00.000Z", tenants: TENANTS, input: { from: ID(1), to: ID(2) }, result: result(section), problem: null };
  const html = renderToStaticMarkup(createElement(CompareView, { data }));
  // Each policy sits under its own service's heading.
  const blocks = html.split(/<h3 class="bl-service-heading">/).slice(1).map((block) => block.slice(0, block.indexOf("</h3>")).replace(/<[^>]+>/g, "") + "|" + block);
  const serviceOf = (name: string) => blocks.find((block) => block.includes(name))?.split("|")[0];
  assert.equal(serviceOf("KEEL-RT-AV"), "Defender");
  assert.equal(serviceOf("KEEL-RT-FW"), "Defender");
  assert.equal(serviceOf("KEEL-RT-Wifi"), "Intune");
  assert.match(html, /Endpoint security policy/);
});

test("endpoint security policies past the list limit are counted under Defender, not Intune", () => {
  const policy = (name: string, family: string | null) => row(`configurationPolicy:${name}`, {
    name, platforms: "windows10", technologies: "mdm", ...(family ? { templateReference: { templateFamily: family } } : {}),
  }, name);
  // Plain policies sort first, so no endpoint security policy is in the listed items.
  const plain = Array.from({ length: MAX_ITEMS + 1 }, (_, index) => policy(`KEEL-RT-A${String(index).padStart(3, "0")}`, null));
  const av = Array.from({ length: 5 }, (_, index) => policy(`KEEL-RT-Z${index}`, "endpointSecurityAntivirus"));
  const section = compareSettings({ rows: [], coverage: null }, { rows: [...plain, ...av], coverage: null }) as SettingsSection;
  assert.equal(section.groups[0].items.length, MAX_ITEMS);

  const groups = settingsByKind(section.groups);
  assert.deepEqual(groups.map((group) => [groupKind(group), group.added, group.total, group.items.length]), [
    ["configurationPolicy", MAX_ITEMS + 1, MAX_ITEMS + 1, MAX_ITEMS],
    ["defenderEndpointSecurityPolicy", 5, 5, 0],
  ]);

  const html = renderToStaticMarkup(createElement(CompareView, { data: { generatedAt: "2026-10-03T00:00:00.000Z", tenants: TENANTS, input: { from: ID(1), to: ID(2) }, result: result(section), problem: null } }));
  const blocks = html.split(/<h3 class="bl-service-heading">/).slice(1);
  const defender = blocks.find((block) => block.startsWith("Defender") || block.slice(0, block.indexOf("</h3>")).replace(/<[^>]+>/g, "") === "Defender");
  assert.ok(defender, "a Defender block is shown");
  assert.match(defender, /And 5 more\./);
  const intune = blocks.find((block) => block.slice(0, block.indexOf("</h3>")).replace(/<[^>]+>/g, "") === "Intune");
  assert.ok(intune, "an Intune block is shown");
  assert.match(intune, /And 1 more\./);

  // An older result without per-family counts still counts what it lists.
  const old = settingsByKind([{ ...section.groups[0], families: undefined }]);
  assert.deepEqual(old.map(groupKind), ["configurationPolicy"]);
});
