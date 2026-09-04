/** Spec §8.3 — the fix for the 6,422 CoreView failures: every gap surfaces here,
 * before any write, or the plan is refused outright. */
export function buildGapReport({ resources, unresolved }) {
  const blocking = unresolved.filter((u) => u.required);
  const optional = unresolved.filter((u) => !u.required);
  const symbolsTotal = resources.length; // simplification for M1: one symbol identity per resource
  const symbolsResolved = symbolsTotal - blocking.length - optional.length;
  const pct = symbolsTotal ? ((symbolsResolved / symbolsTotal) * 100).toFixed(1) : '100.0';

  const lines = [
    'PRE-FLIGHT — cross-tenant restore, Entra',
    `  Resources in plan                 ${resources.length}`,
    `  Symbols resolved                  ${symbolsResolved}  (${pct}%)`,
    `  Symbols unresolved (required)     ${blocking.length}  ${blocking.length ? '← BLOCKING' : ''}`,
    `  Symbols unresolved (optional)     ${optional.length}  ${optional.length ? '← will degrade' : ''}`,
  ];
  if (blocking.length) {
    lines.push('', 'BLOCKING GAPS');
    for (const b of blocking) lines.push(`  ${b.symbol}  referenced by ${b.naturalKey} (${b.field})`);
  }

  return { resourcesInPlan: resources.length, symbolsTotal, symbolsResolved,
    symbolsResolvedPct: Number(pct), blocking, optional, text: lines.join('\n') };
}


export function isPlanClean(report) {
  return report.blocking.length === 0;
}
