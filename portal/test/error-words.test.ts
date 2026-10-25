import assert from "node:assert/strict";
import { test } from "node:test";

import { plainError, RAW_ERROR_PATTERN, rawErrorText } from "@/lib/error-words";

// Raw errors become a short plain cause and a next step; the raw text is kept only for
// "Show details" (components/ui/error-notice.tsx).

test("each kind of raw error gets a plain cause and a next step, never the raw text", () => {
  const cases: Array<[string, RegExp]> = [
    ["Graph 429: throttled after 5 retries on /deviceManagement/deviceConfigurations", /was busy and asked Keel to slow down/],
    ["Graph 403: Authorization_RequestDenied on PATCH /groups/5d1c0000-0000-4000-8000-0000000000f2", /missing a permission/],
    ["KEEL-RT-group (group): Microsoft 365 refused access to this mailbox only; other mailboxes read fine (403 ErrorAccessDenied Access is denied.)", /refused Keel access to one mailbox/],
    ["Graph 404 on /groups/5d1c0000-0000-4000-8000-0000000000f2", /no longer exists/],
    ["KEEL-RT-Planner group: HTTP 503 from Microsoft", /temporary fault/],
    ["Graph 400: Exchange Online would not accept 2 of the mailbox rules", /would not accept/],
    ["connect ETIMEDOUT 10.0.0.1:443", /did not answer in time/],
    ["drift-detect deferred: collection snapshot has failed", /waited for a complete backup/],
    ["something nobody planned for", /^It stopped with an error\.$/],
  ];
  for (const [raw, cause] of cases) {
    const words = plainError(raw);
    assert.match(words.cause, cause, raw);
    assert.ok(words.todo.length > 0 && words.todo.split(" ").length <= 20, `${raw}: short next step`);
    assert.equal(words.raw, raw);
    assert.doesNotMatch(`${words.cause} ${words.todo}`, RAW_ERROR_PATTERN, `${raw}: no raw text in the plain words`);
  }
});

test("the service name reads in the cause, and empty errors have nothing to show", () => {
  assert.equal(plainError("timed out", { service: "ServiceNow" }).cause, "ServiceNow did not answer in time.");
  assert.equal(plainError(null).raw, null);
  assert.equal(rawErrorText("  "), null);
  assert.equal(rawErrorText({ code: 1 }), '{"code":1}');
});

test("the raw-error pattern catches engine errors and leaves plain sentences alone", () => {
  for (const raw of ["Graph 429: throttled", "HTTP 503 from Microsoft", "TypeError: x is undefined", "PATCH /groups/abc", "ECONNREFUSED", "schedule_minimum_interval: collect requires 15 minutes"]) {
    assert.match(raw, RAW_ERROR_PATTERN, raw);
  }
  for (const plain of ["Microsoft 365 was busy and asked Keel to slow down.", "Last run failed. Microsoft 365 had a temporary fault.", "4,590 settings in 6 kinds", "Errors: 2"]) {
    assert.doesNotMatch(plain, RAW_ERROR_PATTERN, plain);
  }
});
