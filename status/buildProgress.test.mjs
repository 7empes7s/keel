import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseCommitLog, distinctTaskCount, summarizePhases, collectBuildProgress } from './buildProgress.mjs';

// --- pure functions, fixtures only ---

const raw = 'abc123\x1ffeat: task-01 thing\ndef456\x1ffeat: task-02 other thing\n';
assert.deepEqual(parseCommitLog(raw), [
  { hash: 'abc123', subject: 'feat: task-01 thing' },
  { hash: 'def456', subject: 'feat: task-02 other thing' },
]);

// Same task number committed twice (a revision) counts once, not twice.
const revised = parseCommitLog(
  'a\x1ffeat(engine): thing (autonomous orchestration, task-01)\n'
  + 'b\x1ffeat(engine): revised (autonomous orchestration, task-01)\n'
  + 'c\x1ffeat(engine): other (autonomous orchestration, task-02)\n',
);
assert.equal(distinctTaskCount(revised), 2);

assert.deepEqual(
  summarizePhases([{
    name: 'Phase X',
    totalTasks: 3,
    raw: 'a\x1ffeat(engine): a (autonomous orchestration, task-01)\n'
      + 'b\x1ffeat(engine): b (autonomous orchestration, task-02)\n',
  }]),
  [{ name: 'Phase X', total: 3, done: 2 }],
);

// done never exceeds total, even if more distinct task numbers appear than the plan declares.
assert.deepEqual(
  summarizePhases([{
    name: 'Phase Y',
    totalTasks: 1,
    raw: 'a\x1ffeat(engine): a (autonomous orchestration, task-01)\n'
      + 'b\x1ffeat(engine): b (autonomous orchestration, task-02)\n',
  }]),
  [{ name: 'Phase Y', total: 1, done: 1 }],
);

// --- impure wrapper, against a real throwaway git repo ---

const dir = mkdtempSync(join(tmpdir(), 'keel-status-buildprogress-'));
execFileSync('git', ['init', '-q'], { cwd: dir });
execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
mkdirSync(join(dir, 'engine'), { recursive: true });
writeFileSync(join(dir, 'engine', 'a.test.mjs'), '// fixture\n');
execFileSync('git', ['add', '.'], { cwd: dir });
execFileSync('git', ['commit', '-q', '-m', 'feat(engine): seed (autonomous orchestration, task-01)'], { cwd: dir });
const firstCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();

writeFileSync(join(dir, 'file2.txt'), 'two\n');
execFileSync('git', ['add', '.'], { cwd: dir });
execFileSync('git', ['commit', '-q', '-m', 'feat(engine): revised for M2 (autonomous orchestration, task-01)'], { cwd: dir });
writeFileSync(join(dir, 'engine', 'b.test.mjs'), '// fixture\n');
execFileSync('git', ['add', '.'], { cwd: dir });
execFileSync('git', ['commit', '-q', '-m', 'feat(engine): more (autonomous orchestration, task-02)'], { cwd: dir });

const progress = collectBuildProgress({ repoDir: dir, m1LastCommit: firstCommit });
assert.equal(progress.testFileCount, 2);
assert.equal(progress.recentCommits.length, 3);
assert.deepEqual(progress.phases, [
  { name: 'M1 — Entra cross-tenant remapping', total: 23, done: 1 },
  { name: 'M2 — same-tenant restore & governance', total: 28, done: 2 },
]);

console.log('buildProgress.test.mjs — all assertions passed');
