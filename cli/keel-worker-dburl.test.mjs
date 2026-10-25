// The worker hands its database URL to each job in the environment, never in argv:
// argv is readable by every user on the box through ps. Drives runJob with a fake
// client and a fixture script; no database and no tenant.
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runJob } from './keel-worker.mjs';

const dir = mkdtempSync(join(tmpdir(), 'keel-worker-dburl-'));
const seen = join(dir, 'seen.json');
const script = join(dir, 'child.mjs');
writeFileSync(script, `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ argv: process.argv.slice(2), dbUrl: process.env.KEEL_DB_URL ?? null }));\n`);

const completed = [];
const client = {
  async query(sql, params) {
    if (sql.includes("SET status = 'succeeded'")) {
      completed.push(params);
      return { rows: [{ id: params[0], status: 'succeeded', result: params[1] }] };
    }
    if (sql.includes("SET status = 'failed'")) throw new Error(`job failed: ${params[1]}`);
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] };
    if (sql.includes('pg_advisory_unlock')) return { rows: [] };
    if (sql.includes('FROM principal WHERE id::text = $1')) return { rows: [{ id: params[0], email: 'op@example.com', disabled_at: null }] };
    if (sql.includes('FROM role_grant')) return { rows: [{ role: 'operator', scope: '*' }] };
    throw new Error(`unexpected query: ${sql}`);
  },
};

const dbUrl = 'postgres://keel:fixture-secret@127.0.0.1:5432/keel';
await runJob(client, { id: 'job-dburl', kind: 'collect', params: {}, requested_by: 'principal-op', created_at: new Date() }, {
  dbUrl, onInFlightChange: () => {}, handlers: { collect: { script, argsFor: () => ['--tier', 'tier1'] } },
});
assert.equal(completed.length, 1, 'the job runs');
const child = JSON.parse(readFileSync(seen, 'utf8'));
assert.deepEqual(child.argv, ['--tier', 'tier1'], 'argv carries only the job flags');
assert.ok(!child.argv.join(' ').includes('fixture-secret'), 'the password is not in argv');
assert.equal(child.dbUrl, dbUrl, 'the child reads the database URL from KEEL_DB_URL');
console.log('keel-worker-dburl.test.mjs — all assertions passed');
