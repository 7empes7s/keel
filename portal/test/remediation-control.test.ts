import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { ChangeDecision } from "@/components/baselines/change-decision";
import type { DriftRecord } from "@/lib/types";

interface Element { type: unknown; props: Record<string, unknown> }
function find(node: unknown, predicate: (element: Element) => boolean): Element | undefined {
  if (Array.isArray(node)) {
    for (const child of node) { const match = find(child, predicate); if (match) return match; }
  }
  if (!node || typeof node !== "object") return;
  const element = node as Element;
  return element.props && (predicate(element) ? element : find(element.props.children, predicate));
}

// Same hook-dispatcher harness as action.test.ts, exercising the real component's
// event handlers and fetch bodies without adding a DOM dependency.
test("undoing changes previews before confirming, blocks refusals, and invalidates changed selections", async () => {
  const internals = (React as unknown as {
    __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown };
  }).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const originalDispatcher = internals.H;
  const originalFetch = globalThis.fetch;
  const states: unknown[] = [];
  let hook = 0;
  internals.H = {
    useState<T>(initial: T) {
      const index = hook++;
      if (!(index in states)) states[index] = initial;
      return [states[index], (next: T | ((value: T) => T)) => {
        states[index] = typeof next === "function" ? (next as (value: T) => T)(states[index] as T) : next;
      }];
    },
    useMemo<T>(compute: () => T) { return compute(); },
  };
  // The chosen changes come from the shared list; changing the choice re-renders the
  // decision with different items.
  let chosen = ["one"];
  const done: string[] = [];
  const render = () => {
    hook = 0;
    return ChangeDecision({
      decision: "undo",
      items: chosen.map((id) => ({
        id, naturalKey: `group:${id}`, resourceType: "group", changeType: "modified",
        blastRadius: "access-affecting", detectedAt: "2026-09-13T00:00:00Z", before: {}, after: {},
      }) as unknown as DriftRecord),
      today: "2026-09-13",
      onDone: (_settled, message) => { done.push(message); },
      onCancel: () => {},
    });
  };
  const button = (label: string) => find(render(), (element) => element.type === "button" && element.props.children === label);
  const click = (label: string) => {
    const element = button(label);
    assert.ok(element, `missing ${label}`);
    (element.props.onClick as () => void)();
  };
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  let refused = true;
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    const body = JSON.parse(String(init?.body));
    calls.push({ path, body });
    return Response.json(path.endsWith("/selection") ? {
      driftIds: body.driftIds,
      resources: [{ naturalKey: "group:one", resourceType: "group", verb: "update", verbReason: "changed" }],
      waves: [["group:one"]], deletionWaves: [], patches: [],
      guardRefusals: refused ? [{ naturalKey: "group:one", reason: "synced object" }] : [],
    } : { approvalRequest: { status: "pending" } });
  };
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  try {
    assert.equal(button("Send for approval"), undefined);
    click("Check what undoing would do");
    await settle();
    assert.deepEqual(calls, [{ path: "/api/actions/remediate/selection", body: { driftIds: ["one"] } }]);
    assert.equal(button("Send for approval")?.props.disabled, true);
    // Populate a justification while the preview is refused: the guard-refusal
    // check itself — not the empty-reason gate — must block the submission.
    const refusedReason = find(render(), (element) => element.props.placeholder === "Why is this decision right?");
    assert.ok(refusedReason);
    (refusedReason.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "justified" } });
    click("Send for approval");
    assert.equal(calls.length, 1, "a refused preview cannot submit even with a justification through its handler");
    chosen = ["one", "two"];
    assert.equal(button("Send for approval"), undefined, "changing selection invalidates the preview");
    chosen = ["two"];
    refused = false;
    click("Check what undoing would do");
    await settle();
    assert.equal(button("Send for approval")?.props.disabled, false);
    const reason = find(render(), (element) => element.props.placeholder === "Why is this decision right?");
    assert.ok(reason);
    (reason.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "reviewed" } });
    click("Send for approval");
    await settle();
    assert.deepEqual(calls.at(-1), { path: "/api/actions/remediate", body: { driftIds: ["two"], justification: "reviewed" } });
    assert.equal(button("Send for approval"), undefined, "confirmation consumes the preview");
    assert.deepEqual(done, ["Sent to approvers. Nothing changes until one of them approves."]);
  } finally {
    internals.H = originalDispatcher;
    globalThis.fetch = originalFetch;
  }
});
