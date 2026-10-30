import assert from "node:assert/strict";
import { test } from "node:test";

import { createIsolatedTestDatabase } from "../../engine/test/dbTestHelper.mjs";
import { connect, DatabaseBusyError, leaseSummary, POOL_MAX, POOL_WAIT_MS, type DbClient } from "@/lib/db";

// When every pooled connection is in use, the next caller gives up after POOL_WAIT_MS
// with a clear error instead of waiting forever, and the pool works again once a
// connection is returned.
test("a full pool fails the next wait after the timeout instead of hanging, then recovers", async () => {
  const db = await createIsolatedTestDatabase(import.meta.url);
  const held: DbClient[] = [];
  try {
    for (let i = 0; i < POOL_MAX; i++) held.push(await connect(db.url));

    const started = Date.now();
    await assert.rejects(connect(db.url), (error: unknown) => {
      assert.ok(error instanceof DatabaseBusyError);
      assert.match((error as Error).message, /no free connection within 5 seconds/);
      return true;
    });
    const waited = Date.now() - started;
    assert.ok(waited >= POOL_WAIT_MS - 100, `gave up too early: ${waited} ms`);
    assert.ok(waited < POOL_WAIT_MS + 2_000, `waited too long: ${waited} ms`);

    await held.pop()!.end();
    const next = await connect(db.url);
    assert.deepEqual(((await next.query("SELECT 1 AS n")) as { rows: unknown[] }).rows, [{ n: 1 }]);
    await next.end();
  } finally {
    await Promise.all(held.map((client) => client.end()));
    await db.cleanup();
  }
});

// A full pool says how many connections are out and how long the oldest has been held,
// so the log tells a burst of requests apart from a connection that was never returned.
test("held connections are counted until they are returned", async () => {
  const db = await createIsolatedTestDatabase(import.meta.url);
  try {
    const before = leaseSummary().held;
    const first = await connect(db.url);
    const second = await connect(db.url);
    const held = leaseSummary();
    assert.equal(held.held, before + 2);
    assert.ok((held.oldestMs ?? -1) >= 0);
    await first.end();
    await first.end(); // a second end() is ignored, not a second release
    assert.equal(leaseSummary().held, before + 1);
    await second.end();
    assert.equal(leaseSummary().held, before);
  } finally {
    await db.cleanup();
  }
});
