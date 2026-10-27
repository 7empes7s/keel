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

// Item 5 (#548 review): a settings file the restorer can't read shows which file, what is
// wrong and what to do; the path, the stack and the error code stay behind "Show details".
test("a settings file Keel can't read reads as which file, what is wrong and what to do", () => {
  const stderr = [
    "exit code 1",
    "stderr: ConfigFileError: Keel can't read the Exchange restorer settings file (/etc/keel/exchange-restorer.json): the file is missing. Fix the file on the Keel server, or remove it from workload-scope.json.",
    "    at readConfigFile (file:///opt/keel-live/engine/config/configFile.mjs:57:11)",
    "    at familyConfigPath (file:///opt/keel-live/engine/collect/workloads/powershellConfigs.mjs:116:18) {",
    "  path: '/etc/keel/exchange-restorer.json',",
    "  problem: 'the file is missing',",
    "  code: 'ENOENT'",
    "}",
  ].join("\n");
  const words = plainError(stderr, { service: "Keel" });
  assert.equal(words.cause, "Keel can't read the Exchange restorer settings file: the file is missing.");
  assert.equal(words.todo, "Fix the file on the Keel server, or remove it from workload-scope.json.");
  assert.equal(words.raw, stderr.trim());
  assert.doesNotMatch(`${words.cause} ${words.todo}`, RAW_ERROR_PATTERN);
  assert.doesNotMatch(`${words.cause} ${words.todo}`, /\/etc\/keel|ENOENT/);

  const json = plainError(JSON.stringify("Keel can't read the restorer settings file (/etc/keel/restorer.json): it is not valid JSON. Fix the file on the Keel server, then try again."));
  assert.equal(json.cause, "Keel can't read the restorer settings file: it is not valid JSON.");
  assert.equal(json.todo, "Fix the file on the Keel server, then try again.");
});

test("an older raw missing settings file still reads in plain words; other missing-file and JSON errors keep their own words", () => {
  const missing = plainError("exit code 1\nstderr: Error: ENOENT: no such file or directory, open '/etc/keel/exchange-collector.json'");
  assert.equal(missing.cause, "A settings file Keel needs on its server is missing.");
  assert.ok(missing.todo.split(" ").length <= 20);
  assert.doesNotMatch(`${missing.cause} ${missing.todo}`, RAW_ERROR_PATTERN);
  // An HTML answer from Microsoft or a proxy, a missing program or content blob: not a settings file.
  assert.equal(plainError("Graph GET /users failed 503: Unexpected token '<', \"<html>\" is not valid JSON").cause, "Microsoft 365 had a temporary fault.");
  assert.equal(plainError("ServiceNow answered 500: Unexpected end of JSON input", { service: "ServiceNow" }).cause, "ServiceNow had a temporary fault.");
  assert.equal(plainError("spawn pwsh ENOENT").cause, "It stopped with an error.");
});

test("the settings-file sentence is found inside an error stored as an object too", () => {
  const sentence = "Keel can't read the restorer settings file (/etc/keel/restorer.json): the file is missing. Fix the file on the Keel server, then try again.";
  for (const error of [{ message: `exit code 1\nstderr: ConfigFileError: ${sentence}\n    at x` }, { error: `${sentence}\n    at x` }]) {
    assert.equal(plainError(error).cause, "Keel can't read the restorer settings file: the file is missing.");
  }
});
