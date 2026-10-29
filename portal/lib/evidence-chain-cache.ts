// The audit record's verified prefix, kept for the life of the portal process and shared
// by every page that checks the chain (Overview, the menu's status poll and Activity), so
// each check hashes only the records added since the last one. The engine still re-walks
// the whole chain every few minutes and never caches a broken result
// (engine/govern/evidence.mjs verifyChainCached). Kept on globalThis so every bundle of
// the portal shares one cache.
type ChainCache = Map<string, unknown>;

export const evidenceChainCache: ChainCache = ((globalThis as { __keelEvidenceChainCache?: ChainCache }).__keelEvidenceChainCache ??= new Map());
