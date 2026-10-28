// tools/merge-gate.sh must tie the merge to the head commit it checked: the label must still be
// there, a required review must be on that commit, a later comment must not clear a change request,
// every page of check runs counts, and the merge call is pinned to the checked SHA. The label must
// be newer than the head commit's arrival (its first pull_request run of merge-gate.yml).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./merge-gate.sh', import.meta.url));
const HEAD = 'cccc';

const review = (user, state, commit_id, submitted_at) => ({ user: { login: user }, state, commit_id, submitted_at });

// Fake gh for one PR (#7, head cccc, author "builder"). `pages` maps an API path prefix to a list of
// JSON pages; --paginate prints every page through -q, a plain call prints the first.
function run({
  labels = ['automerge'], reviews = [], checkPages, requireReview = true, base = 'master',
  labelledAt = ['2026-01-01T12:00:00Z'], arrivedAt = ['2026-01-01T11:00:00Z', '2026-01-01T12:00:01Z'],
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'keel-merge-gate-'));
  const log = join(dir, 'gh.log');
  writeFileSync(log, '');
  const pages = {
    'issues?labels=automerge': [[{ number: 7, pull_request: {} }]],
    'pulls/7/files': [[{ filename: 'engine/x.mjs' }]],
    'pulls/7/reviews': [reviews],
    'issues/7/events': [[
      { event: 'labeled', label: { name: 'documentation' }, created_at: '2026-01-02T00:00:00Z' },
      ...labelledAt.map((created_at) => ({ event: 'labeled', label: { name: 'automerge' }, created_at })),
      { event: 'unlabeled', label: { name: 'automerge' }, created_at: '2026-01-01T13:00:00Z' },
    ]],
    'actions/workflows/merge-gate.yml/runs': [{ workflow_runs: arrivedAt.map((created_at) => ({ created_at })) }],
    [`commits/${HEAD}/check-runs`]: checkPages ?? [{ check_runs: [{ name: 'Portal tests', status: 'completed', conclusion: 'success' }] }],
    'actions/workflows/portal.yml/runs': [{ workflow_runs: [{ status: 'completed', conclusion: 'success' }] }],
    'pulls/7': [{ state: 'open', draft: false, mergeable: true, mergeable_state: 'clean', head: { sha: HEAD }, base: { ref: base }, user: { login: 'builder' }, labels: labels.map((name) => ({ name })) }],
  };
  writeFileSync(join(dir, 'pages.json'), JSON.stringify(pages));
  writeFileSync(join(dir, 'gh'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${log}"
if [ "$1" = api ]; then
  shift; url=""; q=""; paginate=0
  while [ $# -gt 0 ]; do
    case "$1" in
      -q) q="$2"; shift ;;
      --paginate) paginate=1 ;;
      repos/o/r/*) url="\${1#repos/o/r/}" ;;
      graphql) url=graphql ;;
    esac
    shift
  done
  if [ "$url" = graphql ]; then echo '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}' | jq "\${q:-.}"; exit 0; fi
  key=$(jq -r --arg u "$url" 'keys | map(select(. as $k | $u | startswith($k))) | max_by(length) // empty' "${dir}/pages.json")
  [ -n "$key" ] || { echo "stub: unhandled $url" >&2; exit 1; }
  if [ "$paginate" = 1 ]; then sel='.[$k][]'; else sel='.[$k][0]'; fi
  jq -c --arg k "$key" "$sel" "${dir}/pages.json" | while read -r page; do jq -r "\${q:-.}" <<<"$page"; done
  exit 0
fi
[ "$1" = pr ] && [ "$2" = merge ] && exit 0
[ "$1" = workflow ] && exit 0
echo "stub: unhandled $*" >&2; exit 1
`);
  chmodSync(join(dir, 'gh'), 0o755);
  const res = spawnSync('bash', [script], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GITHUB_REPOSITORY: 'o/r', MERGEABLE_POLLS: '0', REQUIRE_REVIEW: requireReview ? 'true' : '' },
    encoding: 'utf8',
  });
  const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean);
  return { out: res.stdout + res.stderr, status: res.status, calls, merge: calls.find((c) => c.startsWith('pr merge')) };
}

test('a review on the head commit lets the PR merge, pinned to that commit', () => {
  const r = run({ reviews: [review('codex', 'COMMENTED', HEAD, '2026-01-02T00:00:00Z')] });
  assert.match(r.out, /#7: merging/);
  assert.equal(r.status, 0);
  assert.equal(r.merge, `pr merge 7 -R o/r --merge --delete-branch --match-head-commit ${HEAD}`);
});

for (const state of ['APPROVED', 'COMMENTED', 'DISMISSED']) {
  test(`a ${state} review of an older commit does not satisfy REQUIRE_REVIEW`, () => {
    const r = run({ reviews: [review('codex', state, 'aaaa', '2026-01-02T00:00:00Z')] });
    assert.match(r.out, /#7: waiting for a review of cccc/);
    assert.equal(r.merge, undefined);
  });
}

test('a dismissed review of the head commit does not count', () => {
  const r = run({ reviews: [review('codex', 'DISMISSED', HEAD, '2026-01-02T00:00:00Z')] });
  assert.match(r.out, /waiting for a review/);
  assert.equal(r.merge, undefined);
});

test('the author reviewing their own head commit does not count', () => {
  const r = run({ reviews: [review('builder', 'APPROVED', HEAD, '2026-01-02T00:00:00Z')] });
  assert.match(r.out, /waiting for a review/);
});

test('a later comment does not clear a change request', () => {
  const r = run({
    reviews: [
      review('codex', 'CHANGES_REQUESTED', 'aaaa', '2026-01-01T00:00:00Z'),
      review('codex', 'COMMENTED', HEAD, '2026-01-02T00:00:00Z'),
    ],
  });
  assert.match(r.out, /#7: changes requested/);
  assert.equal(r.merge, undefined);
});

test('a later approval by the same reviewer clears their change request', () => {
  const r = run({
    reviews: [
      review('codex', 'CHANGES_REQUESTED', 'aaaa', '2026-01-01T00:00:00Z'),
      review('codex', 'APPROVED', HEAD, '2026-01-02T00:00:00Z'),
    ],
  });
  assert.match(r.out, /#7: merging/);
});

test('a PR whose label was removed after a push is not merged', () => {
  const r = run({ labels: [], reviews: [review('codex', 'APPROVED', HEAD, '2026-01-02T00:00:00Z')] });
  assert.match(r.out, /#7: no automerge label/);
  assert.equal(r.merge, undefined);
});

test('a failed check on a later page of check runs blocks the merge', () => {
  const ok = { name: 'Portal tests', status: 'completed', conclusion: 'success' };
  const r = run({
    reviews: [review('codex', 'APPROVED', HEAD, '2026-01-02T00:00:00Z')],
    checkPages: [{ check_runs: Array(100).fill(ok) }, { check_runs: [{ name: 'Late check', status: 'completed', conclusion: 'failure' }] }],
  });
  assert.match(r.out, /#7: a check failed/);
  assert.equal(r.merge, undefined);
});

test('a running check on a later page blocks the merge', () => {
  const ok = { name: 'Portal tests', status: 'completed', conclusion: 'success' };
  const r = run({
    requireReview: false,
    checkPages: [{ check_runs: [ok] }, { check_runs: [{ name: 'Drop automerge label after a push', status: 'queued', conclusion: null }] }],
  });
  assert.match(r.out, /#7: checks still running/);
});

test('without REQUIRE_REVIEW a labelled green PR still merges, pinned to its head', () => {
  const r = run({ requireReview: false });
  assert.match(r.out, /#7: merging/);
  assert.match(r.merge, /--match-head-commit cccc$/);
});

test('a label added before the head commit arrived does not count', () => {
  const r = run({ requireReview: false, labelledAt: ['2026-01-01T10:00:00Z'] });
  assert.match(r.out, /#7: automerge label predates head cccc/);
  assert.equal(r.merge, undefined);
});

test('adding the label again after the push makes it count', () => {
  const r = run({ requireReview: false, labelledAt: ['2026-01-01T10:00:00Z', '2026-01-01T11:30:00Z'] });
  assert.match(r.out, /#7: merging/);
});

test('a head with no recorded arrival is treated as newer than the label', () => {
  const r = run({ requireReview: false, arrivedAt: [] });
  assert.match(r.out, /#7: automerge label predates head/);
  assert.equal(r.merge, undefined);
});

test('the arrival query is pinned to pull_request runs of this head', () => {
  const r = run({ requireReview: false });
  assert.ok(r.calls.some((c) => c.includes('repos/o/r/actions/workflows/merge-gate.yml/runs?event=pull_request&head_sha=cccc&')));
});

test('a PR into a branch other than master is not merged', () => {
  const r = run({ requireReview: false, base: 'claude/other' });
  assert.match(r.out, /#7: not based on master/);
  assert.equal(r.merge, undefined);
});
