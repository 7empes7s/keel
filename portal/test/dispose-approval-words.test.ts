// Security audit run 2, finding 3: a decision a second person approves reads in plain
// words on the Approvals page and in Activity, with no ids.
import assert from "node:assert/strict";
import { test } from "node:test";

import { approvalKind, KIND_ORDER, KIND_WORDS } from "@/lib/approval-view";
import { displayEnum } from "@/lib/presentation";
import { approvalSentence, EMPTY_REFERENCES, jobName } from "@/lib/sentences";

const change = { readable: true, name: "Require MFA for everyone", naturalKey: "conditionalAccessPolicy:KEEL-RT-mfa", blastRadius: "tenant-lockout" };
const references = { ...EMPTY_REFERENCES, changes: [change] } as unknown as typeof EMPTY_REFERENCES;

test("a decision approval is named by what approving does", () => {
  assert.equal(
    approvalSentence({ action: "dispose", params: { driftIds: ["d1"], action: "accept", reason: "r" }, references }),
    "Accept into the approved setup: 1 change, including Require MFA for everyone",
  );
  const ignore = approvalSentence({ action: "dispose", params: { driftIds: ["d1"], action: "ignore", reason: "r", expiresAt: "2026-11-15T23:59:59.000Z" }, references });
  assert.match(ignore, /^Ignore until .+: 1 change, including Require MFA for everyone$/);
  assert.equal(
    approvalSentence({ action: "dispose", params: { serviceChangeId: "c1", action: "accept", reason: "r", tenantRef: "t" } }),
    "Accept into the approved setup: a service setting change",
  );
  assert.equal(approvalKind({ action: "dispose", references }), "decision");
  assert.ok(KIND_ORDER.includes("decision"));
  assert.equal(KIND_WORDS.decision.label, "Change decision");
});

test("the dispose job has a plain name", () => {
  assert.equal(displayEnum("jobKind", "dispose"), "Decision on a sign-in or admin change");
  assert.equal(
    jobName({ kind: "dispose", params: { driftIds: ["d1"], action: "accept" }, references } as Parameters<typeof jobName>[0]),
    "Accept into the approved setup: 1 change, including Require MFA for everyone",
  );
});
