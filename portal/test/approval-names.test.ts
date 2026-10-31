import assert from "node:assert/strict";
import { test } from "node:test";
import { type ApprovalRequestRecord, withChangeNames } from "@/lib/approval-inbox";
import { EMPTY_REFERENCES, approvalSentence, personLabel } from "@/lib/sentences";
import { approvalTitle, approvalUnnamedRefs, distinctTitles } from "@/lib/approval-view";

import { renderApprovalInboxAt } from "./render-approval-inbox";

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

test("an undo is titled by the saved name of what it changes, never its id", () => {
  // No name yet: the kind of setting, so two such requests do not read the same.
  assert.equal(approvalSentence(rollback()), "Undo 2 changes, including an unnamed group");
  const named = withChangeNames(rollback(), {
    [GROUP]: { name: "Finance", resourceType: "group" },
    [USER]: { name: "Ada Lovelace", resourceType: "user" },
  });
  assert.equal(approvalSentence(named), "Undo 2 changes, including Finance (group)");
  assert.equal(named.references?.changes[1]?.name, "Ada Lovelace (user) as member of Finance (group)");
  // No saved name: the count and the kind, never the id.
  const unnamed = withChangeNames(rollback(), {});
  assert.equal(approvalSentence(unnamed), "Undo 2 changes, including an unnamed group");
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
  const pending = [withChangeNames(rollback(), names)];
  const history = [withChangeNames(decided, names)];
  // The waiting request opened in place, then the decided one opened in place.
  const html = (await renderApprovalInboxAt("open=req-1", { pending, history, now: "2026-10-17T10:00:00.000Z" }))
    + (await renderApprovalInboxAt("show=decided&open=req-2", { pending, history, now: "2026-10-17T10:00:00.000Z" }));
  // The shared Person piece shows the email on hover only (a title attribute), never as text.
  const visible = html.replace(/<details[\s\S]*?<\/details>/g, "").replace(/ title="[^"]*"/g, "");
  assert.match(visible, /Undo 2 changes, including Finance \(group\)/);
  assert.match(visible, /Rita Requester<\/span><\/span> asked/);
  assert.match(visible, /by Keel&#x27;s scheduler/);
  assert.match(visible, /asked by an account that no longer exists/);
  for (const raw of [GROUP, USER, REQUESTER, DRIFT, "@contoso", "by scheduler"]) assert.ok(!visible.includes(raw), `shows ${raw}`);
});

test("requests that would read the same get the moment they were asked, then a number", () => {
  const a = rollback({ id: "a", createdAt: "2026-10-30T17:41:00Z" });
  const b = rollback({ id: "b", createdAt: "2026-10-31T09:05:00Z" });
  const c = rollback({ id: "c", createdAt: "2026-10-31T09:05:00Z" });
  const other = rollback({ id: "d", createdAt: "2026-10-31T09:05:00Z", action: "baseline-activate" });
  const titles = distinctTitles([a, b, c, other]);
  assert.equal(titles.get("a"), "Undo 2 changes, including an unnamed group · asked 30 Oct 2026, 17:41 UTC");
  assert.equal(titles.get("b"), "Undo 2 changes, including an unnamed group · asked 31 Oct 2026, 09:05 UTC (1)");
  assert.equal(titles.get("c"), "Undo 2 changes, including an unnamed group · asked 31 Oct 2026, 09:05 UTC (2)");
  assert.equal(titles.get("d"), approvalTitle(other));
  assert.equal(new Set(titles.values()).size, 4);
});

const GHOST = "6a0b0000-0000-4000-8000-0000000000c9";
const GHOST_LOOKUP = `https://developer.microsoft.com/en-us/graph/graph-explorer?request=directoryObjects%2F${GHOST}&method=GET&version=v1.0&GraphUrl=https://graph.microsoft.com`;
const GHOST_REF = { id: GHOST, what: "Who holds the role", lookup: GHOST_LOOKUP };

test("an unnamed change keeps the ids no backup names, with a lookup link each", () => {
  const assignment = rollback({
    references: {
      ...rollback().references!,
      changes: [{ kind: "change", id: DRIFT, name: null, readable: true, naturalKey: `roleAssignment:${GHOST}`, resourceType: "roleAssignment" }],
    },
  });
  const named = withChangeNames(assignment, { [`roleAssignment:${GHOST}`]: { name: null, resourceType: "roleAssignment", unnamedRefs: [GHOST_REF] } });
  assert.deepEqual(named.references?.changes[0]?.unnamedRefs, [GHOST_REF]);
  assert.equal(named.references?.changes[0]?.name, null, "it stays unnamed in words");
  // The same id from the preview and the change is listed once.
  const both = { ...named, preview: { total: 1, services: [], more: 0, changes: [{ name: "Unnamed role assignment", kind: "Role assignments", line: null, fields: [], moreFields: 0, unnamedRefs: [GHOST_REF] }] } };
  assert.deepEqual(approvalUnnamedRefs(both), [GHOST_REF]);
  assert.deepEqual(approvalUnnamedRefs(rollback()), []);
});

test("Approvals lists each unnamed id with its lookup link under Technical details only", async () => {
  const request = rollback({
    references: {
      ...rollback().references!,
      changes: [{ kind: "change", id: DRIFT, name: null, readable: true, naturalKey: `roleAssignment:${GHOST}`, resourceType: "roleAssignment", unnamedRefs: [GHOST_REF] }],
    },
  });
  const html = await renderApprovalInboxAt("open=req-1", { pending: [request], history: [], now: "2026-10-17T10:00:00.000Z" });
  const details = [...html.matchAll(/<details[\s\S]*?<\/details>/g)].map((match) => match[0]).join("");
  assert.ok(details.includes(GHOST), "the id is in Technical details");
  assert.ok(details.includes(GHOST_LOOKUP.replaceAll("&", "&amp;")), "with its lookup link");
  assert.match(details, /Who holds the role: not named by any backup|Who holds the role \(no name in any backup\)/);
  const visible = html.replace(/<details[\s\S]*?<\/details>/g, "").replace(/ title="[^"]*"/g, "");
  assert.ok(!visible.includes(GHOST), "never outside Technical details");
});
