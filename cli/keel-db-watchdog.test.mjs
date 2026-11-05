// cli/keel-db-watchdog.mjs (#1010): the probe the watchdog and the deploy health check run,
// and the alert the watchdog sends through Keel's channels. Runs against the isolated test
// database only; the refused address is a closed local port, as on 2026-11-04 (#1005).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIsolatedTestDatabase } from '../engine/test/dbTestHelper.mjs';
import { schemaSql } from '../engine/store/loadSchema.mjs';
import { createChannel, createSubscription } from '../engine/notify/notifications.mjs';
import { runCli, watchdogEvent, WATCHDOG_EVENT_KIND } from './keel-db-watchdog.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
const client = await database.connect();
await client.query(schemaSql());
// Nothing listens on port 1: connecting gets ECONNREFUSED, the live failure's shape.
const REFUSED = 'postgres://keel:fixture-password@127.0.0.1:1/keel';

function cli(argv, dbUrl = database.url) {
  const out = [];
  const err = [];
  const logger = { log: (line) => out.push(line), error: (line) => err.push(line) };
  return runCli({ argv: ['node', 'keel-db-watchdog.mjs', ...argv], dbUrl, logger }).then((code) => ({ code, out, err }));
}

test.after(async () => { await client.end(); await database.cleanup(); });

test('probe: 0 when the database answers, 2 when the connection is refused, never printing the address', async () => {
  assert.deepEqual(await cli(['probe']), { code: 0, out: ['database answers'], err: [] });
  const refused = await cli(['probe'], REFUSED);
  assert.equal(refused.code, 2);
  assert.deepEqual(refused.err, ['database unreachable (ECONNREFUSED)']);
  assert.doesNotMatch(refused.err.join('\n'), /fixture-password|127\.0\.0\.1/);
});

test('alert: queued once to a channel that takes alerts; a repeat adds no second delivery', async () => {
  const channel = await createChannel(client, { kind: 'email', config: { to: 'ops@example.test', from: 'keel@example.test' } });
  await createSubscription(client, { channelId: channel.id, eventGlob: '*', minSeverity: 'warning' });
  const args = ['alert', '--action', 'gave-up', '--at', '2026-11-04T22:52:00Z', '--detail', 'keel-postgres is running after 3 restarts in the last hour.'];
  assert.deepEqual(await cli(args), { code: 0, out: ['alert queued to 1 channel'], err: [] });
  const { rows } = await client.query('SELECT event FROM delivery WHERE channel_id = $1', [channel.id]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].event.kind, WATCHDOG_EVENT_KIND);
  assert.equal(rows[0].event.severity, 'critical');
  assert.equal(rows[0].event.occurredAt, '2026-11-04T22:52:00.000Z');
  assert.match(rows[0].event.summary, /stopped trying/);
  const again = await cli(args);
  assert.equal(again.code, 0);
  assert.match(again.out[0], /^no new delivery/);
  assert.equal((await client.query('SELECT count(*)::int AS n FROM delivery')).rows[0].n, 1);
});

test('alert: with the database still unreachable it exits 2, so the watchdog keeps it for later', async () => {
  const result = await cli(['alert', '--action', 'restarted', '--at', '2026-11-04T22:48:00Z'], REFUSED);
  assert.equal(result.code, 2);
});

test('alert: an unknown action or a missing time is refused before connecting', async () => {
  assert.equal((await cli(['alert', '--action', 'reboot', '--at', '2026-11-04T22:48:00Z'], REFUSED)).code, 1);
  assert.equal((await cli(['alert', '--action', 'restarted'], REFUSED)).code, 1);
  assert.throws(() => watchdogEvent({ action: 'started', at: 'soon' }), /--at/);
  assert.equal(watchdogEvent({ action: 'started', at: '2026-11-04T22:48:00Z' }).severity, 'warning');
});
