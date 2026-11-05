#!/usr/bin/env node
// Report-only measurements behind docs/code-health.md. Nothing here fails a build.
//
//   node tools/code-health/measure.mjs files       # largest code files
//   node tools/code-health/measure.mjs functions   # longest and most complex functions
//   node tools/code-health/measure.mjs untested    # modules that no test imports, directly or at all
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { countLines } from "./ratchet.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const SOURCE = /^(engine|cli|tools|status|portal)\/.*\.(mjs|ts|tsx)$/;
const TEST = /\.(test|spec)\.(mjs|ts|tsx)$/;
const top = Number(process.env.TOP ?? 20);

function trackedSources() {
  return execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\0")
    .filter((file) => SOURCE.test(file) && !file.includes("/coverage-fixtures/") && existsSync(path.join(repoRoot, file)));
}

function table(header, rows) {
  console.log(`| ${header.join(" | ")} |`);
  console.log(`|${header.map(() => "---").join("|")}|`);
  for (const row of rows) console.log(`| ${row.join(" | ")} |`);
}

function files() {
  const rows = trackedSources()
    .map((file) => [file, countLines(readFileSync(path.join(repoRoot, file), "utf8"))])
    .sort((a, b) => b[1] - a[1])
    .slice(0, top);
  table(["File", "Lines"], rows.map(([f, n]) => [`\`${f}\``, n]));
}

async function functions() {
  const { ESLint } = await import("eslint");
  const tseslint = (await import("typescript-eslint")).default;
  const eslint = new ESLint({
    cwd: repoRoot,
    overrideConfigFile: true,
    overrideConfig: [
      { ignores: ["**/node_modules/**", "**/coverage-fixtures/**", "portal/.next/**"] },
      {
        files: ["**/*.mjs", "**/*.ts", "**/*.tsx"],
        languageOptions: { parser: tseslint.parser, parserOptions: { ecmaFeatures: { jsx: true } } },
        rules: {
          complexity: ["warn", { max: 0 }],
          "max-lines-per-function": ["warn", { max: 0, skipBlankLines: true, skipComments: true }],
        },
      },
    ],
  });
  const results = await eslint.lintFiles(trackedSources().filter((f) => !TEST.test(f)));
  const fns = new Map();
  for (const result of results) {
    const file = path.relative(repoRoot, result.filePath);
    for (const m of result.messages) {
      const key = `${file}:${m.line}`;
      const fn = fns.get(key) ?? { file, line: m.line, name: "", complexity: 0, lines: 0 };
      const complexity = /complexity of (\d+)/.exec(m.message);
      const lines = /too many lines \((\d+)\)/.exec(m.message);
      const name = /^(.*?) has (?:a complexity|too many lines)/.exec(m.message);
      if (complexity) fn.complexity = Number(complexity[1]);
      if (lines) fn.lines = Number(lines[1]);
      if (name) fn.name = name[1].replace(/^Async /, "async ");
      fns.set(key, fn);
    }
  }
  const all = [...fns.values()];
  const row = (f) => [`\`${f.file}:${f.line}\``, f.name, f.lines, f.complexity];
  console.log(`Functions measured: ${all.length}; complexity over 20: ${all.filter((f) => f.complexity > 20).length}; over 50: ${all.filter((f) => f.complexity > 50).length}; over 100 lines: ${all.filter((f) => f.lines > 100).length}\n`);
  console.log("Most complex:\n");
  table(["Function", "Name", "Lines", "Complexity"], all.sort((a, b) => b.complexity - a.complexity).slice(0, top).map(row));
  console.log("\nLongest:\n");
  table(["Function", "Name", "Lines", "Complexity"], all.sort((a, b) => b.lines - a.lines).slice(0, top).map(row));
}

// Static relative imports and the portal's "@/" alias; dynamic imports with a literal path count too.
const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;

function resolveImport(from, spec) {
  let base;
  if (spec.startsWith(".")) base = path.posix.join(path.posix.dirname(from), spec);
  else if (spec.startsWith("@/")) base = path.posix.join("portal", spec.slice(2));
  else return undefined;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.mjs`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (existsSync(path.join(repoRoot, candidate)) && SOURCE.test(candidate)) return candidate;
  }
  return undefined;
}

function untested() {
  const sources = trackedSources();
  const imports = new Map();
  for (const file of sources) {
    const text = readFileSync(path.join(repoRoot, file), "utf8");
    const deps = new Set();
    for (const [, spec] of text.matchAll(IMPORT)) {
      const target = resolveImport(file, spec);
      if (target) deps.add(target);
    }
    imports.set(file, deps);
  }
  // The UI harness page is what the Playwright specs render; CLI tests spawn their entry point by path.
  const tests = sources.filter((f) => TEST.test(f) || f === "portal/ui-harness/app.tsx");
  for (const t of tests) {
    const text = readFileSync(path.join(repoRoot, t), "utf8");
    for (const file of sources) if (!TEST.test(file) && ["\"", "'", "`"].some((q) => text.includes(`${path.basename(file)}${q}`))) imports.get(t).add(file);
  }
  const direct = new Set(tests.flatMap((t) => [...imports.get(t)]));
  const reached = new Set();
  const queue = [...tests];
  while (queue.length) {
    for (const dep of imports.get(queue.pop()) ?? []) {
      if (!reached.has(dep)) {
        reached.add(dep);
        queue.push(dep);
      }
    }
  }
  const modules = sources.filter((f) => !TEST.test(f) && !f.startsWith("portal/ui-harness/"));
  const byArea = {};
  for (const file of modules) {
    const area = file.split("/").slice(0, file.startsWith("engine/") ? 2 : 1).join("/");
    const a = (byArea[area] ??= { modules: 0, noDirect: 0, unreached: 0 });
    a.modules++;
    if (!direct.has(file)) a.noDirect++;
    if (!reached.has(file)) a.unreached++;
  }
  const notDirect = modules.filter((f) => !direct.has(f));
  const unreached = modules.filter((f) => !reached.has(f));
  console.log(`Modules: ${modules.length}; no test imports them directly: ${notDirect.length}; no test reaches them at all: ${unreached.length}\n`);
  table(
    ["Area", "Modules", "No direct test import", "Not reached by any test"],
    Object.entries(byArea)
      .sort((a, b) => b[1].unreached - a[1].unreached)
      .map(([area, a]) => [`\`${area}\``, a.modules, a.noDirect, a.unreached]),
  );
  console.log("\nLargest modules no test reaches:\n");
  const rows = unreached
    .map((f) => [f, countLines(readFileSync(path.join(repoRoot, f), "utf8"))])
    .sort((a, b) => b[1] - a[1])
    .slice(0, top);
  table(["Module", "Lines"], rows.map(([f, n]) => [`\`${f}\``, n]));
}

const command = process.argv[2];
if (command === "files") files();
else if (command === "functions") await functions();
else if (command === "untested") untested();
else {
  console.error("usage: measure.mjs files | functions | untested");
  process.exitCode = 2;
}
