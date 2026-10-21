import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";

// A server component cannot call a function exported from a "use client" module:
// on the server that import is only a client reference, and Next.js throws
// "Attempted to call X() from the server but X is on the client" while rendering.
// The unit tests and the UI harness render everything as client code, so they never
// see it; on the live portal the page shows "This page could not be rendered".
// This happened to Restore, What's protected, Baselines and the job pages when the
// job list (a server component) called refUsage() from components/technical-details.
//
// So: a module without "use client" may import components (Capitalised) and types
// from a "use client" module, never a lowercase value such as a helper or a hook.
// Shared helpers belong in a plain module under lib/.

const PORTAL = resolve(__dirname, "..");
const SOURCE_DIRS = ["app", "components", "lib"];

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(directory)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const path = join(directory, name);
    if (statSync(path).isDirectory()) files.push(...sourceFiles(path));
    else if (/\.(tsx?|mjs)$/.test(name)) files.push(path);
  }
  return files;
}

function isClientModule(path: string): boolean {
  return /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*["']use client["']/.test(readFileSync(path, "utf8"));
}

function resolveImport(from: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = join(PORTAL, specifier.slice(2));
  else if (specifier.startsWith(".")) base = resolve(dirname(from), specifier);
  else return null;
  for (const candidate of [base, `${base}.tsx`, `${base}.ts`, join(base, "index.tsx"), join(base, "index.ts")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Every lowercase value a non-client module imports from a "use client" module. */
function serverCallsIntoClient(files: string[]): string[] {
  const found: string[] = [];
  for (const file of files) {
    if (isClientModule(file)) continue;
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s+from\s+["']([^"']+)["']/g)) {
      if (match[1]) continue;
      const target = resolveImport(file, match[3]);
      if (!target || !isClientModule(target)) continue;
      const names = match[2]
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part && !part.startsWith("type "))
        .map((part) => part.split(/\s+as\s+/)[0]);
      for (const name of names.filter((value) => /^[a-z_$]/.test(value))) {
        found.push(`${relative(PORTAL, file)} imports ${name}() from "use client" ${relative(PORTAL, target)}`);
      }
    }
  }
  return found;
}

test("server components never call a function from a \"use client\" module", () => {
  const files = SOURCE_DIRS.flatMap((directory) => sourceFiles(join(PORTAL, directory)));
  assert.ok(files.length > 50, "found the portal sources");
  assert.deepEqual(serverCallsIntoClient(files), []);
});

test("the job list reads refUsage from a plain module, not the client panel", () => {
  const jobTable = join(PORTAL, "components", "job-table.tsx");
  assert.equal(isClientModule(jobTable), false, "the job list is a server component");
  assert.equal(isClientModule(join(PORTAL, "components", "technical-details.tsx")), true);
  assert.equal(isClientModule(join(PORTAL, "lib", "record-refs.ts")), false);
  assert.match(readFileSync(jobTable, "utf8"), /import \{ refUsage \} from "@\/lib\/record-refs"/);
});
