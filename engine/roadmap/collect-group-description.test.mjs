/**
 * Coverage gap B6 (live gate Q43 step 2): a changed group description was
 * invisible to drift and restore because the group $select never asked
 * Graph for it. Fixture Graph only: no tenant, no database.
 *
 * The fixture reader honours $select the way Graph does, so a field the
 * catalogue does not ask for never reaches the snapshot or the live index.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { CATALOG } from '../../tools/tenant-probe/catalog.mjs';
import { fieldClass } from '../cir/serverOwned.mjs';
import { knownFieldsFor } from '../contracts/fieldProjection.mjs';
import '../collect/entraAdapter.mjs';
import { get as adapterFor } from '../collect/registry.mjs';
import { buildReconciliationPlan } from '../reconcile/reconciliationPlan.mjs';
import { applyWave } from '../restore/applyEngine.mjs';
import { ThrottleGovernor } from '../restore/throttleGovernor.mjs';

const GROUP_ID = '11111111-1111-4111-8111-111111111111';
const BOARD = {
  id: GROUP_ID, displayName: 'Board', mailNickname: 'board', description: 'Board members',
  mailEnabled: false, securityEnabled: true, groupTypes: [], visibility: 'Private',
  // Server-owned on read, never asked for or written.
  mail: null, securityIdentifier: 'S-1-12-1-1', theme: null, classification: null,
};

const ok = (items) => ({ items, pages: 1, status: 200, capped: false, error: null });

/** A Graph that answers /groups with exactly the fields in $select. */
function fixtureGraph(groups) {
  return {
    groups,
    async collect(_version, path) {
      if (path.startsWith('/groups?')) {
        const select = new URLSearchParams(path.slice(path.indexOf('?') + 1)).get('$select');
        assert.ok(select, 'the group read carries a $select');
        const fields = select.split(',');
        return ok(this.groups.map((group) => Object.fromEntries(fields.filter((f) => f in group).map((f) => [f, group[f]]))));
      }
      if (path === '/directory/deletedItems/microsoft.graph.group') return ok([]);
      throw new Error(`unexpected collection: ${path}`);
    },
  };
}

test('a drifted group description is drift and plans a group update carrying description', async () => {
  const graph = fixtureGraph([BOARD]);
  const [snapshot] = await adapterFor('group').adapter.collect(graph, {});
  assert.equal(snapshot.description, 'Board members', 'the snapshot holds the description');

  graph.groups = [{ ...BOARD, description: 'pwned' }];
  const plan = await buildReconciliationPlan(graph, [{
    naturalKey: 'group:board', resourceType: 'group', payload: snapshot, references: [], blastRadius: 'access-affecting', restorePriority: 100,
  }]);
  const [planned] = plan.resources;
  assert.equal(planned.verb, 'update', 'the changed description is drift');
  assert.equal(planned.targetId, GROUP_ID);

  const writes = [];
  const writer = {
    write: async (_version, path, opts) => { writes.push({ path, ...opts }); return { ok: true, status: 204, body: null }; },
    read: async () => ({ ok: true, status: 200, body: { ...snapshot } }),
  };
  const governor = new ThrottleGovernor({ 'target/entra/write': { capacity: 100, refillPerSecond: 100 } });
  const result = await applyWave(writer, governor, [planned], { targetTenant: 'target', mode: 'enforce' });
  assert.deepEqual(result.failed, []);
  assert.equal(result.applied.length, 1);
  const patch = writes.find((write) => write.method === 'PATCH');
  assert.equal(patch.path, `/groups/${GROUP_ID}`);
  assert.equal(patch.body.description, 'Board members', 'the update puts the description back');
});

test('every catalogue $select asks for each writable field the type is reviewed to carry', () => {
  for (const entry of CATALOG.filter((candidate) => candidate.select)) {
    const known = knownFieldsFor(entry.type);
    if (!known) continue;
    const selected = new Set(entry.select.split(','));
    const missing = known.filter((field) => fieldClass(field, entry.type) === 'writable' && !selected.has(field));
    assert.deepEqual(missing, [], `${entry.type}: writable fields the $select never collects`);
  }
});
