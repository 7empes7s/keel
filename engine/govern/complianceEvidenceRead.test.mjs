/** Compliance findings read each backup's coverage only for the kinds an evaluation was
 * checked on (backlog B11: Compliance, Changes and Approved setup took 12–26 s live, and
 * this read loaded every kind of every backup ever taken). The evidence links must stay
 * exactly what they were: the backup whose read covered the evaluation's window.
 */
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { after, test } from 'node:test';

import { evaluateControl, recordEvaluation } from '../benchmarks/evaluate.mjs';
import { DESCRIPTORS } from '../collect/descriptors.mjs';
import { readObservation } from '../contracts/observation.mjs';
import { complianceFindings } from './baselineCompliance.mjs';
import { schemaSql } from '../store/loadSchema.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
after(async () => { await database.cleanup(); });

const ROLE_CONTROL = 'keel-custom.role-assignment.admin-count-at-most';
const GLOBAL_ADMIN = '62e90394-69f5-4237-9190-012177145e10';
const MINUTE = 60_000;

async function backup(client, tenantRef, completedAt, digest) {
  const startedAt = new Date(completedAt.getTime() - 10 * MINUTE);
  const { rows } = await client.query(
    `INSERT INTO snapshot (tenant_ref, status, started_at, completed_at, coverage_digest)
     VALUES ($1, 'complete', $2, $3, $4) RETURNING id::text AS id`,
    [tenantRef, startedAt, completedAt, digest === undefined ? null : JSON.stringify(digest)],
  );
  return rows[0].id;
}

// Every kind read in full, each with its own window inside the backup's run.
const fullDigest = (completedAt) => Object.fromEntries(DESCRIPTORS.map(({ type }, index) => [type, {
  outcome: 'complete', itemCount: 1,
  startedAt: new Date(completedAt.getTime() - 9 * MINUTE + index).toISOString(),
  completedAt: new Date(completedAt.getTime() - MINUTE + index).toISOString(),
}]));

test('findings link to the backup that read the window, reading only the evaluated kinds', async (t) => {
  const client = await database.connect();
  t.after(async () => { await client.end(); });
  await client.query(schemaSql());
  const tenantRef = `sha256:${createHash('sha256').update('compliance-evidence-read').digest('hex').slice(0, 16)}`;
  const now = new Date();

  const reads = [];
  for (let index = 0; index < 30; index += 1) {
    reads.push(await backup(client, tenantRef, new Date(now.getTime() - (30 - index) * 60 * MINUTE), fullDigest(new Date(now.getTime() - (30 - index) * 60 * MINUTE))));
  }
  // Backups that cannot hold the evidence: no coverage, a malformed one, one that did not read the kind.
  await backup(client, tenantRef, new Date(now.getTime() - 5 * MINUTE));
  await backup(client, tenantRef, new Date(now.getTime() - 4 * MINUTE), ['roleAssignment']);
  const { roleAssignment: _skipped, ...withoutRoles } = fullDigest(new Date(now.getTime() - 3 * MINUTE));
  await backup(client, tenantRef, new Date(now.getTime() - 3 * MINUTE), withoutRoles);
  const evidenceId = reads[17];

  const { rows: [row] } = await client.query('SELECT * FROM snapshot WHERE id = $1', [evidenceId]);
  const observation = readObservation(row.coverage_digest.roleAssignment, {
    tenantRef, observationId: `${evidenceId}:roleAssignment`, resourceType: 'roleAssignment',
    snapshotWindow: { startedAt: row.started_at, endedAt: row.completed_at },
  });
  const resources = Array.from({ length: 6 }, (_, index) => ({ id: `ra-${index}`, roleDefinitionId: GLOBAL_ADMIN, principalId: `user-${index}`, directoryScopeId: '/' }));
  const result = evaluateControl({ controlId: ROLE_CONTROL, tenantRef, now: new Date(row.completed_at.getTime() + MINUTE), observations: { roleAssignment: { observation, resources } } });
  await recordEvaluation(client, { tenantRef, result, actor: 'fixture' });
  // Another tenant's backup with the same window is never a match.
  await backup(client, 'sha256:0000000000000000', new Date(row.completed_at), row.coverage_digest);

  const seen = [];
  const reader = {
    async query(...args) {
      const answer = await client.query(...args);
      if (/FROM snapshot WHERE tenant_ref = \$1 AND completed_at IS NOT NULL/.test(String(args[0]))) seen.push(answer.rows);
      return answer;
    },
  };
  const { findings } = await complianceFindings(reader, { tenantRef, now });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].links.backup.state, 'linked');
  assert.deepEqual(findings[0].links.backup.linked.map((entry) => entry.snapshotId), [evidenceId]);

  // The read is bounded: only the backups that read roleAssignment, and only that kind.
  assert.equal(seen.length, 1);
  assert.equal(seen[0].length, reads.length + 1);
  for (const backupRow of seen[0]) {
    if (backupRow.coverage_digest !== null) assert.deepEqual(Object.keys(backupRow.coverage_digest), ['roleAssignment']);
  }
  assert.ok(seen[0].every((backupRow) => backupRow.tenant_ref === tenantRef));
});

test('no evaluation on a backed-up kind reads no backups', async (t) => {
  const client = await database.connect();
  t.after(async () => { await client.end(); });
  const tenantRef = `sha256:${createHash('sha256').update('compliance-evidence-none').digest('hex').slice(0, 16)}`;
  await backup(client, tenantRef, new Date(), fullDigest(new Date()));
  const queries = [];
  const reader = { query: (...args) => { queries.push(String(args[0])); return client.query(...args); } };
  const { findings } = await complianceFindings(reader, { tenantRef, now: new Date() });
  assert.deepEqual(findings, []);
  assert.ok(!queries.some((text) => /coverage_digest/.test(text)));
});
