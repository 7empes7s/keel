// status/render.test.mjs
import { strict as assert } from 'node:assert';
import { renderPage, escapeHtml, fmtAge } from './render.mjs';

assert.equal(escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
assert.equal(escapeHtml(`O'Brien & "Co"`), 'O&#39;Brien &amp; &quot;Co&quot;');

assert.equal(fmtAge(null), 'never');
assert.equal(fmtAge(new Date(Date.now() - 5 * 60000).toISOString()), '5m ago');

const html = renderPage({
  buildProgress: {
    phases: [{ name: 'M1', total: 23, done: 21 }, { name: 'M2', total: 28, done: 28 }],
    recentCommits: [{ hash: 'abc1234', subject: 'feat: <injected> task-28 thing' }],
    testFileCount: 40,
  },
  governance: {
    resourceCounts: { byType: [
      { resourceType: 'group', count: 12, asOf: '2026-09-07T00:00:00Z' },
      { resourceType: 'user', count: 7, asOf: '2026-09-06T00:00:00Z' },
      { resourceType: 'namedLocation', count: 0, asOf: '2026-09-07T00:00:00Z' },
      { resourceType: 'roleAssignment', count: null, asOf: '2026-09-07T00:00:00Z' },
    ], asOf: null },
    baseline: { setAt: '2026-09-06T00:00:00Z' },
    openDrift: [{ changeType: 'modified', blastRadius: 'access-affecting', count: 2 }],
    lastCollection: { completedAt: '2026-09-07T00:00:00Z', status: 'complete' },
    evidence: { ok: true, chainLength: 5 },
    recentDispositions: [{ action: 'accept', count: 1 }],
  },
  generatedAt: '2026-09-07T12:00:00.000Z',
});

assert.match(html, /21\/23/);
assert.match(html, /28\/28/);
assert.match(html, /40 test files/);
assert.match(html, /group/);
assert.match(html, />12</);
assert.match(html, /group<span>12<small><time datetime="2026-09-07T00:00:00.000Z"/);
assert.match(html, /user<span>7<small><time datetime="2026-09-06T00:00:00.000Z"/);
assert.match(html, /namedLocation<span>0</);
assert.match(html, /roleAssignment<span>unavailable</);
assert.match(html, /intact/);
assert.match(html, /5 records/);
assert.match(html, /1 accept/);
assert.ok(!html.includes('<injected>'), 'commit subjects must be escaped, not injected raw');
assert.match(html, /&lt;injected&gt;/);
for (const forbidden of ['payload', 'natural_key', 'naturalKey', 'before_payload', 'after_payload']) {
  assert.ok(!html.toLowerCase().includes(forbidden.toLowerCase()), `must never render "${forbidden}"`);
}

const emptyHtml = renderPage({
  buildProgress: { phases: [], recentCommits: [], testFileCount: 0 },
  governance: {
    resourceCounts: { byType: [], asOf: null }, baseline: null, openDrift: [],
    lastCollection: null, evidence: { ok: false, chainLength: 0 }, recentDispositions: [],
  },
  generatedAt: '2026-09-07T12:00:00.000Z',
});
assert.match(emptyHtml, /none set/);
assert.match(emptyHtml, /never/);
assert.match(emptyHtml, /BROKEN/);
assert.match(emptyHtml, /none<\/td>/);

console.log('render.test.mjs — all assertions passed');
