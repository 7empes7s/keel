import assert from "node:assert/strict";
import { test } from "node:test";

import { paletteResults, type Command } from "@/components/command-palette";
import { initials } from "@/components/shell/menu";
import { settingsStatus } from "@/lib/menu-status";
import { accessInFull, accessSummary } from "@/lib/presentation";

const command = (group: Command["group"], label: string, keywords = ""): Command =>
  ({ id: `${group}:${label}`, label, hint: "", keywords, group, icon: "page", run: () => undefined });

test("the search groups matches and hides items until something is typed", () => {
  const commands = [
    command("Pages", "Setup", "onboarding consent"),
    command("Pages", "Schedules"),
    command("Your views", "Failed backups this week"),
    command("Actions", "Back up the critical settings now", "backup"),
    command("People and settings", "Amara Okafor", "person"),
  ];
  assert.deepEqual(paletteResults(commands, "").map((entry) => entry.group), ["Actions", "Pages", "Your views"]);
  assert.deepEqual(paletteResults(commands, "consent").flatMap((entry) => entry.commands.map((found) => found.label)), ["Setup"]);
  assert.deepEqual(paletteResults(commands, "amara").map((entry) => entry.group), ["People and settings"]);
  // The group holding the best match leads: a label prefix in Actions beats a loose page match.
  assert.equal(paletteResults(commands, "back")[0].group, "Actions");
  assert.equal(paletteResults(commands, "fail")[0].group, "Your views");
});

test("Settings is urgent when nobody can approve, and check soon when a channel is failing", () => {
  const admin = { capabilities: ["read", "approve"], disabled_at: null };
  const viewer = { capabilities: ["read"], disabled_at: null };
  assert.equal(settingsStatus({ principals: [viewer, { ...admin, disabled_at: "2026-09-01T00:00:00Z" }], deliveries: null })?.tone, "urgent");
  assert.equal(settingsStatus({ principals: [viewer, { ...admin, system_kind: "scheduler" }], deliveries: null })?.tone, "urgent", "a system account is not an approver");
  assert.equal(settingsStatus({ principals: [admin], deliveries: null }), undefined);
  assert.equal(settingsStatus({ principals: [{ ...viewer, entity_capabilities: { FIN: ["approve"] } }], deliveries: null }), undefined, "an entity approver counts");
  assert.equal(settingsStatus({ principals: [admin], deliveries: [{ channel_id: "a", status: "cancelled" }, { channel_id: "a", status: "failed" }] }), undefined, "a channel turned off after failing is not failing");
  // Newest first: a channel whose latest finished delivery failed counts; a later success clears it.
  const failing = settingsStatus({ principals: [admin], deliveries: [
    { channel_id: "a", status: "retrying" }, { channel_id: "a", status: "failed" }, { channel_id: "b", status: "delivered" }, { channel_id: "b", status: "failed" },
  ] });
  assert.deepEqual(failing, { tone: "soon", count: 1, note: "1 alert channel is failing to send" });
  assert.equal(settingsStatus({ principals: null, deliveries: null }), undefined, "unread lists say nothing");
});

test("the menu shows a name's initials and the access in words", () => {
  assert.equal(initials("Marouane Defili"), "MD");
  assert.equal(initials("amara.okafor@contoso.example"), "AO");
  assert.equal(initials("Élodie"), "ÉL");
  assert.equal(accessInFull(["read", "approve", "users", "roles", "policies"]), "You can approve, manage people, grant roles and manage policies", "plain verbs, never the codes");
  assert.match(accessSummary(["read", "approve", "users", "roles", "policies"]), /more$/, "the summary still caps at three verbs");
});
