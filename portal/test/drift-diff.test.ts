import assert from "node:assert/strict";
import { test } from "node:test";

import { diffPayloads } from "@/lib/drift-diff";

test("nested object fields are reported by dotted path", () => {
  const changes = diffPayloads(
    { state: "enabled", conditions: { users: { include: ["a"] }, platforms: "all" } },
    { state: "disabled", conditions: { users: { include: ["a", "b"] }, clientApps: "browser" } },
  );
  assert.deepEqual(changes, [
    { path: "conditions.clientApps", kind: "added", after: "browser" },
    { path: "conditions.platforms", kind: "removed", before: "all" },
    { path: "conditions.users.include", kind: "changed", before: ["a"], after: ["a", "b"] },
    { path: "state", kind: "changed", before: "enabled", after: "disabled" },
  ]);
});

test("identical payloads and whole-resource adds or removes produce no field list", () => {
  assert.deepEqual(diffPayloads({ a: 1 }, { a: 1 }), []);
  assert.deepEqual(diffPayloads(null, { a: 1 }), []);
  assert.deepEqual(diffPayloads({ a: 1 }, null), []);
});

test("a type change at a field is one change, not a walk into either side", () => {
  assert.deepEqual(diffPayloads({ a: { b: 1 } }, { a: "x" }), [
    { path: "a", kind: "changed", before: { b: 1 }, after: "x" },
  ]);
});

test("the change list is capped so a huge payload cannot flood the page", () => {
  const before = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, i]));
  const after = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, i + 1]));
  assert.equal(diffPayloads(before, after, 50).length, 50);
});
