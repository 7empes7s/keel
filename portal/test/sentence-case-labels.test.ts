// Detail labels (<dt>) are sentence case everywhere. A CSS rule that uppercases
// them turns "Last backup" into "LAST BACKUP", which is harder to read.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = join(__dirname, "..");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(css|tsx?)$/.test(name) ? [path] : [];
  });
}

test("no CSS rule uppercases detail labels", () => {
  const offenders: string[] = [];
  for (const file of [...files(join(root, "app")), ...files(join(root, "components"))]) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
      const selectors = match[1].split(",").map((s) => s.trim());
      const targetsDt = selectors.some((s) => /(^|[\s>+~])dt(?![\w-])[^\s>+~]*$/.test(s));
      if (targetsDt && /text-transform:\s*uppercase/.test(match[2])) {
        const line = source.slice(0, match.index).split("\n").length;
        offenders.push(`${file.slice(root.length + 1)}:${line} ${selectors.join(", ")}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});
