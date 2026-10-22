import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { test } from "node:test";

import ts from "typescript";

import { compareSides } from "../lib/record-compare";
import { fieldInfo, RECORD_GLOSSARY } from "../lib/record-glossary";
import { durationWords, shownValue } from "../lib/record-values";
import { forecastRecord } from "../lib/schedule-forecast-view";
import { SERVICENOW_FIELD_LABELS } from "../components/servicenow-panel";

// Every "Technical details" field must read in plain words: a plain label and a
// one-line meaning from lib/record-glossary. This test reads every RecordField and
// RecordCompare in the portal and fails when a label has no entry, so a new field
// cannot ship as a raw key ("Recoverable point age (ms)", "Evidence sequence").

const PORTAL = resolve(__dirname, "..");
const FIELD_COMPONENTS = new Set(["RecordField", "RecordCompare"]);

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(directory)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const path = join(directory, name);
    if (statSync(path).isDirectory()) files.push(...sourceFiles(path));
    else if (name.endsWith(".tsx")) files.push(path);
  }
  return files;
}

/** Every label a label expression can produce; a `${…}` part becomes "Example",
 *  a conditional of strings becomes each string. null when the label is only data. */
function labelsOf(expression: ts.Expression): string[] | null {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return [expression.text];
  if (ts.isParenthesizedExpression(expression)) return labelsOf(expression.expression);
  if (ts.isConditionalExpression(expression)) {
    const whenTrue = labelsOf(expression.whenTrue);
    const whenFalse = labelsOf(expression.whenFalse);
    return whenTrue && whenFalse ? [...whenTrue, ...whenFalse] : null;
  }
  if (ts.isTemplateExpression(expression)) {
    let variants = [expression.head.text];
    for (const span of expression.templateSpans) {
      const inner = labelsOf(span.expression) ?? ["Example"];
      variants = variants.flatMap((prefix) => inner.map((part) => `${prefix}${part}${span.literal.text}`));
    }
    return variants;
  }
  return null;
}

type Use = { file: string; line: number; label: string | null };

function fieldUses(): Use[] {
  const uses: Use[] = [];
  for (const file of [...sourceFiles(join(PORTAL, "components")), ...sourceFiles(join(PORTAL, "app"))]) {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node: ts.Node) => {
      if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && FIELD_COMPONENTS.has(node.tagName.getText(source))) {
        const attribute = node.attributes.properties.find((property): property is ts.JsxAttribute => ts.isJsxAttribute(property) && property.name.getText(source) === "label");
        const initializer = attribute?.initializer;
        const expression = initializer && ts.isJsxExpression(initializer) ? initializer.expression : initializer;
        const labels = expression ? labelsOf(expression as ts.Expression) : null;
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        for (const label of labels ?? [null]) uses.push({ file: relative(PORTAL, file), line, label });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return uses;
}

// Labels that come from data, not from the JSX: each source's labels are checked here.
const DATA_LABEL_SOURCES: Record<string, () => string[]> = {
  "components/schedules/schedules-page.tsx": () => forecastRecord({
    status: "ready", reason: "x", samples: 1, unmeasuredRuns: 0, minSamples: 1,
    window: { from: "2026-01-01T00:00:00Z", to: "2026-01-02T00:00:00Z" }, confidence: "high", runsPerDay: 1,
    estimate: { requestsPerRun: { median: 1, p90: 1, max: 1 }, projectedRequestsPerDay: 1, throttleRatio: 0, throttledRuns: 0, durationMs: { median: 1, p90: 1 }, workloads: {} },
    warnings: [{ code: "x", acknowledged: false }],
    proposal: { cadence: {}, intervalMs: 1, floorMs: 1, cappedAtMaximum: false },
    acknowledgement: { acknowledgedBy: "x", acknowledgedAt: "x", codes: [] },
    presentation: { timeZone: "UTC", runs: [{ at: "x", local: "x" }] },
  } as never).map(([label]) => label),
  "components/servicenow-panel.tsx": () => Object.values(SERVICENOW_FIELD_LABELS),
};

test("every Technical details field has a plain label and a one-line meaning", () => {
  const uses = fieldUses();
  assert.ok(uses.length > 500, `expected the portal's record fields, found ${uses.length}`);
  const missing: string[] = [];
  const checked = new Set<string>();
  for (const use of uses) {
    const labels = use.label === null ? DATA_LABEL_SOURCES[use.file]?.() : [use.label];
    if (!labels) {
      missing.push(`${use.file}:${use.line} builds its label from data; add the source to DATA_LABEL_SOURCES`);
      continue;
    }
    for (const label of labels) {
      if (checked.has(label)) continue;
      checked.add(label);
      const info = fieldInfo(label);
      if (!info || !info.label.trim() || !info.meaning.trim()) missing.push(`${use.file}:${use.line} "${label}" has no plain label in lib/record-glossary.ts`);
    }
  }
  assert.deepEqual(missing, []);
});

test("every glossary entry reads as plain words", () => {
  for (const [key, info] of Object.entries(RECORD_GLOSSARY)) {
    assert.ok(info.label.length <= 48, `${key}: the plain label is short`);
    assert.ok(!/\((ms|s)\)|principal|stored key|natural key|digest|sequence/i.test(info.label), `${key}: "${info.label}" has no raw units or internal words`);
    if (!info.support) assert.ok(!/\bIDs?\b/.test(info.label.replaceAll("Entra ID", "Entra")), `${key}: a plain field does not say ID`);
    assert.ok(info.meaning.length <= 120 && /[.!?]$/.test(info.meaning), `${key}: the meaning is one sentence`);
  }
});

test("a field built from data keeps its item name next to the plain label", () => {
  assert.equal(fieldInfo("Guard refusal · group:finance")?.label, "Blocked by a safety check · group:finance");
  assert.equal(fieldInfo("Write wave 2")?.label, "Write step 2");
  assert.equal(fieldInfo("Field conditions.users.includeUsers")?.label, "Conditions › users › include users");
  assert.equal(fieldInfo("Runs as (account ID)")?.support, true);
  assert.equal(fieldInfo("No such field"), null);
});

test("IDs, sequences and commands are support details", () => {
  for (const label of ["Counted from evidence sequence", "Newest copy evidence sequence", "Job ID", "Read with", "Effects digest", "Stored key"]) {
    assert.equal(fieldInfo(label)?.support, true, label);
  }
  for (const label of ["Recoverable point", "Recoverable point age (ms)", "Status", "Reason"]) {
    assert.notEqual(fieldInfo(label)?.support, true, label);
  }
});

test("values read in plain words with a status colour", () => {
  const age = fieldInfo("Recoverable point age (ms)");
  const unmeasured = shownValue("unmeasured", age);
  assert.equal(unmeasured.kind, "missing");
  assert.equal(unmeasured.kind === "missing" && unmeasured.text, "Not measured yet");
  assert.equal(unmeasured.kind === "missing" && unmeasured.tone, "soon");
  assert.match(unmeasured.kind === "missing" ? unmeasured.why ?? "" : "", /off-site copy/);
  assert.deepEqual(shownValue(3_600_000 * 26 + 60_000 * 5, age), { kind: "text", text: "26 hours 5 minutes", tone: null, cut: false });
  assert.equal(durationWords(450), "450 ms");
  assert.equal(durationWords(90_000_000), "25 hours");
  assert.equal(durationWords(3 * 86_400_000 + 3_600_000), "3 days 1 hour");

  const status = shownValue("failed", fieldInfo("Status"));
  assert.deepEqual(status, { kind: "text", text: "Failed", tone: "urgent", cut: false });
  assert.deepEqual(shownValue("partially-protected", fieldInfo("Status")), { kind: "text", text: "Partially protected", tone: "soon", cut: false });
  assert.deepEqual(shownValue("2026-10-22T09:48:00Z", fieldInfo("Created")), { kind: "text", text: "22 Oct 2026, 09:48 UTC", tone: null, cut: false });
  assert.deepEqual(shownValue(true, fieldInfo("Enabled")), { kind: "text", text: "Yes", tone: "fine", cut: false });
  assert.deepEqual(shownValue("true", fieldInfo("Stopped at the site limit")), { kind: "text", text: "Yes", tone: "soon", cut: false });
  assert.deepEqual(shownValue(3, fieldInfo("Failed")), { kind: "text", text: "3", tone: "soon", cut: false });
  assert.deepEqual(shownValue(0, fieldInfo("Failed")), { kind: "text", text: "0", tone: "fine", cut: false });
  assert.deepEqual(shownValue(12345, fieldInfo("Items")), { kind: "text", text: "12,345", tone: null, cut: false });
  assert.deepEqual(shownValue("modified", fieldInfo("Change type")), { kind: "text", text: "Changed", tone: null, cut: false });
  assert.deepEqual(shownValue("access-affecting", fieldInfo("Blast radius")), { kind: "text", text: "Affects access", tone: "soon", cut: false });
});

test("an error shows one short line; the full text waits for a click", () => {
  const long = `Graph answered 403 Forbidden: Insufficient privileges to complete the operation.\n${"at stack frame\n".repeat(20)}`;
  const shown = shownValue(long, fieldInfo("Full error"));
  assert.equal(shown.kind, "error");
  if (shown.kind !== "error") return;
  assert.equal(shown.line, "Graph answered 403 Forbidden: Insufficient privileges to complete the operation.");
  assert.equal(shown.cut, true);
  assert.equal(shown.full, long);
  assert.equal(shownValue(null, fieldInfo("Last error")).kind, "missing");
});

test("other long values stay short", () => {
  const shown = shownValue("word ".repeat(80), fieldInfo("Reason"));
  assert.equal(shown.kind, "text");
  assert.ok(shown.kind === "text" && shown.text.length <= 161 && shown.cut);
});

test("a comparison marks what differs and counts what matches", () => {
  const changed = compareSides({ displayName: "Finance", state: "enabled", owner: "a" }, { displayName: "Finance", state: "disabled", owner: "a" });
  assert.equal(changed.change, "changed");
  assert.deepEqual(changed.before, [{ label: "State", text: "enabled", differs: true }]);
  assert.deepEqual(changed.after, [{ label: "State", text: "disabled", differs: true }]);
  assert.equal(changed.same, 2);

  const added = compareSides(null, { sharingCapability: "ExternalUserSharingOnly" });
  assert.equal(added.change, "added");
  assert.equal(added.before, null);
  assert.equal(added.after?.[0].differs, true);

  assert.equal(compareSides({ a: 1 }, null).change, "removed");
  assert.equal(compareSides({ a: 1 }, { a: 1 }).change, "same");
});
