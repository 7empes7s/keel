import assert from "node:assert/strict";
import { test } from "node:test";

import type { Destination, DestinationStatus } from "@/lib/integrations";
import { destinationGroups, destinationLine } from "@/lib/integrations-view";

const base = { tenant_ref: "t", enabled: true, revoked_at: null, created_by: "a", created_at: "2026-10-27T00:00:00Z" };
const dest = (id: string, name: string, kind: string, extra: Partial<Destination> = {}) => ({ ...base, id, name, kind, config: {}, ...extra }) as Destination;
const status = (destinationId: string, extra: Partial<DestinationStatus> = {}) => ({ destinationId, tenantRef: "t", kind: "cef", paused: false, pending: 0, delivering: 0, acknowledged: 0, quarantined: 0, oldestPendingObservedAt: null, lagMs: null, ...extra }) as DestinationStatus;

test("destinations group by kind in a fixed order, worst first, then by name", () => {
  const groups = destinationGroups([
    dest("1", "Zeta SIEM", "cef"),
    dest("2", "Alpha SIEM", "cef"),
    dest("3", "Broken SIEM", "cef"),
    dest("4", "Hook", "webhook"),
    dest("5", "Paused hook", "webhook", { enabled: false }),
  ], [status("3", { quarantined: 2 })]);
  assert.deepEqual(groups.map((group) => group.key), ["webhook", "cef"]);
  assert.deepEqual(groups[0].items.map((item) => item.name), ["Paused hook", "Hook"]);
  assert.deepEqual(groups[1].items.map((item) => item.name), ["Broken SIEM", "Alpha SIEM", "Zeta SIEM"]);
});

test("a destination's line says what waits and how far behind it is", () => {
  assert.equal(destinationLine(dest("1", "a", "cef"), status("1", { pending: 14, delivering: 2, lagMs: 41_000 })), "16 waiting, behind by 41 seconds");
  assert.equal(destinationLine(dest("1", "a", "cef"), status("1")), "Nothing waiting");
  assert.equal(destinationLine(dest("1", "a", "cef", { enabled: false }), null), "Paused: new entries wait");
});
