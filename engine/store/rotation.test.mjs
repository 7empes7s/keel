import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_ROTATION, PERIOD_KEYS, describePolicy, matchingHolds, normalizePolicy, reasonKind, resolvePolicy, rotationReasons,
} from './rotation.mjs';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const now = new Date('2026-10-15T12:00:00Z');

// Members at the given times; ids sort with time so ties are easy to read.
const members = (times) => times.map((at, i) => ({ id: `m${String(i).padStart(4, '0')}`, at: new Date(at) }));
const keptIds = (list, policy) => {
  const reasons = rotationReasons(list, policy, now);
  return list.filter((m) => reasons.get(m.id).length).map((m) => m.id);
};

test('daily keeps the newest backup of each of the newest N days that have one', () => {
  // Hourly for 5 days: 120 backups.
  const list = members(Array.from({ length: 120 }, (_, i) => now - (119 - i) * HOUR));
  const kept = keptIds(list, { daily: 3 });
  assert.equal(kept.length, 3);
  const days = kept.map((id) => list.find((m) => m.id === id).at.toISOString());
  assert.deepEqual(days, ['2026-10-13T23:00:00.000Z', '2026-10-14T23:00:00.000Z', '2026-10-15T12:00:00.000Z']);
});

test('a day with no backup uses no slot', () => {
  const list = members([now - 30 * DAY, now - 10 * DAY, now]);
  assert.deepEqual(keptIds(list, { daily: 3 }), ['m0000', 'm0001', 'm0002']);
  assert.deepEqual(keptIds(list, { daily: 2 }), ['m0001', 'm0002']);
});

test('weekly uses ISO weeks, across a year end', () => {
  assert.equal(PERIOD_KEYS.weekly(new Date('2026-12-31T00:00:00Z')), '2026-W53');
  assert.equal(PERIOD_KEYS.weekly(new Date('2027-01-03T23:00:00Z')), '2026-W53');
  assert.equal(PERIOD_KEYS.weekly(new Date('2027-01-04T00:00:00Z')), '2027-W01');
  assert.equal(PERIOD_KEYS.weekly(new Date('2021-01-03T00:00:00Z')), '2020-W53');
  // Daily for 28 days ending on Thursday 2026-10-15: weeks W39 (Sun only) .. W42.
  const list = members(Array.from({ length: 28 }, (_, i) => now - (27 - i) * DAY));
  const reasons = rotationReasons(list, { weekly: 3 }, now);
  const kept = list.filter((m) => reasons.get(m.id).length);
  assert.deepEqual(kept.map((m) => reasons.get(m.id)[0]), ['weekly 2026-W40', 'weekly 2026-W41', 'weekly 2026-W42']);
  assert.deepEqual(kept.map((m) => m.at.toISOString().slice(0, 10)), ['2026-10-04', '2026-10-11', '2026-10-15']);
});

test('monthly and yearly keep the newest of each month and year', () => {
  // The 1st and 20th of every month for three years.
  const times = [];
  for (const year of [2024, 2025, 2026]) {
    for (let month = 0; month < 12; month += 1) {
      for (const day of [1, 20]) {
        const at = Date.UTC(year, month, day);
        if (at <= now.valueOf()) times.push(at);
      }
    }
  }
  const list = members(times);
  const byMonth = rotationReasons(list, { monthly: 4 }, now);
  assert.deepEqual(
    list.filter((m) => byMonth.get(m.id).length).map((m) => m.at.toISOString().slice(0, 10)),
    ['2026-07-20', '2026-08-20', '2026-09-20', '2026-10-01'],
  );
  const byYear = rotationReasons(list, { yearly: 7 }, now);
  assert.deepEqual(
    list.filter((m) => byYear.get(m.id).length).map((m) => byYear.get(m.id)[0]),
    ['yearly 2024', 'yearly 2025', 'yearly 2026'],
  );
  assert.deepEqual(
    list.filter((m) => byYear.get(m.id).length).map((m) => m.at.toISOString().slice(0, 10)),
    ['2024-12-20', '2025-12-20', '2026-10-01'],
  );
});

test('the default policy is 14 daily, 8 weekly, 12 monthly, 7 yearly, and periods add up', () => {
  assert.equal(describePolicy(normalizePolicy(DEFAULT_ROTATION)), '14 daily, 8 weekly, 12 monthly, 7 yearly');
  // Daily for two years.
  const list = members(Array.from({ length: 730 }, (_, i) => now - (729 - i) * DAY));
  const reasons = rotationReasons(list, DEFAULT_ROTATION, now);
  const kept = list.filter((m) => reasons.get(m.id).length);
  const count = (period) => [...reasons.values()].filter((r) => r.some((x) => x.startsWith(period))).length;
  assert.deepEqual([count('daily'), count('weekly'), count('monthly'), count('yearly')], [14, 8, 12, 3]);
  // Overlaps (today is daily, weekly, monthly and yearly at once) are kept once.
  assert.ok(kept.length < 14 + 8 + 12 + 3);
  assert.deepEqual(reasons.get(list.at(-1).id), ['daily 2026-10-15', 'weekly 2026-W42', 'monthly 2026-10', 'yearly 2026']);
});

test('an unfinished member never takes a slot', () => {
  const list = [{ id: 'done', at: new Date(now - HOUR) }, { id: 'running', at: now, rotates: false }];
  const reasons = rotationReasons(list, { daily: 1 }, now);
  assert.deepEqual(reasons.get('running'), []);
  assert.deepEqual(reasons.get('done'), ['daily 2026-10-15']);
});

test('keep within N days and keep forever', () => {
  const list = members([now - 10 * DAY, now - 6 * DAY, now - DAY]);
  assert.deepEqual(keptIds(list, { keepWithinDays: 7 }), ['m0001', 'm0002']);
  assert.deepEqual(keptIds(list, { keepForever: true }), ['m0000', 'm0001', 'm0002']);
});

test('a policy has to keep something, and counts are whole numbers', () => {
  assert.throws(() => normalizePolicy({}), /must keep something/);
  assert.throws(() => normalizePolicy({ daily: 0, keepForever: false }), /must keep something/);
  assert.throws(() => normalizePolicy({ daily: -1 }), /whole number/);
  assert.throws(() => normalizePolicy({ daily: 1.5 }), /whole number/);
  assert.throws(() => normalizePolicy({ keepForever: 'yes' }), /true or false/);
});

test('the most specific policy wins; every covering hold applies', () => {
  const policies = [
    { workload: null, container: null, itemKey: null, daily: 30 },
    { workload: 'exchange-mail', container: null, itemKey: null, daily: 7 },
    { workload: 'exchange-mail', container: 'mbx-1', itemKey: 'msg-1', keepForever: true },
  ];
  assert.equal(resolvePolicy(policies, { workload: 'exchange-mail', container: 'mbx-1', itemKey: 'msg-1' }).label, 'exchange-mail / mbx-1 / msg-1: keep forever');
  assert.equal(resolvePolicy(policies, { workload: 'exchange-mail', container: 'mbx-1', itemKey: 'msg-2' }).label, 'exchange-mail: 7 daily');
  assert.equal(resolvePolicy(policies, { workload: 'onedrive', container: 'd', itemKey: 'f' }).label, 'tenant: 30 daily');
  assert.equal(resolvePolicy([], { workload: 'config', container: 'tier1' }).label, 'default: 14 daily, 8 weekly, 12 monthly, 7 yearly');

  const holds = [
    { id: 'h1', workload: null, container: null, itemKey: null },
    { id: 'h2', workload: 'onedrive', container: 'drive-a', itemKey: null },
    { id: 'h3', workload: 'onedrive', container: 'drive-b', itemKey: null },
  ];
  assert.deepEqual(matchingHolds(holds, { workload: 'onedrive', container: 'drive-a', itemKey: 'x' }).map((h) => h.id), ['h1', 'h2']);
  assert.deepEqual(matchingHolds(holds.slice(1), { workload: 'config', container: 'tier1', itemKey: 's' }), []);
});

test('reason kinds group report totals', () => {
  assert.equal(reasonKind('daily 2026-10-15'), 'daily');
  assert.equal(reasonKind('weekly 2026-W42'), 'weekly');
  assert.equal(reasonKind('monthly 2026-10'), 'monthly');
  assert.equal(reasonKind('yearly 2026'), 'yearly');
  assert.equal(reasonKind('legal hold: litigation'), 'legal hold');
  assert.equal(reasonKind('referenced by baseline'), 'referenced');
  assert.equal(reasonKind('within 7 days'), 'within window');
  assert.equal(reasonKind('latest version'), 'latest version');
});
