// The audit record's verified prefix, kept for the life of the portal process and shared
// by every page that checks the chain (Overview, the menu's status poll and Activity), so
// each check hashes only the records added since the last one. The periodic full walk of
// the whole chain runs on a background timer (lib/evidence-chain-refresh.ts), and a
// broken result is never cached (engine/govern/evidence.mjs verifyChainCached). Kept on globalThis so every bundle of
// the portal shares one cache.
type ChainCache = Map<string, unknown>;

export const evidenceChainCache: ChainCache = ((globalThis as { __keelEvidenceChainCache?: ChainCache }).__keelEvidenceChainCache ??= new Map());
