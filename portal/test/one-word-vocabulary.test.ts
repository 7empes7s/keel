// One word per idea (UI audit D10): the portal says "setting", "setting type",
// "content item" and "backup", never "resource", "kind", "item" or "snapshot" for
// the same things. The banned words come from the "One word per idea" table in
// docs/roadmap/portal-experience.md, so the doc and this test cannot drift apart.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

import ts from "typescript";

const portal = join(__dirname, "..");
const doc = readFileSync(join(portal, "..", "docs", "roadmap", "portal-experience.md"), "utf8");

function vocabulary(): { banned: string[]; allowed: string[] } {
  const section = doc.split("### One word per idea")[1]?.split("\nWords that must not appear")[0] ?? "";
  const rows = section.split("\n").filter((line) => line.startsWith("| ") && !line.startsWith("| Idea") && !line.startsWith("|---"));
  const banned = rows.flatMap((row) => row.split("|")[3].split(",").map((word) => word.trim()).filter(Boolean));
  const fixed = section.split("Fixed phrases that keep a banned word:")[1] ?? "";
  const allowed = [...fixed.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  return { banned, allowed };
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.tsx?$/.test(name) && !name.endsWith(".d.ts") ? [path] : [];
  });
}

// Attributes that never reach a reader as words.
const CODE_ATTRIBUTES = new Set(["className", "id", "key", "href", "htmlFor", "name", "type", "role", "method", "action", "src", "rel", "target", "form", "autoComplete", "inputMode"]);

function looksLikeCode(text: string): boolean {
  return /\b(SELECT|INSERT INTO|UPDATE|DELETE FROM|WHERE|JOIN)\b/.test(text) // SQL
    || /[{}][^]*:[^]*;/.test(text) // CSS
    || /^\[keel-portal\]/.test(text) // server log lines
    || /^\/?[\w.-]+(\/[\w.:-]+)+\/?$/.test(text.trim()); // paths and routes
}

// A one-word string that a count is put in front of: plural(n, "kind"),
// n === 1 ? "kind" : "kinds", or noun={{ one: "kind", many: "kinds" }}.
function countedNoun(node: ts.Node): boolean {
  const parent = node.parent;
  // A branch of a count (n === 1 ? "kind" : "kinds"), not a code mapping (source === "x" ? "x" : "y").
  if (ts.isConditionalExpression(parent)) return node !== parent.condition && !/[=!]==?\s*["'`]|["'`]\s*[=!]==?/.test(parent.condition.getText());
  if (ts.isCallExpression(parent)) return /plural|count/i.test(parent.expression.getText()) && parent.arguments.indexOf(node as ts.Expression) > 0;
  if (ts.isPropertyAssignment(parent)) return ["one", "many"].includes(parent.name.getText());
  if (ts.isParameter(parent) || ts.isJsxAttribute(parent)) return parent.name.getText() === "noun";
  return false;
}

// Every piece of text a reader can see: JSX text and the strings and template parts
// that read as words (a space between words, or a capitalised word).
function uiStrings(file: string): { line: number; text: string }[] {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: { line: number; text: string }[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (ts.isJsxAttribute(node) && CODE_ATTRIBUTES.has(node.name.getText(source))) return;
    // data-label is read out on phones (content: attr(data-label)); other data-* are codes.
    if (ts.isJsxAttribute(node) && node.name.getText(source).startsWith("data-") && node.name.getText(source) !== "data-label") return;
    let text: string | null = null;
    if (ts.isJsxText(node)) text = node.text;
    else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      const part = ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node);
      text = /[A-Za-z] [A-Za-z]|^\s*[A-Z][a-z]/.test(node.text) || (part && /^\s+[a-z]|[a-z]\s+$/.test(node.text)) || countedNoun(node) ? node.text : null;
    }
    if (text && text.trim() && !looksLikeCode(text)) {
      found.push({ line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, text: text.replace(/\s+/g, " ").trim() });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const word = (term: string) => new RegExp(`(?<![\\w-])${term.replace(/ /g, "\\s+")}s?(?![\\w-])`, "gi");

test("the doc's one-word table names the banned words and the fixed phrases", () => {
  const { banned, allowed } = vocabulary();
  for (const term of ["resource", "object", "kind", "configuration type", "item", "snapshot"]) assert.ok(banned.includes(term), term);
  assert.ok(allowed.includes("object ID") && allowed.includes("deleted items"), allowed.join(", "));
});

test("no UI string uses a banned word for an idea that has one word", () => {
  const { banned, allowed } = vocabulary();
  const offenders: string[] = [];
  for (const file of ["app", "components", "lib"].flatMap((dir) => files(join(portal, dir)))) {
    for (const { line, text } of uiStrings(file)) {
      const cleared = allowed.reduce((rest, phrase) => rest.replace(word(phrase), " "), text);
      for (const term of banned) {
        const match = cleared.match(word(term));
        if (match) offenders.push(`${relative(portal, file)}:${line} "${match[0]}" in: ${text.slice(0, 120)}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `say "setting", "setting type", "content item" or "backup" instead:\n${offenders.join("\n")}`);
});

test("the check catches a banned word and lets a fixed phrase through", () => {
  const { banned, allowed } = vocabulary();
  const flag = (text: string) => {
    const cleared = allowed.reduce((rest, phrase) => rest.replace(word(phrase), " "), text);
    return banned.filter((term) => word(term).test(cleared));
  };
  assert.deepEqual(flag("4,590 settings in 6 kinds"), ["kind"]);
  assert.deepEqual(flag("Restore from the snapshot of 3 May"), ["snapshot"]);
  assert.deepEqual(flag("Unnamed item"), ["item"]);
  assert.deepEqual(flag("Backup of every configuration type"), ["configuration type"]);
  assert.deepEqual(flag("Bring it back from Deleted items"), []);
  assert.deepEqual(flag("Account object ID"), []);
  assert.deepEqual(flag("4,590 settings in 6 setting types"), []);
});
