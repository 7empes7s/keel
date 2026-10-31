// The 31 Oct burst: a full database pool made every guarded route throw an uncaught 500,
// so the bulk accept could not tell "busy, try again" from "failed". A full pool is now a
// 503 "busy" answer, which lib/send-each.ts retries.
import assert from "node:assert/strict";
import { test } from "node:test";

import { guarded, guardedDispose } from "@/lib/action";
import { BUSY_MESSAGE, BUSY_RETRY_SECONDS, DatabaseBusyError } from "@/lib/db";
import { CAPABILITIES_HEADER, PRINCIPAL_ID_HEADER } from "@/lib/principal";

const busyDeps = {
  connect: async () => { throw new DatabaseBusyError(new Error("timeout exceeded when trying to connect")); },
  databaseUrl: () => "postgres://unused",
  tenantRef: () => "sha256:busy-test",
};

function post(): Request {
  return new Request("http://keel.test/api/actions/dispose", {
    method: "POST",
    headers: { "content-type": "application/json", [PRINCIPAL_ID_HEADER]: "principal-operator", [CAPABILITIES_HEADER]: "dispose-accept" },
    body: JSON.stringify({ driftId: "d1", action: "accept", reason: "r" }),
  });
}

test("a full pool answers 503 busy, with a retry-after, never an uncaught error", async () => {
  let ran = false;
  const route = guarded({ action: "probe" }, async () => { ran = true; return Response.json({}); }, busyDeps);
  const response = await route(post());
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), String(BUSY_RETRY_SECONDS));
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { error: "busy", message: BUSY_MESSAGE });
  assert.equal(ran, false);

  const dispose = await guardedDispose(busyDeps)(post());
  assert.equal(dispose.status, 503);
  assert.equal((await dispose.json()).error, "busy");
});

test("any other connection failure still throws as before", async () => {
  const route = guarded({ action: "probe" }, async () => Response.json({}), {
    ...busyDeps, connect: async () => { throw new Error("connection refused"); },
  });
  await assert.rejects(route(post()), /connection refused/);
});
