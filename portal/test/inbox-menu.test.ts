import assert from "node:assert/strict";
import { test } from "node:test";
import { type ContextType, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { Menu } from "@/components/shell/menu";
import type { ApprovalRequestRecord } from "@/lib/approval-inbox";
import { approvalCounts, approvalsVerdict, splitWaiting, viewerCanDecide } from "@/lib/approval-view";
import { renderApprovalInboxAt } from "./render-approval-inbox";

// Audit 31 Oct, items 7 and 8: Approvals and Alerts head the menu as an Inbox, and
// "waiting for you" counts only the requests the viewer can decide.

const ME = "p-me";
// Fixed relative to the run: expiry is compared with `now`.
const NOW = new Date().toISOString();
const IN_A_DAY = new Date(Date.now() + 24 * 3_600_000).toISOString();

function request(id: string, over: Partial<ApprovalRequestRecord> = {}): ApprovalRequestRecord {
  return {
    id, action: "remediate", params: { driftIds: [] }, requestedBy: "p-other", justification: null, status: "pending",
    decidedBy: null, decidedAt: null, reason: null, createdAt: NOW, expiresAt: IN_A_DAY, executor: "worker",
    requiredApprovals: 1, signoffs: [], ...over,
  };
}

const mineOwn = request("r-mine", { requestedBy: ME });
const signedByMe = request("r-signed", { requiredApprovals: 2, signoffs: [{ kind: "person", id: ME, name: "Me", readable: true }] });
const forMe = request("r-for-me");

test("the viewer cannot decide their own request or one they already signed", () => {
  assert.equal(viewerCanDecide(mineOwn, ME), false);
  assert.equal(viewerCanDecide(signedByMe, ME), false);
  assert.equal(viewerCanDecide(forMe, ME), true);
  // With no viewer known, nothing is held back.
  assert.equal(viewerCanDecide(mineOwn, null), true);
  const { forYou, onOthers } = splitWaiting([mineOwn, signedByMe, forMe], ME);
  assert.deepEqual(forYou.map((entry) => entry.id), ["r-for-me"]);
  assert.deepEqual(onOthers.map((entry) => entry.id), ["r-mine", "r-signed"]);
});

test("in Solo mode your own request waits for you; one you already signed still waits on others", () => {
  assert.equal(viewerCanDecide(mineOwn, ME, "solo"), true);
  assert.equal(viewerCanDecide(mineOwn, ME, "two-person"), false);
  assert.equal(viewerCanDecide(signedByMe, ME, "solo"), false);
  const { forYou, onOthers } = splitWaiting([mineOwn, signedByMe, forMe], ME, "solo");
  assert.deepEqual(forYou.map((entry) => entry.id), ["r-mine", "r-for-me"]);
  assert.deepEqual(onOthers.map((entry) => entry.id), ["r-signed"]);
  const counts = approvalCounts({ pending: [mineOwn, signedByMe, forMe], awaitingContentEffects: [], history: [] }, NOW, ME, "solo");
  assert.equal(counts.waiting, 2);
  assert.equal(counts.waitingOnOthers, 1);
  const onlySigned = approvalCounts({ pending: [signedByMe], awaitingContentEffects: [], history: [] }, NOW, ME, "solo");
  const verdict = approvalsVerdict(onlySigned, null, NOW, "solo");
  assert.match(verdict.detail, /you already approved it, and another approver must too/);
  assert.doesNotMatch(verdict.detail, /you asked for/);
});

test("waiting for you counts only what the viewer can decide", () => {
  const counts = approvalCounts({ pending: [mineOwn, signedByMe, forMe], awaitingContentEffects: [], history: [] }, NOW, ME);
  assert.equal(counts.waiting, 1);
  assert.equal(counts.waitingOnOthers, 2);
  const none = approvalCounts({ pending: [mineOwn], awaitingContentEffects: [], history: [] }, NOW, ME);
  const verdict = approvalsVerdict(none, null, NOW);
  assert.equal(verdict.tone, "fine");
  assert.match(verdict.text, /Nothing is waiting for your decision/);
  assert.match(verdict.detail, /1 request waits on someone else/);
});

test("Approvals splits For you and Waiting on others, and own requests have no decide buttons", async () => {
  const props = { pending: [mineOwn, forMe], history: [], now: NOW, viewerId: ME };
  const waiting = await renderApprovalInboxAt("", props);
  assert.match(waiting, /For you · 1/);
  assert.match(waiting, /Waiting on others · 1/);
  assert.match(waiting, /1 request is waiting for you/);

  const others = await renderApprovalInboxAt("show=others", props);
  assert.match(others, /These wait on another approver/);
  // A read-only list: no checkboxes to pick rows for a bulk action.
  assert.doesNotMatch(others, /type="checkbox"/);

  // A link that opens one of your own requests lands on the tab that lists it.
  const opened = await renderApprovalInboxAt("open=r-mine", props);
  assert.match(opened, /You asked for this, so someone else must decide it/);
  assert.doesNotMatch(opened, />Approve</);
  // And one you can decide opens on For you, even from a link that names the other tab.
  const yours = await renderApprovalInboxAt("show=others&open=r-for-me", props);
  assert.match(yours, />Approve</);
});

test("in Solo mode Approvals lists your own request under For you, with Approve", async () => {
  const props = { pending: [mineOwn, forMe], history: [], now: NOW, viewerId: ME, approvalMode: "solo" as const };
  const waiting = await renderApprovalInboxAt("", props);
  assert.match(waiting, /For you · 2/);
  assert.match(waiting, /Waiting on others · 0/);
  assert.match(waiting, /2 requests are waiting for you/);
  // A link to your own request opens it on For you, ready to self-approve.
  const opened = await renderApprovalInboxAt("show=others&open=r-mine", props);
  assert.match(opened, /Approval mode is Solo, so you can approve it yourself/);
  assert.match(opened, /Approve myself/);
  assert.doesNotMatch(opened, /someone else must decide it/);
  // Waiting on others, worded for Solo: the requester decides, so nothing says they never do.
  const others = await renderApprovalInboxAt("show=others", props);
  assert.match(others, /Nothing you approved is waiting on another approver/);
  assert.doesNotMatch(others, /The person who asks never decides/);
});

async function renderMenu(capabilities: { canApprove?: boolean; canRead?: boolean }, approvals: number | null, alerts: number | null): Promise<string> {
  const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime");
  const { PathnameContext, SearchParamsContext } = await import("next/dist/shared/lib/hooks-client-context.shared-runtime");
  return renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: {} as ContextType<typeof AppRouterContext> },
    createElement(PathnameContext.Provider, { value: "/" },
      createElement(SearchParamsContext.Provider, { value: new URLSearchParams() as unknown as ContextType<typeof SearchParamsContext> },
        createElement(Menu, { capabilities, statuses: {}, approvals, alerts, person: { email: "me@example.com", access: "Admin" }, theme: "system", variant: "rail" })))));
}

test("the menu opens with an Inbox group: Approvals and Alerts, with their counts", async () => {
  const html = await renderMenu({ canApprove: true, canRead: true }, 3, 197);
  const inbox = html.indexOf('data-group="inbox"');
  assert.ok(inbox > 0, "the menu has an Inbox group");
  assert.ok(inbox < html.indexOf('data-group="pinned"'), "Inbox comes before Pinned");
  assert.ok(inbox < html.indexOf('data-group="everything"'), "and before Everything");
  const group = html.slice(inbox, html.indexOf('data-group="pinned"'));
  assert.match(group, /href="\/approvals"/);
  assert.match(group, /href="\/alerts"/);
  assert.match(group, />3</);
  assert.match(group, />99\+</);
  assert.match(group, /3 requests wait for your decision/);
});

test("the Inbox shows only the pages the viewer may open", async () => {
  const readerOnly = await renderMenu({ canRead: true }, null, 4);
  assert.doesNotMatch(readerOnly, /href="\/approvals"/);
  assert.match(readerOnly, /data-group="inbox"/);
  const neither = await renderMenu({}, null, null);
  assert.doesNotMatch(neither, /data-group="inbox"/);
});
