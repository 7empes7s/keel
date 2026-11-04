import assert from "node:assert/strict";
import { mock, test } from "node:test";

import { startPoll } from "@/lib/use-poll";

// Old PR #713: a hidden tab kept its timers firing (each tick was skipped), and every
// return to the tab read again at once, so flicking between tabs refetched the menu, the
// approvals and the Settings lists. Now a hidden tab keeps no timer, and a return reads
// at once only if a tick fell due while away.

// A tab whose visibility the test flips; timers and the clock are mocked.
function fakeTab(state: DocumentVisibilityState = "visible") {
  const target = new EventTarget();
  const tab = {
    visibilityState: state,
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    show(next: DocumentVisibilityState) {
      tab.visibilityState = next;
      target.dispatchEvent(new Event("visibilitychange"));
    },
  };
  return tab;
}

const env = (tab: ReturnType<typeof fakeTab>) => ({ document: tab as never, now: () => Date.now() });

test("the poll keeps no timer while the tab is hidden and catches up only when a tick was missed", (t) => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  t.after(() => mock.timers.reset());
  const tab = fakeTab();
  let ticks = 0;
  const stop = startPoll(() => { ticks += 1; }, 60_000, env(tab));

  mock.timers.tick(60_000);
  assert.equal(ticks, 1, "ticks on schedule while visible");

  tab.show("hidden");
  mock.timers.tick(5 * 60_000);
  assert.equal(ticks, 1, "nothing runs while hidden");

  tab.show("visible");
  assert.equal(ticks, 2, "back after a missed tick: one catch-up read");

  mock.timers.tick(10_000);
  tab.show("hidden");
  tab.show("visible");
  assert.equal(ticks, 2, "a quick flick between tabs does not refetch");

  mock.timers.tick(50_000);
  assert.equal(ticks, 3, "the schedule carries on from the catch-up");

  stop();
  mock.timers.tick(5 * 60_000);
  tab.show("hidden");
  tab.show("visible");
  assert.equal(ticks, 3, "a stopped poll never ticks again");
});

test("a poll started in a hidden tab waits until the tab is shown", (t) => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  t.after(() => mock.timers.reset());
  const tab = fakeTab("hidden");
  let ticks = 0;
  const stop = startPoll(() => { ticks += 1; }, 10_000, env(tab));
  mock.timers.tick(60_000);
  assert.equal(ticks, 0);
  tab.show("visible");
  assert.equal(ticks, 1, "the first view after a long wait reads at once");
  mock.timers.tick(10_000);
  assert.equal(ticks, 2);
  stop();
});

test("a read still running is never stacked with another, and a throwing tick keeps the poll", async (t) => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  t.after(() => mock.timers.reset());
  const tab = fakeTab();
  let started = 0;
  let finish!: () => void;
  const stop = startPoll(() => {
    started += 1;
    return new Promise<void>((resolve) => { finish = resolve; });
  }, 10_000, env(tab));
  mock.timers.tick(10_000);
  assert.equal(started, 1);
  mock.timers.tick(30_000);
  assert.equal(started, 1, "no new read while the first is still running");
  finish();
  await new Promise((resolve) => setImmediate(resolve));
  mock.timers.tick(10_000);
  assert.equal(started, 2, "the next tick after the read settled starts one");
  stop();

  let calls = 0;
  const stopThrowing = startPoll(() => { calls += 1; throw new Error("boom"); }, 10_000, env(tab));
  assert.throws(() => mock.timers.tick(10_000), /boom/);
  assert.throws(() => mock.timers.tick(10_000), /boom/);
  assert.equal(calls, 2, "the poll carries on after a tick threw");
  stopThrowing();
});
