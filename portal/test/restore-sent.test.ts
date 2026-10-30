import assert from "node:assert/strict";
import { test } from "node:test";

import { restoreSentNotice } from "@/lib/restore-sent";
import { personLabel } from "@/lib/sentences";

// After sending a restore: it waits for approvers, unless restore approvals are off for
// every service it writes to, and then the person is told it started and why.
test("a restore that waits says so; one approved by the setting says it started and names the services", () => {
  const waiting = restoreSentNotice({ status: "pending", executor: "worker" });
  assert.equal(waiting.started, false);
  assert.equal(waiting.title, "Sent to approvers");
  assert.equal(waiting.href, "/approvals");

  const started = restoreSentNotice({ status: "approved", executor: "worker", approvalSkippedFor: ["Entra", "Intune"] });
  assert.equal(started.started, true);
  assert.equal(started.title, "Restore started");
  assert.match(started.detail, /Restore approvals are off for Entra and Intune/);

  const cli = restoreSentNotice({ status: "approved", executor: "cli", approvalSkippedFor: ["Exchange"] });
  assert.equal(cli.title, "Restore approved");
  assert.match(cli.detail, /An operator runs it from the command line/);

  // An approved row without the setting's services is never shown as skipped.
  assert.equal(restoreSentNotice({ status: "approved" }).started, false);
  assert.equal(restoreSentNotice(null).started, false);
});

test("the setting is named in words where an approver's name would go, never as a code", () => {
  const ref = { kind: "person", id: "restore-approval-setting", name: "restore-approval-setting", email: null, readable: true, system: true };
  assert.equal(personLabel(ref as never), "Keel (restore approvals are off)");
});
