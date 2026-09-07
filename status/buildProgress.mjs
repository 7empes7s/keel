import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

export const M1_LAST_COMMIT = '2e35c575d33b5f005c3f768dd7512b3e63ec419e';
export const M1_TOTAL_TASKS = 23;
export const M2_TOTAL_TASKS = 28;

export function parseCommitLog(raw) {
  return raw.split('\n').filter(Boolean).map((line) => {
    const [hash, subject] = line.split('\x1f');
    return { hash, subject };
  });
}

export function distinctTaskCount(commits) {
  const tasks = new Set();
  for (const { subject } of commits) {
    const match = subject.match(/task-(\d+)/);
    if (match) tasks.add(Number(match[1]));
  }
  return tasks.size;
}

export function summarizePhases(phaseLogs) {
  return phaseLogs.map(({ name, totalTasks, raw }) => {
    const done = Math.min(distinctTaskCount(parseCommitLog(raw)), totalTasks);
    return { name, total: totalTasks, done };
  });
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function countTestFiles(dir) {
  let count = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) count += countTestFiles(full);
    else if (entry.name.endsWith('.test.mjs')) count += 1;
  }
  return count;
}

/** The only impure function in this module. `m1LastCommit` defaults to the real M1/M2 boundary
 * commit (see Global Constraints); tests override it against a throwaway repo. */
export function collectBuildProgress({ repoDir, m1LastCommit = M1_LAST_COMMIT }) {
  const phases = summarizePhases([
    {
      name: 'M1 — Entra cross-tenant remapping',
      totalTasks: M1_TOTAL_TASKS,
      raw: git(['log', '--format=%H%x1f%s', m1LastCommit], repoDir),
    },
    {
      name: 'M2 — same-tenant restore & governance',
      totalTasks: M2_TOTAL_TASKS,
      raw: git(['log', '--format=%H%x1f%s', `${m1LastCommit}..HEAD`], repoDir),
    },
  ]);
  const recentCommits = parseCommitLog(git(['log', '-n', '10', '--format=%h%x1f%s'], repoDir));
  const testFileCount = countTestFiles(repoDir);
  return { phases, recentCommits, testFileCount };
}
