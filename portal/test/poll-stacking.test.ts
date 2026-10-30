import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { test } from "node:test";

import { shouldPoll } from "@/lib/use-poll";

// "Keel is busy" (2026-10-30): pages that refreshed themselves on a bare timer started a
// new server render every few seconds even while the last one was still loading, and in
// hidden tabs too. During long jobs those renders stacked up and held all 8 database
// connections. Every timed refresh now goes through lib/use-poll.ts, which skips hidden
// tabs and never starts a read while the previous one is still running.

const PORTAL = resolve(__dirname, "..");

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(directory)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const path = join(directory, name);
    if (statSync(path).isDirectory()) files.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(name)) files.push(path);
  }
  return files;
}

test("a poll runs only in a visible tab with no read still running", () => {
  assert.equal(shouldPoll("visible", false), true);
  assert.equal(shouldPoll("visible", true), false);
  assert.equal(shouldPoll("hidden", false), false);
  assert.equal(shouldPoll("hidden", true), false);
});

test("no page refreshes itself on a bare timer", () => {
  const offenders: string[] = [];
  for (const directory of ["app", "components", "lib"]) {
    for (const path of sourceFiles(join(PORTAL, directory))) {
      const source = readFileSync(path, "utf8");
      // A timer or poll whose callback is router.refresh() stacks refreshes; use useRefreshPoll.
      if (/(?:setInterval|usePoll)\(\s*\(\)\s*=>\s*(?:\{\s*)?router\.refresh\(\)/.test(source)) {
        offenders.push(relative(PORTAL, path));
      }
    }
  }
  assert.deepEqual(offenders, []);
});
