import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { ScheduleEditor } from "@/components/schedule-editor";
import { localTimeToUTC, utcTimeToLocal } from "../../engine/schedules/timeOfDay.mjs";
import type { Schedule } from "@/lib/schedules";

interface Element { type: unknown; props: Record<string, unknown> }
function find(node: unknown, predicate: (element: Element) => boolean): Element | undefined {
  if (Array.isArray(node)) {
    for (const child of node) { const found = find(child, predicate); if (found) return found; }
  }
  if (!node || typeof node !== "object") return;
  const element = node as Element;
  return element.props && (predicate(element) ? element : find(element.props.children, predicate));
}

// Exercise real form handlers with the same hook harness used by remediation controls.
test("cadence editor converts browser time, saves builder and raw cron, and preserves server refusals", async () => {
  const internals = (React as unknown as {
    __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown };
  }).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const originalDispatcher = internals.H;
  const originalFetch = globalThis.fetch;
  const originalTZ = process.env.TZ;
  process.env.TZ = "America/New_York";
  const states: unknown[] = [];
  let hook = 0;
  let refreshes = 0;
  internals.H = {
    useContext() { return { parentCacheNode: { bfcacheId: 0 }, refresh() { refreshes++; } }; },
    useMemo<T>(compute: () => T) { return compute(); },
    useState<T>(initial: T) {
      const index = hook++;
      if (!(index in states)) states[index] = initial;
      return [states[index], (next: T) => { states[index] = next; }];
    },
  };
  const schedule: Schedule = {
    id: "00000000-0000-0000-0000-000000000044", job_kind: "collect", tier: "tier1",
    cadence: { every: "day", n: 1, atTime: "05:00" }, cron_override: null,
    enabled: true, next_due_at: "2026-09-30T05:00:00Z", last_job_id: null,
    last_run_at: null, last_status: null, last_error: null,
  };
  const render = () => { hook = 0; return ScheduleEditor({ schedule }); };
  const element = (predicate: (e: Element) => boolean) => {
    const found = find(render(), predicate);
    assert.ok(found);
    return found;
  };
  const change = (predicate: (e: Element) => boolean, target: { value?: string; checked?: boolean }) =>
    (element(predicate).props.onChange as (e: unknown) => void)({ target });
  const open = () => (element((e) => e.type === "button" && e.props["aria-controls"] !== undefined).props.onClick as () => void)();
  const submit = () => (element((e) => e.type === "form").props.onSubmit as (e: unknown) => Promise<void>)({ preventDefault() {} });
  const calls: { path: string; method: string | undefined; body: Record<string, unknown> }[] = [];
  let refuse = false;
  globalThis.fetch = async (path, init) => {
    calls.push({ path: String(path), method: init?.method, body: JSON.parse(String(init?.body)) });
    return Response.json(refuse ? { error: "schedule_minimum_interval: collect requires at least 15 minutes" } : { schedule }, { status: refuse ? 400 : 200 });
  };
  try {
    assert.equal(find(render(), (e) => e.type === "form"), undefined);
    open();
    assert.equal(element((e) => e.props.type === "time").props.value, utcTimeToLocal("05:00"));
    assert.equal(find(render(), (e) => e.props["aria-describedby"] !== undefined), undefined, "raw cron is hidden by default");
    change((e) => e.props.type === "number", { value: "4" });
    change((e) => e.type === "select", { value: "week" });
    change((e) => e.props.type === "time", { value: "21:30" });
    change((e) => e.props.type === "checkbox" && e.props.checked === true, { checked: false });
    await submit();
    assert.deepEqual(calls.at(-1), { path: "/api/schedules", method: "POST", body: {
      id: schedule.id, cadence: { every: "week", n: 4, atTime: localTimeToUTC("21:30") }, cron_override: null, enabled: false,
    } });
    assert.equal(refreshes, 1);
    assert.ok(find(render(), (e) => e.props.role === "status"));
    assert.equal(find(render(), (e) => e.type === "form"), undefined);
    open();
    change((e) => e.props.type === "checkbox" && e.props.checked === false, { checked: true });
    assert.equal(find(render(), (e) => e.props.type === "number"), undefined);
    change((e) => e.props["aria-describedby"] !== undefined, { value: " 0,5 * * * * " });
    refuse = true;
    await submit();
    assert.equal(calls.at(-1)?.body.cron_override, "0,5 * * * *");
    assert.equal(element((e) => e.props.role === "alert").props.children, "schedule_minimum_interval: collect requires at least 15 minutes");
    assert.equal(refreshes, 1);
    refuse = false;
    change((e) => e.props["aria-describedby"] !== undefined, { value: "0 */4 * * *" });
    await submit();
    assert.equal(calls.at(-1)?.body.cron_override, "0 */4 * * *");
    assert.deepEqual(calls.at(-1)?.body.cadence, schedule.cadence, "unchanged time preserves stored UTC");
    schedule.cron_override = "0 */4 * * *";
    open();
    assert.equal(element((e) => e.props["aria-describedby"] !== undefined).props.value, schedule.cron_override);
    // Toggle back to the structured builder and clear the optional time.
    const label = element((e) => e.type === "label" && Array.isArray(e.props.children) && e.props.children.includes(" Use a custom timetable (cron expression)"));
    const toggle = find(label, (e) => e.props.type === "checkbox")!;
    (toggle.props.onChange as (e: unknown) => void)({ target: { checked: false } });
    change((e) => e.props.type === "time", { value: "" });
    await submit();
    assert.equal(calls.at(-1)?.body.cron_override, null);
    assert.equal((calls.at(-1)?.body.cadence as Schedule["cadence"]).atTime, null);
    // Explicit winter/summer and midnight rollover controls for the shared helpers.
    assert.equal(localTimeToUTC("21:30", new Date("2026-01-15T12:00:00Z")), "02:30");
    assert.equal(localTimeToUTC("21:30", new Date("2026-07-15T12:00:00Z")), "01:30");
    assert.equal(utcTimeToLocal("02:30", new Date("2026-01-15T12:00:00Z")), "21:30");
  } finally {
    internals.H = originalDispatcher;
    globalThis.fetch = originalFetch;
    if (originalTZ === undefined) delete process.env.TZ; else process.env.TZ = originalTZ;
  }
});
