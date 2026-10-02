import assert from "node:assert/strict";
import { test } from "node:test";

import { dismissToast, getToasts, subscribeToasts, toast } from "@/lib/toast";

test("toasts default to success, notify subscribers, keep the newest four and dismiss by id", () => {
  let notified = 0;
  const unsubscribe = subscribeToasts(() => { notified += 1; });
  const ids = ["a", "b", "c", "d", "e"].map((title) => toast({ title }));
  assert.equal(notified, 5);
  assert.deepEqual(getToasts().map((item) => item.title), ["b", "c", "d", "e"]);
  assert.equal(getToasts()[0].tone, "success");
  dismissToast(ids[2]);
  assert.deepEqual(getToasts().map((item) => item.title), ["b", "d", "e"]);
  dismissToast(9999);
  assert.equal(notified, 6, "dismissing an unknown id does not notify");
  unsubscribe();
  for (const item of getToasts()) dismissToast(item.id);
});
