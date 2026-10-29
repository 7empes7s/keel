import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { EntityScope } from "@/lib/principal";
import { loadShellLookups, type ShellLookupLoaders } from "@/lib/shell-lookups";

const CENTRAL: EntityScope = { central: true, entities: [] };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("the approvals count and the name are read at the same time", async () => {
  const count = deferred<number>();
  const name = deferred<string | null>();
  const started: string[] = [];
  const loaders: ShellLookupLoaders = {
    pendingApprovalCount: (scope) => {
      assert.equal(scope, CENTRAL);
      started.push("count");
      return count.promise;
    },
    displayName: (id) => {
      assert.equal(id, "p-1");
      started.push("name");
      return name.promise;
    },
  };
  const result = loadShellLookups({ approverScope: CENTRAL, principalId: "p-1" }, loaders);
  // Neither read has finished, yet both have started: they are not one after the other.
  await Promise.resolve();
  assert.deepEqual(started.sort(), ["count", "name"]);
  name.resolve("Ada Lovelace");
  count.resolve(3);
  assert.deepEqual(await result, { pendingApprovals: 3, displayName: "Ada Lovelace" });
});

test("a failed read hides only its own piece", async () => {
  const failingCount: ShellLookupLoaders = {
    pendingApprovalCount: async () => { throw new Error("database down"); },
    displayName: async () => "Ada Lovelace",
  };
  assert.deepEqual(await loadShellLookups({ approverScope: CENTRAL, principalId: "p-1" }, failingCount), {
    pendingApprovals: null,
    displayName: "Ada Lovelace",
  });

  const failingName: ShellLookupLoaders = {
    pendingApprovalCount: async () => 2,
    displayName: () => Promise.reject(new Error("database down")),
  };
  assert.deepEqual(await loadShellLookups({ approverScope: CENTRAL, principalId: "p-1" }, failingName), {
    pendingApprovals: 2,
    displayName: null,
  });
});

test("nothing is read for a non-approver or a request without a principal", async () => {
  const loaders: ShellLookupLoaders = {
    pendingApprovalCount: () => assert.fail("a non-approver's count must not be read"),
    displayName: () => assert.fail("no principal, so no name read"),
  };
  assert.deepEqual(await loadShellLookups({ approverScope: null, principalId: null }, loaders), {
    pendingApprovals: null,
    displayName: null,
  });
});

test("the layout loads its lookups through the parallel loader, not one await after another", () => {
  const layout = readFileSync(fileURLToPath(new URL("../app/layout.tsx", import.meta.url)), "utf8");
  assert.match(layout, /loadShellLookups\(/);
  assert.doesNotMatch(layout, /await getPendingApprovalCount\(/);
  assert.doesNotMatch(layout, /await principalDisplayName\(/);
});
