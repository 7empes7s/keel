import assert from "node:assert/strict";
import { test } from "node:test";

import { loadMenuData, MENU_DATA_KEY, MENU_RETRY_MS, menuDataOf, menuRetryDelay, saveMenuData } from "@/lib/menu-data";
import { singleFlight } from "@/lib/single-flight";
import type { DashboardData } from "@/lib/types";

// Audit 2026-10-31: the menu's badges vanished on some page loads. One busy answer
// (HTTP 503) from /api/dashboard left the menu bare until the next minute's poll, and
// every full page load started bare. These pin the retry, the kept copy and the shared read.

test("a failed menu read is retried within seconds, then left to the regular poll", () => {
  assert.deepEqual([1, 2, 3, 4].map((attempt) => menuRetryDelay(attempt)), [...MENU_RETRY_MS]);
  assert.ok(MENU_RETRY_MS[0] <= 2_000);
  assert.equal(menuRetryDelay(MENU_RETRY_MS.length + 1), null);
});

test("a server's Retry-After is honoured when longer, but never past the longest wait", () => {
  assert.equal(menuRetryDelay(1, "5"), 5_000);
  assert.equal(menuRetryDelay(1, "1"), MENU_RETRY_MS[0]);
  assert.equal(menuRetryDelay(1, "600"), MENU_RETRY_MS[MENU_RETRY_MS.length - 1]);
  assert.equal(menuRetryDelay(1, "soon"), MENU_RETRY_MS[0]);
});

function memoryStore() {
  const items = new Map<string, string>();
  return { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => void items.set(key, value), items };
}

const DATA = {
  generatedAt: "2026-10-31T17:40:00Z",
  headline: { headline: "x" },
  coverage: { failed: 2, stale: 0, neverCollected: 1 },
  openDriftByBlastRadius: [],
  openDriftTotal: 3,
  evidence: { ok: true, chainLength: 4 },
  waiting: { openAlerts: 5 },
  alerts: [],
  driftTrend: [{ big: "only the Overview needs this" }],
} as unknown as DashboardData;

test("the menu keeps only what its badges read, and a reload gets it back", () => {
  const store = memoryStore();
  const kept = menuDataOf(DATA);
  assert.equal("driftTrend" in kept, false);
  saveMenuData(store, kept);
  assert.deepEqual(loadMenuData(store), kept);
});

test("missing, broken or blocked storage counts as nothing kept", () => {
  assert.equal(loadMenuData(undefined), null);
  const store = memoryStore();
  assert.equal(loadMenuData(store), null);
  store.items.set(MENU_DATA_KEY, "{not json");
  assert.equal(loadMenuData(store), null);
  store.items.set(MENU_DATA_KEY, JSON.stringify({ headline: null }));
  assert.equal(loadMenuData(store), null);
  const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("full"); } };
  assert.equal(loadMenuData(blocked), null);
  assert.doesNotThrow(() => saveMenuData(blocked, menuDataOf(DATA)));
});

test("overlapping dashboard reads share one database read; the next one is fresh", async () => {
  let reads = 0;
  let release!: (value: number) => void;
  const shared = singleFlight(() => { reads += 1; return new Promise<number>((resolve) => { release = resolve; }); });
  const first = shared();
  const second = shared();
  assert.equal(reads, 1);
  release(7);
  assert.deepEqual(await Promise.all([first, second]), [7, 7]);
  const third = shared();
  assert.equal(reads, 2);
  release(8);
  assert.equal(await third, 8);
});

test("a failed shared read fails every waiting caller, and the next one tries again", async () => {
  let reads = 0;
  const shared = singleFlight(async () => { reads += 1; if (reads === 1) throw new Error("busy"); return "ok"; });
  await assert.rejects(Promise.all([shared(), shared()]), /busy/);
  assert.equal(reads, 1);
  assert.equal(await shared(), "ok");
});

test("the dashboard route shares overlapping reads", async () => {
  const { readFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const source = readFileSync(resolve(__dirname, "../app/api/dashboard/route.ts"), "utf8");
  assert.match(source, /singleFlight\(getDashboardData\)/);
  assert.doesNotMatch(source, /dataResponse\(getDashboardData\)/);
});
