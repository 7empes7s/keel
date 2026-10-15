import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { grantRole } from '../engine/authz/administration.mjs';
import { completeSnapshot, connect, createSnapshot, insertResourceVersion } from '../engine/store/db.mjs';
import { schemaSql } from '../engine/store/loadSchema.mjs';
import { createIsolatedTestDatabase } from '../engine/test/dbTestHelper.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
const cliPath = new URL('./keel-compare.mjs', import.meta.url).pathname;
const run = (...args) => spawnSync('node', [cliPath, ...args, '--db-url', database.url], { encoding: 'utf8' });
const tenantRef = 'sha256:00000000000000c1';

const client = await connect(database.url);
try {
  await client.query(schemaSql());
  const { rows: [reader] } = await client.query("INSERT INTO principal(email) VALUES ('reader@keel.test') RETURNING id");
  const { rows: [nobody] } = await client.query("INSERT INTO principal(email) VALUES ('nobody@keel.test') RETURNING id");
  await grantRole(client, { principalId: reader.id, role: 'viewer', grantedBy: reader.id });

  const snapshot = async (groups) => {
    const id = await createSnapshot(client, { tenantRef });
    for (const [nickname, payload] of groups) {
      await insertResourceVersion(client, { snapshotId: id, resource: {
        naturalKey: `group:${nickname}`, resourceType: 'group', payload: { displayName: nickname, mailNickname: nickname, ...payload },
        criticality: 'tier1', blastRadius: 'access-affecting', fidelity: 'full', provenance: { adapter: 'test' },
      } });
    }
    await completeSnapshot(client, { id, status: 'complete', coverageDigest: { group: { outcome: 'complete', itemCount: groups.length } } });
    return id;
  };
  const left = await snapshot([['KEEL-RT-Kept', { securityEnabled: true }], ['KEEL-RT-Gone', {}]]);
  const right = await snapshot([['KEEL-RT-Kept', { securityEnabled: false }], ['KEEL-RT-Added', {}]]);

  // Without the read capability nothing is read.
  const refused = run('snapshots', '--left', left, '--right', right, '--principal-id', nobody.id);
  assert.equal(refused.status, 2, refused.stderr);
  assert.match(refused.stderr, /read capability/);

  const text = run('snapshots', '--left', left, '--right', right, '--principal-id', reader.id, '--only', 'settings');
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /compare snapshots: 3 differences/);
  assert.match(text.stdout, /Entra ID \/ group: 1 added, 1 removed, 1 changed/);
  assert.match(text.stdout, /securityEnabled: true -> false/);
  assert.match(text.stdout, /- KEEL-RT-Gone/);

  const json = run('snapshots', '--left', left, '--right', right, '--principal-id', reader.id, '--json');
  assert.equal(json.status, 0, json.stderr);
  const result = JSON.parse(json.stdout);
  assert.equal(result.mode, 'snapshots');
  assert.equal(result.settings.totals.changed, 1);
  assert.equal(result.content.by, 'item');

  const sources = run('sources', '--principal-id', reader.id, '--json');
  assert.equal(sources.status, 0, sources.stderr);
  assert.deepEqual(JSON.parse(sources.stdout)[0].snapshots.map((s) => s.id).sort(), [left, right].sort());

  const same = run('tenants', '--left', tenantRef, '--right', tenantRef, '--principal-id', reader.id);
  assert.equal(same.status, 1);
  assert.match(same.stderr, /two different tenants/);

  const usage = run('snapshots', '--principal-id', reader.id);
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /--left is required/);
} finally {
  await client.end();
  await database.cleanup();
}
