#!/usr/bin/env node
// Code-health ratchet: ESLint, knip and a file-size budget, compared against baseline.json.
//
//   node tools/code-health/ratchet.mjs check          # exit 1 when anything got worse than the baseline
//   node tools/code-health/ratchet.mjs update         # lower the baseline to today's counts (never raises it)
//   node tools/code-health/ratchet.mjs update --reset # rewrite the baseline from scratch (say why in the PR)
//
// The baseline counts violations per file and per rule, so fixing one anywhere lowers the bar and a
// new one anywhere fails, without line numbers that shift on every edit. File sizes: a file already
// over NEW_FILE_MAX_LINES may grow at most GROWTH_PERCENT over its baseline; any other file stays at
// or under NEW_FILE_MAX_LINES. See docs/code-health.md.
//
// The pure functions below are exported for ratchet.test.mjs, which runs with the engine suite and
// therefore must not need this folder's node_modules: the tools are only spawned, never imported.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const NEW_FILE_MAX_LINES = 800;
export const GROWTH_PERCENT = 5;
export const SECTIONS = ["eslint", "knip", "lines"];
const CODE_FILE = /\.(mjs|cjs|js|ts|tsx|ps1|psm1|sh)$/;

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const baselinePath = path.join(here, "baseline.json");
const bin = (name) => path.join(here, "node_modules/.bin", name);

// ---- Pure functions -----------------------------------------------------------------------

/** Line budget for a file whose baseline is `base` (undefined when it has none). */
export function lineLimit(base) {
  if (!base) return NEW_FILE_MAX_LINES;
  return Math.max(NEW_FILE_MAX_LINES, Math.floor((base * (100 + GROWTH_PERCENT)) / 100));
}

/** Counts ESLint JSON results as { file: { ruleId: n } }. Messages without a rule are parse errors. */
export function countEslint(results, root) {
  const counts = {};
  for (const result of results) {
    const file = toRepoPath(result.filePath, root);
    for (const message of result.messages) {
      const rule = message.ruleId ?? "parse-error";
      counts[file] ??= {};
      counts[file][rule] = (counts[file][rule] ?? 0) + 1;
    }
  }
  return counts;
}

/** Counts knip JSON issues as { file: { issueType: n } }. */
export function countKnip(report) {
  const counts = {};
  for (const issue of report.issues ?? []) {
    for (const [type, value] of Object.entries(issue)) {
      if (!Array.isArray(value) || value.length === 0) continue;
      counts[issue.file] ??= {};
      counts[issue.file][type] = (counts[issue.file][type] ?? 0) + value.length;
    }
  }
  return counts;
}

/** Counts lines the way `wc -l` does, plus one for a last line without a newline. */
export function countLines(text) {
  if (text.length === 0) return 0;
  let lines = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lines++;
  return text.endsWith("\n") ? lines : lines + 1;
}

/** Keeps only the files the size baseline tracks: those over NEW_FILE_MAX_LINES. */
export function trackedLines(lines) {
  return Object.fromEntries(Object.entries(lines).filter(([, n]) => n > NEW_FILE_MAX_LINES));
}

/**
 * Compares a snapshot with the baseline. Returns the regressions (which fail CI) and the
 * improvements (which `update` can lock in), each as { section, file, key, baseline, current, limit }.
 */
export function compare(baseline, current) {
  const regressions = [];
  const improvements = [];
  for (const section of ["eslint", "knip"]) {
    const base = baseline[section] ?? {};
    const now = current[section] ?? {};
    for (const file of union(base, now)) {
      for (const key of union(base[file] ?? {}, now[file] ?? {})) {
        const b = base[file]?.[key] ?? 0;
        const c = now[file]?.[key] ?? 0;
        const entry = { section, file, key, baseline: b, current: c, limit: b };
        if (c > b) regressions.push(entry);
        else if (c < b) improvements.push(entry);
      }
    }
  }
  const base = baseline.lines ?? {};
  const now = current.lines ?? {};
  for (const file of union(base, now)) {
    const b = base[file];
    const c = now[file] ?? 0;
    const limit = lineLimit(b);
    const entry = { section: "lines", file, key: "lines", baseline: b ?? 0, current: c, limit };
    if (c > limit) regressions.push(entry);
    else if (b !== undefined && c < b) improvements.push(entry);
  }
  return { regressions: sortEntries(regressions), improvements: sortEntries(improvements) };
}

/**
 * The baseline after `update`: every count drops to today's value and never rises; entries that
 * reach zero (or files that fall to the new-file limit) disappear. With `reset`, today's
 * snapshot replaces the baseline outright.
 */
export function lowerBaseline(baseline, current, { reset = false } = {}) {
  if (reset) {
    return normalize({ eslint: current.eslint, knip: current.knip, lines: trackedLines(current.lines ?? {}) });
  }
  const next = {};
  for (const section of ["eslint", "knip"]) {
    next[section] = {};
    for (const [file, keys] of Object.entries(baseline[section] ?? {})) {
      for (const [key, b] of Object.entries(keys)) {
        const value = Math.min(b, current[section]?.[file]?.[key] ?? 0);
        if (value > 0) (next[section][file] ??= {})[key] = value;
      }
    }
  }
  next.lines = {};
  for (const [file, b] of Object.entries(baseline.lines ?? {})) {
    const value = Math.min(b, current.lines?.[file] ?? 0);
    if (value > NEW_FILE_MAX_LINES) next.lines[file] = value;
  }
  return normalize(next);
}

/** Deterministic JSON: sections in a fixed order, every object's keys sorted, a trailing newline. */
export function serialize(baseline) {
  return `${JSON.stringify(normalize(baseline), null, 2)}\n`;
}

export function formatEntry(e) {
  if (e.section === "lines") {
    return e.baseline
      ? `${e.file}: ${e.current} lines, over its budget of ${e.limit} (baseline ${e.baseline} + ${GROWTH_PERCENT}%)`
      : `${e.file}: ${e.current} lines; files without a baseline stay at or under ${e.limit}`;
  }
  return `${e.file}: ${e.section} ${e.key} ${e.current} (baseline ${e.baseline})`;
}

function normalize(baseline) {
  const out = {};
  for (const section of SECTIONS) out[section] = sortDeep(baseline[section] ?? {});
  return out;
}

function sortDeep(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortDeep(value[key])]),
  );
}

function union(a, b) {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
}

function sortEntries(entries) {
  return entries.sort((x, y) =>
    `${x.section}\0${x.file}\0${x.key}`.localeCompare(`${y.section}\0${y.file}\0${y.key}`),
  );
}

function toRepoPath(file, root) {
  return path.relative(root, file).split(path.sep).join("/");
}

// ---- Collection (spawns the tools) --------------------------------------------------------

// The two ESLint halves run in separate processes: one type-aware program for all ~1,500
// files does not fit in a default Node heap.
const ESLINT_RUNS = [
  ["engine", "cli", "tools", "status"],
  ["portal"],
];

function runEslint(scratch) {
  const results = [];
  const messages = {};
  ESLINT_RUNS.forEach((dirs, i) => {
    const out = path.join(scratch, `eslint-${i}.json`);
    const run = spawnSync(
      bin("eslint"),
      ["-c", path.join(here, "eslint.config.mjs"), "-f", "json", "-o", out, ...dirs],
      {
        cwd: repoRoot,
        stdio: ["ignore", "inherit", "inherit"],
        env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --max-old-space-size=4096`.trim() },
      },
    );
    // Exit 1 means "found problems", which the baseline handles; anything else is a crash.
    if (run.status !== 0 && run.status !== 1) throw new Error(`eslint ${dirs.join(" ")} exited with ${run.status ?? run.signal}`);
    for (const result of JSON.parse(readFileSync(out, "utf8"))) {
      results.push(result);
      const file = toRepoPath(result.filePath, repoRoot);
      for (const m of result.messages) {
        ((messages[file] ??= {})[m.ruleId ?? "parse-error"] ??= []).push(`${m.line}:${m.column} ${m.message}`);
      }
    }
  });
  return { counts: countEslint(results, repoRoot), messages };
}

function runKnip() {
  const run = spawnSync(
    bin("knip"),
    ["-c", path.join(here, "knip.json"), "--reporter", "json", "--no-progress", "--no-exit-code"],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  if (run.status !== 0) throw new Error(`knip exited with ${run.status ?? run.signal}: ${run.stderr}`);
  const report = JSON.parse(run.stdout);
  const messages = {};
  for (const issue of report.issues ?? []) {
    for (const [type, value] of Object.entries(issue)) {
      if (!Array.isArray(value)) continue;
      for (const item of value) ((messages[issue.file] ??= {})[type] ??= []).push(item.name ?? JSON.stringify(item));
    }
  }
  return { counts: countKnip(report), messages };
}

function measureLines() {
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\0")
    .filter((file) => CODE_FILE.test(file) && existsSync(path.join(repoRoot, file)));
  const lines = {};
  for (const file of files) lines[file] = countLines(readFileSync(path.join(repoRoot, file), "utf8"));
  return lines;
}

function collect() {
  const scratch = mkdtempSync(path.join(tmpdir(), "keel-code-health-"));
  try {
    const eslint = runEslint(scratch);
    const knip = runKnip();
    return {
      snapshot: { eslint: eslint.counts, knip: knip.counts, lines: measureLines() },
      messages: { eslint: eslint.messages, knip: knip.messages },
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function readBaseline() {
  return existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, "utf8")) : { eslint: {}, knip: {}, lines: {} };
}

function main(argv) {
  const [command, ...flags] = argv;
  if (command !== "check" && command !== "update") {
    console.error("usage: ratchet.mjs check | update [--reset]");
    return 2;
  }
  const { snapshot, messages } = collect();
  const baseline = readBaseline();

  if (command === "update") {
    const next = lowerBaseline(baseline, snapshot, { reset: flags.includes("--reset") });
    writeFileSync(baselinePath, serialize(next));
    const { regressions } = compare(next, snapshot);
    console.log(`Wrote ${path.relative(repoRoot, baselinePath)}.`);
    if (regressions.length) console.log(`${regressions.length} new violation(s) are still not in the baseline; run check to see them.`);
    return 0;
  }

  const { regressions, improvements } = compare(baseline, snapshot);
  if (improvements.length) {
    console.log(`\n${improvements.length} count(s) are below the baseline. Lock them in: npm --prefix tools/code-health run baseline`);
    for (const e of improvements) console.log(`  ${formatEntry(e)}`);
  }
  if (regressions.length === 0) {
    console.log("\nCode health: no new lint, dead-code or file-size violations.");
    return 0;
  }
  console.log(`\nCode health: ${regressions.length} new violation(s). Fix them; the baseline only goes down.`);
  for (const e of regressions) {
    console.log(`  ${formatEntry(e)}`);
    for (const detail of messages[e.section]?.[e.file]?.[e.key] ?? []) console.log(`      ${detail}`);
  }
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
