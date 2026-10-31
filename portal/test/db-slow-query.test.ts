import assert from "node:assert/strict";
import { mock, test } from "node:test";

import { createIsolatedTestDatabase } from "../../engine/test/dbTestHelper.mjs";
import { connect, queryLabel, SLOW_QUERY_MS } from "@/lib/db";

// Live has no request timings, so a statement slower than SLOW_QUERY_MS is logged with
// its first words and time: enough to find which read makes a page slow, never a value.
test("a slow statement is logged with its time and first words, not its values", async () => {
  const db = await createIsolatedTestDatabase(import.meta.url);
  const warn = mock.method(console, "warn", () => {});
  try {
    const client = await connect(db.url);
    try {
      await client.query("SELECT 1 AS fast WHERE $1::text IS NOT NULL", ["fast-secret"]);
      assert.equal(warn.mock.callCount(), 0);
      await client.query(`SELECT pg_sleep(${(SLOW_QUERY_MS + 100) / 1000}),
                                 $1::text AS value`, ["slow-secret"]);
    } finally {
      await client.end();
    }
    assert.equal(warn.mock.callCount(), 1);
    const line = String(warn.mock.calls[0].arguments[0]);
    assert.match(line, /^\[keel-portal\] slow query \d+ ms: SELECT pg_sleep\(1\.1\), \$1::text AS value$/);
    assert.ok(!line.includes("slow-secret"));
  } finally {
    warn.mock.restore();
    await db.cleanup();
  }
});

test("a statement's label is one line and at most 120 characters", () => {
  assert.equal(queryLabel("  SELECT a,\n\t b  FROM t  "), "SELECT a, b FROM t");
  assert.equal(queryLabel(`SELECT ${"x".repeat(300)}`).length, 120);
});

// A read the planner over-estimates crossed jit_above_cost and spent most of a second
// compiling before it ran; the portal's connections never JIT-compile.
test("portal connections run with JIT compilation off", async () => {
  const db = await createIsolatedTestDatabase(import.meta.url);
  try {
    const client = await connect(db.url);
    try {
      const { rows } = (await client.query("SHOW jit")) as { rows: { jit: string }[] };
      assert.equal(rows[0].jit, "off");
    } finally {
      await client.end();
    }
  } finally {
    await db.cleanup();
  }
});
