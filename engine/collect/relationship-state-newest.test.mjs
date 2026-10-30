/**
 * loadRelationshipState picks only the newest set (and the newest complete
 * set) per parent and family in SQL. This checks it returns exactly what the
 * old full scan returned, on a seeded mix of outcomes, tied and missing
 * completion times, incomplete snapshots and a second tenant.
 */
import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';

import { loadRelationshipState } from './relationships.mjs';
import { createSnapshot, completeSnapshot } from '../store/db.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { schemaSql } from '../store/loadSchema.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
after(async () => { await database.cleanup(); });

const isComplete = (outcome) => outcome === 'complete' || outcome === 'complete-empty';

/** The previous implementation: read every set, reduce newest-first in JS. */
async function fullScanState(client, { tenantRef }) {
  const { rows } = await client.query(
    `SELECT s.id, s.parent_type, s.parent_source_id, s.parent_natural_key, s.family, s.edge_type, s.direction,
            s.outcome, s.completed_at, s.snapshot_id, s.graph_code, s.http_status, s.error, s.pages_completed, s.item_count,
            COALESCE((SELECT jsonb_agg(jsonb_build_object('edgeKey', e.edge_key, 'targetId', e.target_source_id, 'targetType', e.target_type,
                                                            'targetNaturalKey', e.target_natural_key, 'attributes', e.attributes)
                                       ORDER BY e.edge_key)
                        FROM relationship_edge e WHERE e.set_id = s.id AND e.tenant_ref = $1), '[]'::jsonb) AS targets
       FROM relationship_edge_set s
       JOIN snapshot sn ON sn.id = s.snapshot_id
      WHERE s.tenant_ref = $1 AND sn.tenant_ref = $1 AND sn.status = 'complete'
      ORDER BY s.completed_at DESC NULLS LAST, s.id DESC`,
    [tenantRef],
  );
  const entries = new Map();
  for (const row of rows) {
    const key = `${row.parent_type}:${row.parent_source_id}|${row.family}`;
    const existing = entries.get(key);
    const base = {
      parentType: row.parent_type, parentSourceId: row.parent_source_id, parentNaturalKey: row.parent_natural_key,
      family: row.family, edgeType: row.edge_type, direction: row.direction,
    };
    if (!existing) {
      if (isComplete(row.outcome)) {
        entries.set(key, { ...base, state: 'current', latestOutcome: row.outcome, observedAt: row.completed_at, snapshotId: row.snapshot_id, targets: row.targets, failure: null });
      } else {
        entries.set(key, {
          ...base, state: 'unknown', latestOutcome: row.outcome, observedAt: null, snapshotId: null, targets: null,
          failure: { outcome: row.outcome, graphCode: row.graph_code, httpStatus: row.http_status, error: row.error, at: row.completed_at },
        });
      }
    } else if (existing.state === 'unknown' && isComplete(row.outcome)) {
      entries.set(key, { ...existing, state: 'stale', observedAt: row.completed_at, snapshotId: row.snapshot_id, targets: row.targets });
    }
  }
  return { tenantRef, entries };
}

/** Small deterministic PRNG so the fixture is the same on every run. */
function prng(seed) {
  let x = seed >>> 0;
  return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 2 ** 32; };
}

const OUTCOMES = ['complete', 'complete-empty', 'partial', 'failed', 'unsupported'];
const FAILED_OUTCOMES = ['partial', 'failed', 'unsupported'];
const BASE = Date.UTC(2026, 0, 1, 0, 0, 0);

async function seed(client, tenantRef, rand) {
  const parents = Array.from({ length: 12 }, (_, i) => ({ type: i % 3 === 0 ? 'servicePrincipal' : 'group', id: `${tenantRef}-p${i}` }));
  const families = ['member', 'owner'];
  for (let s = 0; s < 15; s += 1) {
    const snapshotId = await createSnapshot(client, { tenantRef });
    const status = rand() < 0.15 ? 'failed' : 'complete';
    await completeSnapshot(client, { id: snapshotId, status, coverageDigest: {} });
    for (const [index, parent] of parents.entries()) {
      for (const family of families) {
        if (rand() < 0.3) continue;
        // The last two parents never get a complete read, so they stay unknown.
        const choices = index >= 10 ? FAILED_OUTCOMES : OUTCOMES;
        const outcome = choices[Math.floor(rand() * choices.length)];
        // Few distinct times so ties across snapshots happen; some are missing.
        const completedAt = rand() < 0.1 ? null : new Date(BASE + Math.floor(rand() * 6) * 60_000).toISOString();
        const { rows } = await client.query(
          `INSERT INTO relationship_edge_set
             (snapshot_id, tenant_ref, parent_type, parent_source_id, parent_natural_key, family, edge_type, direction,
              outcome, item_count, pages_completed, completed_at, http_status, graph_code, error)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'out',$8,0,1,$9,$10,$11,$12) RETURNING id`,
          [snapshotId, tenantRef, parent.type, parent.id, `${parent.type}:${parent.id}`, family, `${family}Of`,
            outcome, completedAt, isComplete(outcome) ? 200 : 403, isComplete(outcome) ? null : 'Forbidden',
            isComplete(outcome) ? null : `read ${s} failed`],
        );
        if (outcome !== 'complete') continue;
        const count = 1 + Math.floor(rand() * 3);
        for (let e = 0; e < count; e += 1) {
          const target = `u${Math.floor(rand() * 20)}`;
          await client.query(
            `INSERT INTO relationship_edge (set_id, tenant_ref, edge_key, target_source_id, target_type, target_natural_key, attributes)
             VALUES ($1,$2,$3,$4,'user',$5,$6) ON CONFLICT DO NOTHING`,
            [rows[0].id, tenantRef, target, target, rand() < 0.5 ? `user:${target}` : null, rand() < 0.3 ? { intent: 'include' } : null],
          );
        }
      }
    }
  }
}

test('newest-per-parent query returns exactly what the full scan returned', async (t) => {
  const client = await database.connect();
  t.after(async () => { await client.end(); });
  await client.query(schemaSql());
  const rand = prng(20261030);
  await seed(client, 'sha256:one', rand);
  await seed(client, 'sha256:two', rand);

  for (const tenantRef of ['sha256:one', 'sha256:two', 'sha256:none']) {
    const expected = await fullScanState(client, { tenantRef });
    const actual = await loadRelationshipState(client, { tenantRef });
    assert.deepEqual([...actual.entries.keys()], [...expected.entries.keys()], `${tenantRef}: same keys in the same order`);
    assert.deepEqual(actual, expected, `${tenantRef}: same entries`);
  }

  // The fixture must actually exercise every state, or the comparison proves little.
  const states = new Set([...(await loadRelationshipState(client, { tenantRef: 'sha256:one' })).entries.values()].map((e) => e.state));
  assert.deepEqual([...states].sort(), ['current', 'stale', 'unknown']);
});
