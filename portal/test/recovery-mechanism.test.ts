import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { RecoveryMechanismTable, mechanismLabel, type RecoveryMechanism } from "@/components/recovery-mechanism";
import { RecoveryWindowNote, recoveryWindowWords } from "@/components/recovery-window";

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

test("issue #1076: a deleted setting says until when it can be recovered, warns from 7 days, and says when it no longer can", () => {
  const open = { deadline: "2026-10-30T09:00:00Z", daysLeft: 12, state: "open" as const };
  const closing = { deadline: "2026-10-30T09:00:00Z", daysLeft: 1, state: "closing" as const };
  const expired = { deadline: "2026-10-30T09:00:00Z", daysLeft: 0, state: "expired" as const };
  assert.equal(recoveryWindowWords(open), "Can be recovered until 30 Oct 2026, 09:00 UTC");
  assert.equal(recoveryWindowWords(closing), "Can be recovered until 30 Oct 2026, 09:00 UTC (1 day left)");
  assert.equal(recoveryWindowWords({ ...closing, daysLeft: 7 }), "Can be recovered until 30 Oct 2026, 09:00 UTC (7 days left)");
  assert.equal(recoveryWindowWords(expired), "Can no longer be recovered from the recycle bin, so KEEL recreates it");
  assert.equal(recoveryWindowWords(expired, { recreates: false }), "Can no longer be recovered from the recycle bin");

  const html = renderToStaticMarkup(createElement(RecoveryMechanismTable, {
    mechanisms: [
      entry({ window: closing }),
      entry({ naturalKey: "conditionalAccessPolicy:Require-MFA", mechanism: "refused", idOutcome: "none", window: expired }),
    ],
  }));
  assert.match(html, /class="recovery-window recovery-window-closing">Can be recovered until 30 Oct 2026, 09:00 UTC \(1 day left\)/);
  assert.match(html, /class="recovery-window recovery-window-expired">Can no longer be recovered from the recycle bin</);
  assert.equal(renderToStaticMarkup(createElement(RecoveryWindowNote, { window: null })), "");
});
