// Observations are measurements of this bounded run, never tenant-wide estimates.
export function auditSizing({ observedEvents, storedBytes, requests, durationMs, synthetic, costInputs = {} }) {
  for (const value of [observedEvents, storedBytes, requests, durationMs]) {
    if (!Number.isFinite(value) || value < 0) throw new Error('invalid sizing measurement');
  }
  if (typeof synthetic !== 'boolean') throw new Error('sizing requires synthetic provenance');
  for (const [key, value] of Object.entries(costInputs)) {
    if (!['perRequest', 'perGiBMonth'].includes(key) || !Number.isFinite(value) || value < 0) {
      throw new Error('invalid cost input');
    }
  }
  return { observedEvents, storedBytes, requests, durationMs, synthetic, costInputs,
    estimatedRequestCost: costInputs.perRequest === undefined ? null : requests * costInputs.perRequest,
    estimatedStorageCostPerMonth: costInputs.perGiBMonth === undefined ? null : storedBytes / 2 ** 30 * costInputs.perGiBMonth,
    storageBasis: 'new minimized event bytes only; excludes indexes, replicas and archive charges' };
}
