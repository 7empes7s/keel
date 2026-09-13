import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { DriftTable } from "@/components/drift-table";

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
test("drift remediation previews before confirming, blocks refusals, and invalidates changed selections", async () => {
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
  const render = () => {
    hook = 0;
    return DriftTable({ capabilities: ["read", "remediate"], items: ["one", "two"].map((id) => ({
      id, naturalKey: `group:${id}`, resourceType: "group", changeType: "modified",
      blastRadius: "access-affecting", detectedAt: "2026-09-13T00:00:00Z", before: {}, after: {},
    })) });
  };
  const button = (label: string) => find(render(), (element) => element.type === "button" && element.props.children === label);
  const click = (label: string) => {
    const element = button(label);
    assert.ok(element, `missing ${label}`);
    (element.props.onClick as () => void)();
  };
  const select = (id: string) => {
    const element = find(render(), (element) => element.props["aria-label"] === `Select group:${id}`);
    assert.ok(element);
    (element.props.onChange as () => void)();
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
    select("one");
    assert.equal(button("Confirm and request approval"), undefined);
    click("Preview remediation");
    await settle();
    assert.deepEqual(calls, [{ path: "/api/actions/remediate/selection", body: { driftIds: ["one"] } }]);
    assert.equal(button("Confirm and request approval")?.props.disabled, true);
    click("Confirm and request approval");
    assert.equal(calls.length, 1, "a refused preview cannot submit even through its handler");
    select("two");
    assert.equal(button("Confirm and request approval"), undefined, "changing selection invalidates the preview");
    select("two");
    refused = false;
    click("Preview remediation");
    await settle();
    assert.equal(button("Confirm and request approval")?.props.disabled, false);
    const reason = find(render(), (element) => element.props.placeholder === "Why is this disposition appropriate?");
    assert.ok(reason);
    (reason.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "reviewed" } });
    click("Confirm and request approval");
    await settle();
    assert.deepEqual(calls.at(-1), { path: "/api/actions/remediate", body: { driftIds: ["one"], justification: "reviewed" } });
    assert.equal(button("Confirm and request approval"), undefined, "confirmation consumes the preview");
  } finally {
    internals.H = originalDispatcher;
    globalThis.fetch = originalFetch;
  }
});
