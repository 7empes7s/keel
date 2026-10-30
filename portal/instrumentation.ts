// Runs once when the portal server starts. The audit-record check's full walk runs on a
// background timer here, so no page load waits on it (lib/evidence-chain-refresh.ts).
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startEvidenceChainRefresh } = await import("@/lib/evidence-chain-refresh");
  startEvidenceChainRefresh();
}
