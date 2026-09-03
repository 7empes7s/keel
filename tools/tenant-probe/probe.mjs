#!/usr/bin/env node
/**
 * KEEL tenant probe — spec §19.1 empirical enumeration.
 *
 * Replaces the documentation-derived coverage estimates in the design spec with
 * measured values from a real tenant: object counts per resource type, which
 * types are actually reachable with the granted scopes, observed throttling,
 * and — the decisive number — what fraction of inter-object references can be
 * resolved to tenant-independent natural keys.
 *
 * Read-only by construction. See graph.mjs.
 *
 *   node probe.mjs [--config /etc/keel/tenant.json] [--out /opt/keel/out]
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getToken, decodeRoles } from './auth.mjs';
import { GraphReader } from './graph.mjs';
import { CATALOG } from './catalog.mjs';
import { analyseReferences, naturalKey } from './references.mjs';
import { renderReport } from './report.mjs';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}

const CONFIG_PATH = arg('config', '/etc/keel/tenant.json');
const OUT_DIR = arg('out', '/opt/keel/out');

async function main() {
  const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  const { tenantId, clientId, certPath, keyPath } = config;

  console.log(`KEEL tenant probe — read-only enumeration`);
  console.log(`tenant : ${tenantId}`);
  console.log(`client : ${clientId}\n`);

  let token = await getToken({ tenantId, clientId, certPath, keyPath });
  const granted = decodeRoles(token.accessToken);

  console.log(`Granted application permissions (${granted.roles.length}):`);
  for (const r of granted.roles) console.log(`  · ${r}`);
  if (granted.roles.length === 0) {
    console.log('  (none — admin consent has not been granted; every read will 403)');
  }
  const writeScopes = granted.roles.filter((r) => !/\.Read(\.|$)/.test(r) && !r.endsWith('.Read.All'));
  if (writeScopes.length) {
    console.log(`\n  NOTE: this identity holds ${writeScopes.length} non-read scope(s).`);
    console.log('  The probe cannot use them — it issues GETs only — but the collector');
    console.log('  identity should not hold them in the shipped product.');
  }
  console.log('');

  const reader = new GraphReader(async () => {
    if (Date.now() > token.expiresAt - 120_000) {
      token = await getToken({ tenantId, clientId, certPath, keyPath });
    }
    return token.accessToken;
  });

  // certificateBasedAuthConfiguration hangs off the org object.
  const orgRes = await reader.get('v1.0', '/organization');
  const orgId = orgRes.ok ? orgRes.body?.value?.[0]?.id : null;

  const results = [];
  const collected = new Map();
  const startedAt = Date.now();

  for (const entry of CATALOG) {
    if (entry.needsOrgId && !orgId) {
      results.push({ ...entry, status: 'skipped', reason: 'organization id unavailable', count: 0 });
      continue;
    }
    const path = entry.needsOrgId ? entry.path.replace('{org}', orgId) : entry.path;

    process.stdout.write(`  ${entry.type.padEnd(42)}`);
    const t0 = Date.now();

    // True total, independent of any page cap.
    let declaredTotal = null;
    if (entry.pageCap) {
      const countRes = await reader.get(
        entry.version,
        `${path}?$count=true&$top=1&$select=id`,
        { consistencyLevel: true },
      );
      if (countRes.ok) declaredTotal = countRes.body?.['@odata.count'] ?? null;
    }

    const query = entry.select ? `${path}?$select=${entry.select}&$top=999` : path;
    const { items, pages, capped, error } = await reader.collect(entry.version, query, {
      pageCap: entry.pageCap ?? Infinity,
    });
    const elapsed = Date.now() - t0;

    if (error) {
      results.push({
        ...entry,
        status: error.status === 403 ? 'forbidden' : 'error',
        reason: `${error.code ?? error.status}: ${error.error}`,
        count: 0,
        elapsed,
      });
      console.log(`  ✗ ${error.status} ${error.code ?? ''}`);
      continue;
    }

    collected.set(entry.type, items);
    const total = declaredTotal ?? items.length;
    results.push({
      ...entry,
      status: 'ok',
      count: items.length,
      declaredTotal: total,
      pages,
      capped,
      elapsed,
    });
    console.log(
      `  ✓ ${String(total).padStart(6)}${capped ? ` (sampled ${items.length})` : ''}  ${elapsed}ms`,
    );
  }

  const wallClockMs = Date.now() - startedAt;
  console.log(`\nAnalysing references…`);
  const references = analyseReferences(collected);

  // AD-sync guard: synced principals cannot be restored cloud-side.
  const users = collected.get('user') ?? [];
  const groups = collected.get('group') ?? [];
  const syncSignal = {
    usersSampled: users.length,
    usersSynced: users.filter((u) => u.onPremisesSyncEnabled).length,
    groupsSampled: groups.length,
    groupsSynced: groups.filter((g) => g.onPremisesSyncEnabled).length,
    dynamicGroups: groups.filter((g) => g.membershipRule).length,
    roleAssignableGroups: groups.filter((g) => g.isAssignableToRole).length,
  };

  const report = {
    generatedAt: new Date().toISOString(),
    tenantId,
    grantedRoles: granted.roles,
    wallClockMs,
    graphStats: reader.stats,
    results,
    references,
    syncSignal,
    naturalKeySamples: [...collected]
      .filter(([, v]) => v.length)
      .slice(0, 8)
      .map(([type, v]) => ({ type, sample: naturalKey(type, v[0]) })),
  };

  mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  writeFileSync(join(OUT_DIR, `probe-${stamp}.json`), JSON.stringify(report, null, 2));
  const md = renderReport(report);
  writeFileSync(join(OUT_DIR, `probe-${stamp}.md`), md);
  writeFileSync(join(OUT_DIR, 'latest.md'), md);

  console.log(md);
  console.log(`\nWritten to ${OUT_DIR}/probe-${stamp}.{json,md}`);
}

main().catch((err) => {
  console.error(`\nFAILED: ${err.message}`);
  process.exit(1);
});
