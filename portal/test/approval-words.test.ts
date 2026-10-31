import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ApprovalModeProvider } from "@/components/approval-mode-context";
import { decisionMessage } from "@/components/baselines/change-decision";
import { PendingSteps } from "@/components/pending-steps";
import { CompletionChecklist, type CompletionResource } from "@/components/recovery-completion";
import { approvalWords } from "@/lib/approval-words";
import { decisionWords } from "@/lib/baselines-view";
import { fixSteps } from "@/lib/compliance-view";

// Approval mode, part 3: every line that says who approves follows the tenant's mode.
// Two people says someone else approves; Solo says the person who asked may approve.

const PORTAL = fileURLToPath(new URL("..", import.meta.url));
const OTHER_PERSON = /someone else|second person|another person|other than/i;

test("Solo words never promise someone else; two-person words always do", () => {
  const solo = approvalWords("solo");
  const two = approvalWords("two-person");
  assert.equal(solo.solo, true);
  assert.equal(two.solo, false);
  for (const key of Object.keys(two) as (keyof typeof two)[]) {
    if (key === "solo") continue;
    assert.notEqual(solo[key], two[key], `${key} reads the same in both modes`);
    assert.match(String(two[key]), OTHER_PERSON, `two-person ${key} names another person`);
    assert.doesNotMatch(String(solo[key]).replace(/the person who asked/g, ""), /someone else|second person|another person|other than you/i, `solo ${key} promises another person`);
    assert.match(String(solo[key]), /Solo/, `solo ${key} says why the person who asked may approve`);
  }
});

test("an unread or unknown mode reads as two people, Keel's default", () => {
  assert.deepEqual(approvalWords(null), approvalWords("two-person"));
  assert.deepEqual(approvalWords(undefined), approvalWords("two-person"));
  assert.deepEqual(approvalWords("bogus" as never), approvalWords("two-person"));
});

test("pure helpers follow the mode", () => {
  assert.match(decisionWords("undo", 2).detail, /until someone else approves/);
  assert.match(decisionWords("undo", 2, "solo").detail, /until it is approved \(in Solo mode you can approve it yourself\)/);
  assert.match(fixSteps(), /Nothing changes until someone else approves\./);
  assert.match(fixSteps("solo"), /Approval mode is Solo, so you can approve it yourself/);
  assert.match(decisionMessage("accept", [{ sent: true }]), /was sent to a second person to approve\. Nothing changes until it is approved\./);
  assert.match(decisionMessage("accept", [{ sent: true }, { sent: true }], "solo"), /were sent for approval \(in Solo mode you can approve it yourself\)\. Nothing changes until they are approved\./);
});

test("components read the mode from the page: Solo says the person who asked may approve", () => {
  const enforcement: CompletionResource = {
    naturalKey: "conditionalAccessPolicy:KEEL-RT-Require-MFA",
    resourceType: "conditionalAccessPolicy",
    mechanism: "soft-delete-restore",
    state: "configuration-restored",
    items: [{ id: "e1", kind: "enforcement", requirement: "conditionalAccessEnabled", description: "Turn the policy back on", owner: "op", state: "pending", evidence: [], closedAt: null, reopenCount: 0 }],
  };
  const steps = [{
    naturalKey: "conditionalAccessPolicy:KEEL-RT-Require-MFA", resourceType: "conditionalAccessPolicy", step: "turn-on-conditional-access-policy",
    snapshotState: "enabled", restoredState: "enabledForReportingButNotEnforced", description: "",
  }];
  const render = (mode: "solo" | "two-person" | null) => renderToStaticMarkup(createElement(ApprovalModeProvider, { mode },
    createElement(CompletionChecklist, { resources: [enforcement], canComplete: true }),
    createElement(PendingSteps, { steps }),
  ));
  const solo = render("solo");
  assert.match(solo, /An approver approves it \(in Solo mode, that can be you\)/);
  assert.match(solo, /an approver \(in Solo mode, that can be the person who asked\) approves/);
  assert.doesNotMatch(solo, /second person|someone other than/);
  for (const html of [render("two-person"), render(null)]) {
    assert.match(html, /A second person approves it/);
    assert.match(html, /someone other than the person who asked approves/);
  }
});

// Fixed "someone else approves" wording, which is wrong in Solo mode. A line that says
// who approves takes its words from lib/approval-words.ts instead.
const FIXED_WORDING = [
  /someone else approves/i,
  /someone else(?:'|&apos;)s approval/i,
  /someone else (?:must )?approve/i,
  /a second person approv/i,
  /another person reviews/i,
  /waits? for a second person|waiting for a second person/i,
  /sent to a second person/i,
  /someone other than (?:you|the person who asked) approves/i,
  /someone else asked for/i,
  /(?:by|until) someone other than the person who asked/i,
];

// Lines that name the Two people mode on purpose, each shown only in that mode.
const ALLOWED = [
  // lib/approval-view.ts: the inbox verdict, in its two-person branch.
  "Nothing changes until someone other than the person who asked approves.",
  // lib/approval-mode.ts: describes the mode.
  "\"two-person\": a second person approves, never the one who asked.",
  // lib/content-effect-review.ts: shown only when the viewer may not approve their own (two people).
  "You asked for this restore, so someone else must approve its content changes.",
  // components/approval-mode-card.tsx: the Two people option, beside the Solo one.
  "Someone other than the person who asked approves restores, undos, accepted changes and emergency changes.",
  // lib/sentences.ts: the activity record of a switch to Two people.
  "switched approval mode to Two people, so someone other than the person who asked approves",
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

test("no portal page fixes the wording to 'someone else approves'", () => {
  const found: string[] = [];
  for (const dir of ["app", "components", "lib"]) {
    for (const file of sourceFiles(join(PORTAL, dir))) {
      const name = relative(PORTAL, file);
      if (name === join("lib", "approval-words.ts")) continue;
      let text = readFileSync(file, "utf8");
      for (const line of ALLOWED) text = text.split(line).join("");
      text.split("\n").forEach((line, index) => {
        if (FIXED_WORDING.some((pattern) => pattern.test(line))) found.push(`${name}:${index + 1}: ${line.trim()}`);
      });
    }
  }
  assert.deepEqual(found, [], "use approvalWords / useApprovalWords from lib/approval-words.ts for who approves");
});
