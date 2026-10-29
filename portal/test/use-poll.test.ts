import assert from "node:assert/strict";
import { mock, test } from "node:test";

import { startPoll } from "@/lib/use-poll";

// A tab whose visibility the test flips; timers and the clock are mocked.
function fakeTab() {
  const target = new EventTarget();
  const tab = {
    visibilityState: "visible" as DocumentVisibilityState,
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    show(state: DocumentVisibilityState) {
      tab.visibilityState = state;
      target.dispatchEvent(new Event("visibilitychange"));
    },
  };
  return tab;
}

test("the poll keeps no timer while the tab is hidden and catches up only when a tick was missed", (t) => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  t.after(() => mock.timers.reset());
  const tab = fakeTab();
  let ticks = 0;
  const stop = startPoll(() => { ticks += 1; }, 60_000, { document: tab as never, now: () => Date.now() });

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
  const tab = fakeTab();
  tab.visibilityState = "hidden";
  let ticks = 0;
  const stop = startPoll(() => { ticks += 1; }, 10_000, { document: tab as never, now: () => Date.now() });
  mock.timers.tick(60_000);
  assert.equal(ticks, 0);
  tab.show("visible");
  assert.equal(ticks, 1, "the first view after a long wait reads at once");
  mock.timers.tick(10_000);
  assert.equal(ticks, 2);
  stop();
});
