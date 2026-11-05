import test from "node:test";
import assert from "node:assert/strict";
import {
  NEW_FILE_MAX_LINES,
  compare,
  countEslint,
  countKnip,
  countLines,
  lineLimit,
  lowerBaseline,
  serialize,
} from "./ratchet.mjs";

const baseline = {
  eslint: { "engine/a.mjs": { "no-unused-vars": 2, eqeqeq: 1 } },
  knip: { "portal/lib/x.ts": { exports: 3 } },
  lines: { "engine/big.mjs": 1000 },
};

test("a new violation anywhere is a regression; a fixed one is an improvement", () => {
  const current = {
    eslint: {
      "engine/a.mjs": { "no-unused-vars": 1, eqeqeq: 1 },
      "engine/b.mjs": { "@typescript-eslint/no-floating-promises": 1 },
    },
    knip: { "portal/lib/x.ts": { exports: 4 } },
    lines: { "engine/big.mjs": 1000 },
  };
  const { regressions, improvements } = compare(baseline, current);
  assert.deepEqual(
    regressions.map((e) => [e.section, e.file, e.key, e.baseline, e.current]),
    [
      ["eslint", "engine/b.mjs", "@typescript-eslint/no-floating-promises", 0, 1],
      ["knip", "portal/lib/x.ts", "exports", 3, 4],
    ],
  );
  assert.deepEqual(
    improvements.map((e) => [e.file, e.key, e.current]),
    [["engine/a.mjs", "no-unused-vars", 1]],
  );
});

test("file sizes: baselined files may grow 5%, all others stop at the new-file limit", () => {
  assert.equal(lineLimit(undefined), NEW_FILE_MAX_LINES);
  assert.equal(lineLimit(1000), 1050);
  assert.equal(lineLimit(801), 841); // floor(801 * 1.05)

  const ok = compare(baseline, { eslint: {}, knip: {}, lines: { "engine/big.mjs": 1050, "engine/new.mjs": 800 } });
  assert.deepEqual(ok.regressions, []);

  const bad = compare(baseline, { eslint: {}, knip: {}, lines: { "engine/big.mjs": 1051, "engine/new.mjs": 801 } });
  assert.deepEqual(
    bad.regressions.map((e) => [e.file, e.current, e.limit]),
    [
      ["engine/big.mjs", 1051, 1050],
      ["engine/new.mjs", 801, 800],
    ],
  );
});

test("update only lowers the baseline and drops what reached zero", () => {
  const current = {
    eslint: { "engine/a.mjs": { "no-unused-vars": 5 }, "engine/b.mjs": { eqeqeq: 4 } },
    knip: {},
    lines: { "engine/big.mjs": 900, "engine/other.mjs": 2000 },
  };
  assert.deepEqual(lowerBaseline(baseline, current), {
    eslint: { "engine/a.mjs": { "no-unused-vars": 2 } },
    knip: {},
    lines: { "engine/big.mjs": 900 },
  });
  // A file that shrinks to the limit leaves the size baseline; it then keeps to the limit.
  assert.deepEqual(lowerBaseline(baseline, { lines: { "engine/big.mjs": 800 } }).lines, {});
});

test("update --reset takes today's counts and tracks only files over the limit", () => {
  const current = {
    eslint: { "z.mjs": { b: 1, a: 2 } },
    knip: {},
    lines: { "small.mjs": 10, "large.mjs": 900 },
  };
  assert.deepEqual(lowerBaseline(baseline, current, { reset: true }), {
    eslint: { "z.mjs": { a: 2, b: 1 } },
    knip: {},
    lines: { "large.mjs": 900 },
  });
});

test("serialize is deterministic whatever the key order", () => {
  const a = { lines: { "b.mjs": 900, "a.mjs": 901 }, eslint: { "y.mjs": { r2: 1, r1: 1 } }, knip: {} };
  const b = { knip: {}, eslint: { "y.mjs": { r1: 1, r2: 1 } }, lines: { "a.mjs": 901, "b.mjs": 900 } };
  assert.equal(serialize(a), serialize(b));
  assert.equal(serialize(a), serialize(JSON.parse(serialize(a))));
  assert.ok(serialize(a).indexOf('"eslint"') < serialize(a).indexOf('"knip"'));
  assert.ok(serialize(a).indexOf('"a.mjs"') < serialize(a).indexOf('"b.mjs"'));
  assert.ok(serialize(a).endsWith("}\n"));
});

test("counts ESLint and knip output per file and per rule", () => {
  const eslint = countEslint(
    [
      { filePath: "/repo/engine/a.mjs", messages: [{ ruleId: "eqeqeq" }, { ruleId: "eqeqeq" }, { ruleId: null }] },
      { filePath: "/repo/portal/b.ts", messages: [] },
    ],
    "/repo",
  );
  assert.deepEqual(eslint, { "engine/a.mjs": { eqeqeq: 2, "parse-error": 1 } });

  const knip = countKnip({
    issues: [
      { file: "engine/a.mjs", exports: [{ name: "x" }, { name: "y" }], types: [], files: [] },
      { file: "portal/dead.tsx", files: [{ name: "portal/dead.tsx" }], exports: [] },
    ],
  });
  assert.deepEqual(knip, { "engine/a.mjs": { exports: 2 }, "portal/dead.tsx": { files: 1 } });
});

test("countLines matches wc -l, counting a last line without a newline", () => {
  assert.equal(countLines(""), 0);
  assert.equal(countLines("a\n"), 1);
  assert.equal(countLines("a\nb"), 2);
  assert.equal(countLines("a\nb\n"), 2);
});
