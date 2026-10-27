import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { ActionRequestError, postAction } from "@/lib/action-client";
import { plainRefusal } from "@/lib/action-refusal";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const SETTINGS = "Keel's restore settings file must be a .json file in /etc/keel. Ask whoever runs the Keel server to fix KEEL_COLLECTOR_CONFIG_PATH.";

test("only a restore settings refusal carries the server's words to the page", () => {
  assert.equal(plainRefusal({ error: "restore_settings_path", message: SETTINGS }), SETTINGS);
  assert.equal(plainRefusal({ error: "unavailable", message: "stack trace" }), null);
  assert.equal(plainRefusal({ error: "restore_settings_path" }), null);
  assert.equal(plainRefusal(null), null);
  assert.equal(plainRefusal("text"), null);
});

test("a refused action throws with its status and any plain reason", async () => {
  globalThis.fetch = (async () => Response.json({ error: "restore_settings_path", message: SETTINGS }, { status: 503 })) as typeof fetch;
  await assert.rejects(postAction("/api/actions/restore/dry-run", {}, "k1"), (error) => {
    assert.ok(error instanceof ActionRequestError);
    assert.equal(error.status, 503);
    assert.equal(error.plain, SETTINGS);
    return true;
  });
  globalThis.fetch = (async () => new Response("not json", { status: 500 })) as typeof fetch;
  await assert.rejects(postAction("/api/actions/restore/dry-run", {}, "k2"), (error) => {
    assert.ok(error instanceof ActionRequestError);
    assert.equal(error.plain, null);
    return true;
  });
});
