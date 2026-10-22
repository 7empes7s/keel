import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { RAW_ERROR_PATTERN, refusalWords } from "@/lib/error-words";

// Pop-up messages never repeat the server's raw answer in plain view. A refusal toast
// passes plain words (refusalWords or the page's own) as detail and todo, and the raw
// answer as `error`, which the toaster keeps behind "Show details".
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

const RAW_DETAIL = /detail:\s*[^,}]*(payload\.(message|error)|\bdata\.(message|error)|\.message\b|Request failed)/;

test("no toast puts the server's raw answer in its plain detail", () => {
  const leaks: string[] = [];
  for (const file of [...sources("components"), ...sources("app")]) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/toast\(\{[\s\S]*?\}\);?/g)) {
      if (RAW_DETAIL.test(match[0])) leaks.push(`${file}: ${match[0].replace(/\s+/g, " ").slice(0, 160)}`);
    }
  }
  assert.deepEqual(leaks, [], "pass raw server text as `error`, with plain words in `detail` and `todo`");
});

test("refusal words are plain and always give a next step", () => {
  for (const status of [0, 400, 401, 403, 404, 409, 422, 500, 503]) {
    const words = refusalWords(status);
    assert.ok(words.cause && words.todo, `status ${status}`);
    assert.doesNotMatch(`${words.cause} ${words.todo}`, RAW_ERROR_PATTERN);
    assert.doesNotMatch(`${words.cause} ${words.todo}`, /\b\d{3}\b/);
  }
});
