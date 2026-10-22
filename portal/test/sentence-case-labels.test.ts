// Labels, headings, table headers and filter names are sentence case everywhere:
// "Last backup", not "LAST BACKUP". Capitals are kept only for small badges and
// codes that are meant to read as a code (severity, status pills, change kinds).
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = join(__dirname, "..");

// Badges and codes that may stay in capitals. Add to this list only for a
// short code-like badge, never for a label or heading.
const BADGES = new Set([
  ".mode-marker, .result-count, .section-count",
  ".alert-severity",
  ".active-indicator, .inactive-indicator, .collection-status",
  ".severity-pill, .delivery-status",
  ".diff-kind",
  ".verb-chip",
  ".compare-change",
]);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(css|tsx?)$/.test(name) ? [path] : [];
  });
}

function uppercaseRules(): { where: string; selectors: string[] }[] {
  const rules: { where: string; selectors: string[] }[] = [];
  for (const file of [...files(join(root, "app")), ...files(join(root, "components"))]) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
      if (!/text-transform:\s*uppercase/.test(match[2])) continue;
      const selectors = match[1].replace(/\/\*[\s\S]*?\*\//g, "").split(",").map((s) => s.trim()).filter(Boolean);
      const line = source.slice(0, match.index).split("\n").length;
      rules.push({ where: `${file.slice(root.length + 1)}:${line}`, selectors });
    }
  }
  return rules;
}

test("no CSS rule uppercases detail labels", () => {
  const offenders = uppercaseRules()
    .filter(({ selectors }) => selectors.some((s) => /(^|[\s>+~])dt(?![\w-])[^\s>+~]*$/.test(s)))
    .map(({ where, selectors }) => `${where} ${selectors.join(", ")}`);
  assert.deepEqual(offenders, []);
});

test("only badges and codes are uppercased; labels and headings stay sentence case", () => {
  const offenders = uppercaseRules()
    .filter(({ selectors }) => !BADGES.has(selectors.join(", ")))
    .map(({ where, selectors }) => `${where} ${selectors.join(", ")}`);
  assert.deepEqual(offenders, []);
});
