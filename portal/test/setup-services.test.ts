import assert from "node:assert/strict";
import { test } from "node:test";

import { typeService } from "@/lib/baselines-view";
import { SERVICES } from "@/lib/services";
import {
  EXPIRY_WARNING_DAYS, credentialWarnings, credentialsFine, credentialsLink, lastReadWords, serviceStatuses, servicesSummary,
  type ConnectionExpiry,
} from "@/lib/setup-services";
import type { CoverageType } from "@/lib/types";

const NOW = "2026-10-22T12:00:00.000Z";
const HOURS_AGO = (hours: number) => new Date(Date.parse(NOW) - hours * 3_600_000).toISOString();

function kind(type: string, extra: Partial<CoverageType> = {}): CoverageType {
  return {
    type, reportStatus: "covered", protectionState: "protected", stale: false, itemCount: 3, lastCollectedAt: HOURS_AGO(2), adapter: `graph/${type}`,
    outcome: "complete", detail: null, fidelity: { declared: "read-only", measured: null, verifiedAt: null }, criticality: "tier1", blastRadius: null, remappable: null,
    ...extra,
  };
}

const ENTRA = ["user", "group", "conditionalAccessPolicy"];

test("every Microsoft 365 service gets one line, worst first, and Keel's own records are left out", () => {
  const types = [
    ...ENTRA.map((type) => kind(type)),
    kind("exchange-mail-flow", { outcome: "failed", lastCollectedAt: HOURS_AGO(30) }),
    kind("teams-org-policies", { stale: true, lastCollectedAt: HOURS_AGO(80) }),
  ];
  assert.equal(typeService("exchange-mail-flow").code, "Exchange");
  const statuses = serviceStatuses(types, NOW);
  assert.deepEqual(statuses.map((status) => status.code).sort(), SERVICES.filter((s) => s.code !== "Keel").map((s) => s.code).sort());
  assert.deepEqual(statuses.slice(0, 3).map((status) => [status.code, status.label]), [
    ["Exchange", "Failing"], ["Teams", "Out of date"], ["Entra", "Working"],
  ]);
  // Services with nothing read yet say so plainly, and come last.
  const intune = statuses.find((status) => status.code === "Intune")!;
  assert.equal(intune.label, "Not set up");
  assert.equal(intune.tone, "neutral");
  assert.equal(lastReadWords(intune, NOW), "No good read yet");
});

test("kinds not placed in a service yet get their own line instead of being hidden", () => {
  const statuses = serviceStatuses([kind("keelTestUnplacedKind", { outcome: "partial" })], NOW);
  assert.equal(statuses.length, SERVICES.length);
  assert.deepEqual([statuses[0].name, statuses[0].label], ["Other services", "Failing"]);
  assert.match(statuses[0].blocker!.text, /read only part of it/);
});

test("a service line says what backed up, what Keel can put back, the last good read and the fix", () => {
  const statuses = serviceStatuses([
    kind("user", { fidelity: { declared: "full", measured: "full", verifiedAt: HOURS_AGO(100) } }),
    kind("group", { outcome: "failed", diagnosis: { diagnosis: "missing-scope", original: { httpStatus: 403, graphCode: "Authorization_RequestDenied" } } }),
    kind("conditionalAccessPolicy", { lastCollectedAt: HOURS_AGO(1) }),
  ], NOW);
  const entra = statuses.find((status) => status.code === "Entra")!;
  assert.equal(entra.tone, "urgent");
  assert.equal(entra.backup.text, "1 kind failed, 2 of 3 backed up");
  assert.equal(entra.restore.tone, "fine");
  assert.match(entra.restore.text, /^1 of 3 can be put back, 1 proven on this tenant$/);
  // The last good read ignores the failed kind.
  assert.equal(entra.lastGoodRead, HOURS_AGO(1));
  assert.equal(lastReadWords(entra, NOW), "Last good read 1 hour ago");
  // The missing permission is the blocker, and its fix is the read access setup.
  assert.match(entra.blocker!.text, /missing a permission/);
  assert.deepEqual(entra.blocker!.fix, { label: "Check read access", href: "#setup-read" });
});

test("a plain failure links to the failed kinds of that service; out of date links to those", () => {
  const [exchange, teams] = serviceStatuses([
    kind("exchange-mail-flow", { outcome: "failed" }),
    kind("teams-org-policies", { stale: true, lastCollectedAt: HOURS_AGO(80) }),
  ], NOW);
  assert.equal(exchange.blocker!.fix!.href, "/protect?service=Exchange&health=failed");
  assert.equal(teams.blocker!.fix!.href, "/protect?service=Teams&health=out-of-date");
  assert.match(teams.blocker!.text, /3 days ago, longer ago than its tier allows/);
  assert.deepEqual(servicesSummary([exchange, teams]), { tone: "urgent", text: "1 of 2 services is failing to back up." });
});

test("a service the tenant has no licence for is not a failure", () => {
  const purview = serviceStatuses([kind("purview-labels", { outcome: "unavailable" })], NOW).find((status) => status.code === "Purview")!;
  assert.equal(purview.label, "Not on this tenant");
  assert.equal(purview.tone, "neutral");
  assert.equal(purview.blocker, null);
});

function connection(extra: Partial<ConnectionExpiry>): ConnectionExpiry {
  return { role: "settings-reader", name: "Keel Settings Reader", appId: "app-collector", credentialExpiresAt: "2027-06-01T00:00:00.000Z", ...extra };
}

test(`a Keel app certificate warns ${EXPIRY_WARNING_DAYS} days before it ends, with the Entra page to renew it`, () => {
  assert.deepEqual(credentialWarnings([connection({})], NOW), []);
  assert.equal(credentialsFine([connection({}), connection({ role: "settings-restorer", appId: "app-restorer", credentialExpiresAt: "2027-03-01T00:00:00.000Z" })]),
    "Keel's app certificates are valid until at least 1 Mar 2027.");

  const [soon] = credentialWarnings([connection({ credentialExpiresAt: "2026-11-12T00:00:00.000Z" })], NOW);
  assert.equal(soon.tone, "soon");
  assert.equal(soon.title, "Keel Settings Reader: its certificate expires in 21 days, on 12 Nov 2026");
  assert.match(soon.detail, /settings backups stop/);
  assert.deepEqual(soon.fix, { label: "Add a new certificate in Entra ID", href: credentialsLink("app-collector") });
  assert.match(soon.fix.href, /^https:\/\/entra\.microsoft\.com\/.*\/Credentials\/appId\/app-collector$/);

  const [week] = credentialWarnings([connection({ role: "settings-restorer", name: "Keel Settings Restorer", appId: null, credentialExpiresAt: "2026-10-25T00:00:00.000Z" })], NOW);
  assert.equal(week.tone, "urgent");
  assert.match(week.title, /^Keel Settings Restorer: its certificate expires in 3 days/);
  assert.match(week.detail, /restores stop/);
  // Without an app id the link opens the app list rather than guessing.
  assert.match(week.fix.href, /ApplicationsListBlade$/);

  const [expired] = credentialWarnings([connection({ credentialExpiresAt: "2026-10-20T12:00:00.000Z" })], NOW);
  assert.equal(expired.tone, "urgent");
  assert.match(expired.title, /expired 2 days ago$/);
  assert.match(expired.detail, /Keel cannot sign in as this app/);
});

test("an unknown date is never shown as fine, and the soonest certificate comes first", () => {
  assert.deepEqual(credentialWarnings(null, NOW), []);
  assert.equal(credentialsFine(null), null);
  assert.equal(credentialsFine([connection({ credentialExpiresAt: null })]), null);
  const both = credentialWarnings([
    connection({ credentialExpiresAt: "2026-11-15T00:00:00.000Z" }),
    connection({ role: "content-reader", name: "Keel Content Reader", credentialExpiresAt: "2026-11-01T00:00:00.000Z" }),
  ], NOW);
  assert.deepEqual(both.map((warning) => warning.role), ["content-reader", "settings-reader"]);
  assert.match(both[0].detail, /mail, file and Teams backups stop/);
});
