import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { RecoveryMechanismTable, mechanismLabel, type RecoveryMechanism } from "@/components/recovery-mechanism";

const entry = (overrides: Partial<RecoveryMechanism>): RecoveryMechanism => ({
  naturalKey: "group:hr",
  mechanism: "soft-delete-restore",
  idOutcome: "retained",
  retainedId: "g-1",
  deadline: "2026-10-30T09:00:00Z",
  credentialMode: "restorer",
  reason: null,
  ...overrides,
});

test("every mechanism has a plain-language label", () => {
  assert.equal(mechanismLabel("soft-delete-restore"), "Restore from deleted items");
  assert.equal(mechanismLabel("refused"), "Refused");
  assert.equal(mechanismLabel("manual"), "Manual handoff");
});

test("the table shows id outcome, deadline and the refusal reason", () => {
  const html = renderToStaticMarkup(createElement(RecoveryMechanismTable, {
    mechanisms: [
      entry({}),
      entry({ naturalKey: "group:old", mechanism: "refused", idOutcome: "none", deadline: null, reason: "recovery-point-expired" }),
      entry({ naturalKey: "namedLocation:x", mechanism: "recreate", idOutcome: "new", deadline: null }),
    ],
  }));
  assert.match(html, /Same ID kept/);
  assert.match(html, /New ID assigned/);
  assert.match(html, /recovery-point-expired/);
  assert.match(html, /mechanism-row mechanism-refused/);
});

test("an artifact with no mechanisms (legacy) renders nothing", () => {
  assert.equal(renderToStaticMarkup(createElement(RecoveryMechanismTable, { mechanisms: [] })), "");
});
