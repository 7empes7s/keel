import assert from "node:assert/strict";
import { test } from "node:test";

import { notSavedMessage } from "@/components/baselines/change-decision";
import { BusyError, sendEach } from "@/lib/send-each";

// Accepting 775 changes fired 775 requests at once and the pool ran dry: never more
// than a few may be in flight.
test("sendEach keeps only a few requests in flight and answers each item in order", async () => {
  let inFlight = 0;
  let most = 0;
  const items = Array.from({ length: 775 }, (_, index) => index);
  const progress: number[] = [];
  const results = await sendEach(items, async (item) => {
    inFlight++;
    most = Math.max(most, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 0));
    inFlight--;
    return item * 2;
  }, { atOnce: 4, onProgress: (done) => progress.push(done) });
  assert.equal(most, 4);
  assert.equal(results.length, 775);
  assert.deepEqual(results.map((result) => (result.ok ? result.value : null)), items.map((item) => item * 2));
  assert.equal(progress.at(-1), 775);
});

test("sendEach goes on after a failure and names it, and retries a busy answer", async () => {
  const tries = new Map<string, number>();
  const results = await sendEach(["a", "busy-once", "bad", "always-busy", "e"], async (item) => {
    const n = (tries.get(item) ?? 0) + 1;
    tries.set(item, n);
    if (item === "bad") throw new Error("refused");
    if (item === "always-busy") throw new BusyError("busy");
    if (item === "busy-once" && n === 1) throw new BusyError("busy");
    return item;
  }, { backoffMs: 0, retries: 2 });
  assert.deepEqual(results.map((result) => result.ok), [true, true, false, false, true]);
  assert.equal(tries.get("busy-once"), 2);
  assert.equal(tries.get("bad"), 1, "a refusal is not retried");
  assert.equal(tries.get("always-busy"), 3, "a busy answer is tried twice more, then reported");
});

test("the not-saved message counts what was saved and names what was not", () => {
  assert.equal(
    notSavedMessage(775, ["Group1 (user)", "Wies Jeff (user)", "ac_l.staar (user)", "x", "y"]),
    "Saved 770 of 775 changes. 5 changes could not be saved and are still chosen: Group1 (user), Wies Jeff (user), ac_l.staar (user) and 2 more. Try again to save them.",
  );
  assert.equal(notSavedMessage(3, ["A", "B"]), "Saved 1 of 3 changes. 2 changes could not be saved and are still chosen: A and B. Try again to save them.");
  assert.equal(notSavedMessage(2, ["A", "B"]), "2 changes could not be saved and are still chosen: A and B. Try again to save them.");
  assert.equal(notSavedMessage(4, ["A"]), "Saved 3 of 4 changes. 1 change could not be saved and is still chosen: A. Try again to save it.");
});
