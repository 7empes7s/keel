import { CHAIN_REFRESH_MS, refreshChainCache } from "../../engine/govern/evidence.mjs";
import { connect } from "@/lib/db";
import { evidenceChainCache } from "@/lib/evidence-chain-cache";
import { databaseUrl, tenantRef } from "@/lib/runtime-config";

// Keeps the shared audit-check cache warm from a timer instead of from page loads: one
// check at start (so the first pages after a restart find the records already verified)
// and one a minute after that, which does the periodic full walk before any page load
// would have to. Pages then only check the stored records are unchanged and hash new ones.
// Started once per process from instrumentation.ts; the timer never keeps the process alive.

interface RefreshState {
  timer: ReturnType<typeof setInterval>;
  running: Promise<void> | null;
  failing: boolean;
}

const globalRefresh = globalThis as { __keelEvidenceChainRefresh?: RefreshState };

export async function refreshEvidenceChainOnce(): Promise<void> {
  const ref = tenantRef();
  const client = await connect(databaseUrl());
  try {
    await refreshChainCache(client, { tenantRef: ref, cache: evidenceChainCache });
  } finally {
    await client.end();
  }
}

export function startEvidenceChainRefresh(everyMs: number = CHAIN_REFRESH_MS): void {
  if (globalRefresh.__keelEvidenceChainRefresh) return;
  const state: RefreshState = {
    running: null,
    failing: false,
    timer: setInterval(() => void tick(), everyMs),
  };
  state.timer.unref?.();
  globalRefresh.__keelEvidenceChainRefresh = state;

  function tick() {
    if (state.running) return state.running;
    state.running = refreshEvidenceChainOnce()
      .then(() => { state.failing = false; })
      .catch((error) => {
        // Logged once per failing spell; page loads still check the record themselves.
        if (!state.failing) console.error("[keel-portal] background audit check failed", error);
        state.failing = true;
      })
      .finally(() => { state.running = null; });
    return state.running;
  }
  void tick();
}

// Stops the timer and waits for a check already running, so its connection is closed.
export async function stopEvidenceChainRefresh(): Promise<void> {
  const state = globalRefresh.__keelEvidenceChainRefresh;
  if (!state) return;
  clearInterval(state.timer);
  delete globalRefresh.__keelEvidenceChainRefresh;
  await state.running;
}
