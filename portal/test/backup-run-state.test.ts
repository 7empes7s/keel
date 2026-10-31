import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { activeRunSentence, activeTierRuns, tierSummaries } from "@/lib/protect-view";
import type { Schedule } from "@/lib/schedules";

// UI audit B1: a tier's backup in progress shows on its card and buttons, so nobody
// presses "Back up Tier 3" twice, and the card never says only "Last run finished 5 days ago".
const NOW = new Date(Date.UTC(2026, 9, 31, 18, 0)).toISOString();
const minutesAgo = (n: number) => new Date(new Date(NOW).valueOf() - n * 60_000).toISOString();
const job = (id: string, kind: string, status: string, tier: string | null, created: number, started: number | null = null) => ({
  id, kind, status, params: tier ? { tier } : {}, createdAt: minutesAgo(created), startedAt: started === null ? null : minutesAgo(started),
});

test("each tier's queued or running backup is picked from the jobs, running first", () => {
  const runs = activeTierRuns([
    job("q-new", "backup", "queued", "tier3", 1),
    job("q-old", "backup", "queued", "tier3", 4),
    job("r1", "collect", "running", "tier1", 10, 8),
    job("q1", "backup", "queued", "tier1", 2),
    job("done", "backup", "succeeded", "tier2", 3),
    job("other", "workload-collect", "running", "tier2", 3, 3),
    job("no-tier", "backup", "queued", null, 1),
  ]);
  assert.deepEqual(Object.keys(runs).sort(), ["tier1", "tier3"]);
  assert.deepEqual(runs.tier3, { jobId: "q-old", status: "queued", since: minutesAgo(4) });
  assert.deepEqual(runs.tier1, { jobId: "r1", status: "running", since: minutesAgo(8) });
});

test("the run's line says queued or running, and never 'in the future'", () => {
  assert.equal(activeRunSentence({ jobId: "a", status: "queued", since: minutesAgo(3) }, NOW), "Queued 3 minutes ago; it starts when a worker is free.");
  assert.equal(activeRunSentence({ jobId: "a", status: "running", since: minutesAgo(1) }, NOW), "Running now, started 1 minute ago.");
  const later = new Date(new Date(NOW).valueOf() + 30_000).toISOString();
  assert.equal(activeRunSentence({ jobId: "a", status: "queued", since: later }, NOW), "Queued just now; it starts when a worker is free.");
  assert.equal(activeRunSentence({ jobId: "a", status: "queued", since: null }, NOW), "Queued; it starts when a worker is free.");
});

test("a tier card carries its run in progress next to its schedule", () => {
  const schedule: Schedule = {
    id: "s3", job_kind: "collect", tier: "tier3", cadence: { every: "week", n: 1, atTime: "02:00" }, cron_override: null, enabled: true,
    next_due_at: new Date(new Date(NOW).valueOf() + 86_400_000).toISOString(), last_job_id: "old", last_run_at: minutesAgo(5 * 24 * 60), last_status: "succeeded", last_error: null,
  };
  const run = { jobId: "q", status: "queued" as const, since: minutesAgo(2) };
  const cards = tierSummaries([schedule], NOW, { tier3: run });
  const tier3 = cards.find((card) => card.id === "tier3")!;
  assert.deepEqual(tier3.active, run);
  assert.match(tier3.last, /^Last run finished 5 days ago/);
  assert.equal(cards.find((card) => card.id === "tier1")!.active, null);
  // Without runs, the cards are as before.
  assert.equal(tierSummaries([schedule], NOW).find((card) => card.id === "tier3")!.active, null);
});

test("toasts sit above the details panel, so a backup started from it is seen", () => {
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  const sheet = readFileSync(new URL("../components/baselines/styles.tsx", import.meta.url), "utf8");
  const toaster = Number(/\.toaster \{[^}]*?z-index: (\d+)/.exec(css)?.[1]);
  const panel = Number(/\.bl-sheet-root \{[^}]*?z-index: (\d+)/.exec(sheet)?.[1]);
  const popover = Number(/body\[data-sheet-open\] \.popover-panel \{ z-index: (\d+)/.exec(css)?.[1]);
  assert.ok(toaster > panel && toaster > popover, `toaster ${toaster} must be above panel ${panel} and its popovers ${popover}`);
});

test("every Back up button turns off while its tier is queued or running", () => {
  const controls = readFileSync(new URL("../components/backup-controls.tsx", import.meta.url), "utf8");
  const coverage = readFileSync(new URL("../components/protect-coverage.tsx", import.meta.url), "utf8");
  assert.equal((controls.match(/run !== null/g) ?? []).length, 2, "the tier card button and each tier in the header menu");
  assert.equal((coverage.match(/run !== null/g) ?? []).length, 2, "the kind row's button and the details panel's button");
  assert.match(controls, /alreadyActive === true/);
});
