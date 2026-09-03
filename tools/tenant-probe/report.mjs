/**
 * Markdown rendering of a probe run.
 *
 * The coverage table is generated from what the probe actually observed, never
 * from the catalog's declarations — a resource type is "reachable" only if a
 * real request returned it. This is the same discipline spec §19.2 requires of
 * the product's own coverage report.
 */

const pct = (n, d) => (d === 0 ? '—' : `${((n / d) * 100).toFixed(1)}%`);

export function renderReport(r) {
  const ok = r.results.filter((x) => x.status === 'ok');
  const forbidden = r.results.filter((x) => x.status === 'forbidden');
  const errored = r.results.filter((x) => x.status === 'error');
  const populated = ok.filter((x) => (x.declaredTotal ?? x.count) > 0);
  const totalObjects = ok.reduce((s, x) => s + (x.declaredTotal ?? x.count), 0);

  const lines = [];
  const push = (s = '') => lines.push(s);

  push(`# KEEL tenant probe`);
  push();
  push(`Generated ${r.generatedAt} · tenant \`${r.tenantId}\``);
  push();

  push(`## Summary`);
  push();
  push(`| Metric | Value |`);
  push(`|---|---|`);
  push(`| Resource types attempted | ${r.results.length} |`);
  push(`| Reachable | ${ok.length} (${pct(ok.length, r.results.length)}) |`);
  push(`| Reachable and populated | ${populated.length} |`);
  push(`| Forbidden (missing consent) | ${forbidden.length} |`);
  push(`| Errored | ${errored.length} |`);
  push(`| Objects enumerated | ${totalObjects.toLocaleString()} |`);
  push(`| Graph requests | ${r.graphStats.requests} |`);
  push(`| Throttled (429/503) | ${r.graphStats.throttled} |`);
  push(`| Time spent waiting on throttle | ${(r.graphStats.totalWaitMs / 1000).toFixed(1)}s |`);
  push(`| Wall clock | ${(r.wallClockMs / 1000).toFixed(1)}s |`);
  push();

  push(`## Reference resolvability`);
  push();
  push(`The decisive measurement for cross-tenant restore. Only the last row is a`);
  push(`risk: everything above it either re-points to a natural key, is a Microsoft`);
  push(`constant identical in every tenant, or belongs to a foreign tenant and is`);
  push(`correct to preserve verbatim.`);
  push();
  const ref = r.references;
  push(`| Class | Count | Share | Restores cross-tenant? |`);
  push(`|---|---:|---:|---|`);
  push(`| Resolvable to a natural key | ${ref.resolvable} | ${pct(ref.resolvable, ref.totalReferences)} | yes, remapped |`);
  push(`| Microsoft-global constant | ${ref.globalConstant} | ${pct(ref.globalConstant, ref.totalReferences)} | yes, verbatim |`);
  push(`| Foreign tenant identifier | ${ref.foreignTenant} | ${pct(ref.foreignTenant, ref.totalReferences)} | yes, verbatim |`);
  push(`| Server-assigned, not writable | ${ref.readOnly} | ${pct(ref.readOnly, ref.totalReferences)} | n/a, cannot be set |`);
  push(`| **Unresolvable** | **${ref.unresolvable}** | **${pct(ref.unresolvable, ref.totalReferences)}** | **no** |`);
  push(`| Total references | ${ref.totalReferences} | | |`);
  push();
  push(`Excluded before classification: ${ref.identity.toLocaleString()} identity fields`);
  push(`(an object's own ids, and ids of elements it owns) and ${ref.nonReference} GUID-shaped`);
  push(`values in name fields, which are not references at all.`);
  push();
  push(`Resolution targets indexed: ${ref.indexedTargets.toLocaleString()} — ` +
    Object.entries(ref.indexedByKind).map(([k, v]) => `${v} ${k}`).join(', ') + '.');
  push();
  if (Object.keys(ref.resolvableByKind).length) {
    push(`Resolved by kind: ` +
      Object.entries(ref.resolvableByKind)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k} ${v}`)
        .join(', ') + '.');
    push();
  }

  const problem = Object.entries(ref.byType)
    .filter(([, v]) => v.unresolvable > 0)
    .sort((a, b) => b[1].unresolvable - a[1].unresolvable);

  if (problem.length) {
    push(`### Types carrying unresolvable references`);
    push();
    push(`| Type | Refs | Unresolvable | Worst field |`);
    push(`|---|---:|---:|---|`);
    for (const [type, v] of problem.slice(0, 20)) {
      const worst = Object.entries(v.unresolvedFields).sort((a, b) => b[1] - a[1])[0];
      push(`| \`${type}\` | ${v.total} | ${v.unresolvable} (${pct(v.unresolvable, v.total)}) | \`${worst?.[0] ?? '—'}\` |`);
    }
    push();
    push(`### Unresolved samples`);
    push();
    for (const s of ref.unresolvedSamples.slice(0, 15)) {
      push(`- \`${s.type}\` · \`${s.field}\` → \`${s.guid}\``);
    }
    push();
  } else {
    push(`No unresolvable references found in the enumerated set.`);
    push();
  }

  push(`## On-premises sync signal`);
  push();
  push(`Synced objects are mastered in Active Directory. Restoring them cloud-side`);
  push(`is wrong by construction — the guard in spec §9.4 depends on this field.`);
  push();
  push(`| Signal | Value |`);
  push(`|---|---:|`);
  push(`| Users sampled | ${r.syncSignal.usersSampled} |`);
  push(`| — of which AD-synced | ${r.syncSignal.usersSynced} (${pct(r.syncSignal.usersSynced, r.syncSignal.usersSampled)}) |`);
  push(`| Groups sampled | ${r.syncSignal.groupsSampled} |`);
  push(`| — of which AD-synced | ${r.syncSignal.groupsSynced} (${pct(r.syncSignal.groupsSynced, r.syncSignal.groupsSampled)}) |`);
  push(`| — dynamic membership | ${r.syncSignal.dynamicGroups} |`);
  push(`| — role-assignable | ${r.syncSignal.roleAssignableGroups} |`);
  push();

  push(`## Inventory`);
  push();
  push(`| Type | Objects | Tier | Blast radius | ms |`);
  push(`|---|---:|---|---|---:|`);
  for (const x of [...ok].sort((a, b) => (b.declaredTotal ?? b.count) - (a.declaredTotal ?? a.count))) {
    const n = x.declaredTotal ?? x.count;
    push(`| \`${x.type}\` | ${n.toLocaleString()}${x.capped ? '*' : ''} | ${x.criticality} | ${x.blastRadius} | ${x.elapsed} |`);
  }
  push();
  push(`\\* page-capped; count is the true total, payload analysis used a sample.`);
  push();

  if (forbidden.length || errored.length) {
    push(`## Not reachable`);
    push();
    push(`| Type | Status | Reason |`);
    push(`|---|---|---|`);
    for (const x of [...forbidden, ...errored]) {
      push(`| \`${x.type}\` | ${x.status} | ${x.reason} |`);
    }
    push();
  }

  if (r.graphStats.throttled > 0) {
    push(`## Throttling observed`);
    push();
    const ra = r.graphStats.retryAfterSeconds;
    push(`- ${r.graphStats.throttled} throttled responses across ${r.graphStats.requests} requests (${pct(r.graphStats.throttled, r.graphStats.requests)})`);
    push(`- Retry-After values: min ${Math.min(...ra)}s, max ${Math.max(...ra)}s`);
    push(`- Effective read rate: ${(r.graphStats.requests / (r.wallClockMs / 1000)).toFixed(2)} req/s`);
    push();
  } else {
    push(`## Throttling observed`);
    push();
    push(`None. ${r.graphStats.requests} requests at ${(r.graphStats.requests / (r.wallClockMs / 1000)).toFixed(2)} req/s stayed under the read ceiling.`);
    push();
  }

  push(`## Slowest requests`);
  push();
  for (const s of r.graphStats.slowest) push(`- ${s.ms}ms · \`${s.path.slice(0, 110)}\``);
  push();

  return lines.join('\n');
}
