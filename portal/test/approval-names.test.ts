import assert from "node:assert/strict";
import { test } from "node:test";
import { type ContextType, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ApprovalInbox } from "@/components/approval-inbox";
import { type ApprovalRequestRecord, withChangeNames } from "@/lib/approval-inbox";
import { EMPTY_REFERENCES, approvalSentence, personLabel } from "@/lib/sentences";

// The approval inbox names what a request changes and who asked or decided, never by
// an object id, an account id, an email or a system code.

const GROUP = "0f5e1c2a-1b2c-4d3e-8f4a-5b6c7d8e9f00";
const USER = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const REQUESTER = "aaaaaaaa-0000-4000-8000-000000000001";
const DECIDER = "aaaaaaaa-0000-4000-8000-000000000002";
const DRIFT = "bbbbbbbb-0000-4000-8000-000000000001";

function rollback(overrides: Partial<ApprovalRequestRecord> = {}): ApprovalRequestRecord {
  return {
    id: "req-1", action: "remediate", params: { driftIds: [DRIFT] }, requestedBy: REQUESTER, justification: null,
    status: "pending", decidedBy: null, decidedAt: null, reason: null, createdAt: null, expiresAt: null,
    references: {
      ...EMPTY_REFERENCES,
      people: {
        requested_by: { kind: "person", id: REQUESTER, name: "rita.requester@contoso.test", email: "rita.requester@contoso.test", readable: true, system: false },
      },
      changes: [
        { kind: "change", id: DRIFT, name: null, readable: true, naturalKey: GROUP, resourceType: "group" },
        { kind: "change", id: "c2", name: null, readable: true, naturalKey: `${GROUP}|member|${USER}`, resourceType: "groupMembership" },
      ],
    },
    ...overrides,
  };
}

test("a roll-back is titled by the saved name of what it changes, never its id", () => {
  assert.equal(approvalSentence(rollback()), "Roll back 2 changes");
  const named = withChangeNames(rollback(), {
    [GROUP]: { name: "Finance", resourceType: "group" },
    [USER]: { name: "Ada Lovelace", resourceType: "user" },
  });
  assert.equal(approvalSentence(named), "Roll back 2 changes, including Finance (group)");
  assert.equal(named.references?.changes[1]?.name, "Ada Lovelace (user) as member of Finance (group)");
  // No saved name: the count only, never the id.
  const unnamed = withChangeNames(rollback(), {});
  assert.equal(approvalSentence(unnamed), "Roll back 2 changes");
});

test("people are named, never by email, account id or system code", () => {
  const person = { kind: "person", id: REQUESTER, readable: true };
  assert.equal(personLabel({ ...person, name: "Rita Requester", email: "rita@contoso.test" }), "Rita Requester");
  assert.equal(personLabel({ ...person, name: "rita.requester@contoso.test", email: "rita.requester@contoso.test" }), "Rita Requester");
  assert.equal(personLabel({ ...person, name: null, readable: false }), "an account that no longer exists");
  assert.equal(personLabel({ kind: "person", id: "scheduler", name: "scheduler", readable: true, system: true }), "Keel's scheduler");
  assert.equal(personLabel({ kind: "person", id: "policy-automation", name: "policy-automation", readable: true, system: true }), "Keel's policy automation");
  assert.equal(personLabel({ ...person, name: "scheduler@keel.local", email: "scheduler@keel.local", system: true }), "Keel's scheduler");
  assert.equal(personLabel(null), "an unknown person");
});

test("the inbox shows no id, email or system code outside Technical details", async () => {
  const decided = rollback({
    id: "req-2", status: "approved", decidedBy: "scheduler", decidedAt: "2026-10-17T09:00:00.000Z",
    references: {
      ...rollback().references!,
      people: {
        requested_by: { kind: "person", id: REQUESTER, name: null, readable: false },
        decided_by: { kind: "person", id: "scheduler", name: "scheduler", readable: true, system: true },
      },
    },
  });
  const names = { [GROUP]: { name: "Finance", resourceType: "group" } };
  const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime");
  const html = renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: {} as ContextType<typeof AppRouterContext> },
    createElement(ApprovalInbox, {
      pending: [withChangeNames(rollback(), names)], history: [withChangeNames(decided, names)], now: "2026-10-17T10:00:00.000Z",
    })));
  const visible = html.replace(/<details[\s\S]*?<\/details>/g, "");
  assert.match(visible, /Roll back 2 changes, including Finance \(group\)/);
  assert.match(visible, /Asked by Rita Requester/);
  assert.match(visible, /Approved by Keel&#x27;s scheduler/);
  assert.match(visible, /Asked by an account that no longer exists/);
  for (const raw of [GROUP, USER, REQUESTER, DRIFT, "@contoso", "by scheduler"]) assert.ok(!visible.includes(raw), `shows ${raw}`);
});
