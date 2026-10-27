import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

// A dropdown that filters a list takes several values, and they add up (OR): the
// project's list rule. A filter dropdown is a picker whose choice goes into the page
// address (navigate, router.push, view.set). Those must be MultiOptionPicker; the
// single OptionPicker is for forms and for choosing one thing to open. This scans the
// portal so a new single-value filter dropdown cannot slip back in.

const ROOT = join(import.meta.dirname, "..", "components");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith(".tsx") ? [path] : [];
  });
}

// Single pickers that write the address but are not list filters, with the reason.
const NOT_FILTERS: Record<string, string> = {
  "incidents/incidents-page.tsx:Incident": "opens one incident; it does not filter a list",
};

const pickers = files(ROOT).flatMap((path) => {
  const text = readFileSync(path, "utf8");
  return [...text.matchAll(/<(Multi)?OptionPicker\b[\s\S]*?\/>/g)].map((match) => ({
    path: relative(ROOT, path),
    multi: Boolean(match[1]),
    label: /label="([^"]+)"/.exec(match[0])?.[1] ?? "?",
    writesAddress: /onChange=\{[^}]*\b(navigate|router\.push|view\.set|pushUrl)\(/.test(match[0]),
  }));
});

test("the scan finds the filter dropdowns", () => {
  const multi = pickers.filter((picker) => picker.multi).map((picker) => `${picker.path}:${picker.label}`).sort();
  assert.deepEqual(multi, ["activity/activity-page.tsx:Outcome", "activity/activity-page.tsx:What", "activity/activity-page.tsx:Who", "ask-records.tsx:Columns", "value-report/value-report-page.tsx:Owned by"]);
  assert.ok(pickers.some((picker) => picker.path === "incidents/incidents-page.tsx" && picker.writesAddress), "the scan sees a single picker that writes the address");
});

test("every filter dropdown takes several values", () => {
  const single = pickers
    .filter((picker) => !picker.multi && picker.writesAddress && !NOT_FILTERS[`${picker.path}:${picker.label}`])
    .map((picker) => `${picker.path}: "${picker.label}"`);
  assert.deepEqual(single, [], "a dropdown that filters a list must let values add up: use MultiOptionPicker and keep a comma list in the address");
});
