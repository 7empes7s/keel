// status/generate.test.mjs
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from './generate.mjs';

const dir = mkdtempSync(join(tmpdir(), 'keel-status-generate-'));
const configPath = join(dir, 'tenant.json');
writeFileSync(configPath, JSON.stringify({ tenantId: 'test-tenant' }));
const outPath = join(dir, 'index.html');

const fakeGovernance = {
  resourceCounts: { byType: [{ resourceType: 'group', count: 3 }], asOf: '2026-09-07T00:00:00Z' },
  baseline: { setAt: '2026-09-06T00:00:00Z' },
  openDrift: [{ changeType: 'modified', blastRadius: 'tier1', count: 1 }],
  lastCollection: { completedAt: '2026-09-07T00:00:00Z', status: 'complete' },
  evidence: { ok: true, chainLength: 4 },
  recentDispositions: [{ action: 'accept', count: 2 }],
};
const fakeProgress = { phases: [{ name: 'M1', total: 23, done: 23 }], recentCommits: [], testFileCount: 5 };

let dbEnded = false;
async function fakeConnect() {
  return { end: async () => { dbEnded = true; } };
}
async function okCollectGovernance() { return fakeGovernance; }
function okCollectBuildProgress() { return fakeProgress; }

// Case 1: successful run writes the file atomically, includes the timestamp, closes the client.
const result = await run({
  configPath, dbUrl: 'unused', repoDir: 'unused', outPath,
  connect: fakeConnect, collectGovernance: okCollectGovernance,
  collectBuildProgress: okCollectBuildProgress, now: () => new Date('2026-09-07T12:00:00Z'),
});
assert.equal(result.status, 'ok');
assert.ok(existsSync(outPath));
assert.ok(!existsSync(`${outPath}.tmp`), 'temp file must be renamed away, not left behind');
const html = readFileSync(outPath, 'utf8');
assert.match(html, /data as of 2026-09-07T12:00:00\.000Z/);
assert.match(html, /group/);
assert.ok(dbEnded, 'client.end() must be called on success');

// Case 2: a failing governance fetch leaves the previously published file untouched.
writeFileSync(outPath, '<html>PRIOR GOOD VERSION</html>');
async function failingCollectGovernance() { throw new Error('db unreachable'); }
dbEnded = false;
await assert.rejects(
  run({
    configPath, dbUrl: 'unused', repoDir: 'unused', outPath,
    connect: fakeConnect, collectGovernance: failingCollectGovernance,
    collectBuildProgress: okCollectBuildProgress, now: () => new Date(),
  }),
  /db unreachable/,
);
assert.equal(readFileSync(outPath, 'utf8'), '<html>PRIOR GOOD VERSION</html>');
assert.ok(dbEnded, 'client.end() must be called even on failure');

// Case 3: first-ever run (no prior file) that fails produces no file at all.
const freshOut = join(dir, 'never-written.html');
await assert.rejects(
  run({
    configPath, dbUrl: 'unused', repoDir: 'unused', outPath: freshOut,
    connect: fakeConnect, collectGovernance: failingCollectGovernance,
    collectBuildProgress: okCollectBuildProgress, now: () => new Date(),
  }),
);
assert.ok(!existsSync(freshOut));

console.log('generate.test.mjs — all assertions passed');
