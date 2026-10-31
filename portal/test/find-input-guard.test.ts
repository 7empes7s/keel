import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

// A text box bound straight to the address loses keys: the address catches up a moment
// after each key, so the box is redrawn with the old text ("emergency" left "y"). Every
// Find box that keeps its search in the address uses FindInput, which shows each key
// at once and writes the address when typing pauses. This scans the portal so a new
// list cannot go back to a plain bound input.

const ROOT = join(import.meta.dirname, "..");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name.startsWith(".")) return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith(".tsx") ? [path] : [];
  });
}

const sources = ["app", "components"].flatMap((dir) => files(join(ROOT, dir))).map((path) => ({ path: relative(ROOT, path), text: readFileSync(path, "utf8") }));

test("no text box writes the address on every key", () => {
  for (const { path, text } of sources) {
    for (const match of text.matchAll(/<(input|textarea)\b[\s\S]*?\/>/g)) {
      assert.doesNotMatch(match[0], /onChange=\{[^}]*\bview\.set\(/, `${path}: a box bound to the address drops keys. Use FindInput from components/list/find-input.`);
    }
  }
});

test("the shared lists and every Find box use FindInput", () => {
  const finds = sources.filter(({ text }) => /<span className="picker-label">Find<\/span>/.test(text));
  assert.ok(finds.length >= 5, "the scan finds the Find boxes");
  for (const { path, text } of finds) assert.match(text, /<FindInput\b/, `${path}: its Find box uses FindInput`);
});
