import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { createIsolatedTestDatabase } from "../../engine/test/dbTestHelper.mjs";
import { schemaSql } from "../../engine/store/loadSchema.mjs";
import { guardedIntegrationList, type DestinationStatus } from "@/lib/integrations";
import { CAPABILITIES_HEADER, PRINCIPAL_ID_HEADER } from "@/lib/principal";

type TestClient = { query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>; end(): Promise<void> };

const TENANT = "integrations-list-test";

test("the integrations list reads each destination's status one after another on its one connection", async () => {
  if (!process.env.KEEL_DB_TEST_URL) {
    for (const line of readFileSync("/etc/keel/db.env", "utf8").split("\n")) {
      const match = /^KEEL_DB_TEST_URL=(.*)$/.exec(line.trim());
      if (match) process.env.KEEL_DB_TEST_URL = match[1];
    }
  }
  const database = (await createIsolatedTestDatabase(import.meta.url)) as { url: string; connect(): Promise<TestClient>; cleanup(): Promise<void> };
  const setup = await database.connect();
  try {
    await setup.query(schemaSql());
    const { rows: [person] } = await setup.query("INSERT INTO principal (email) VALUES ('integrations-viewer@example.invalid') RETURNING id::text AS id");
    const viewer = String(person.id);
    await setup.query("INSERT INTO role_grant (principal_id, role) VALUES ($1, 'viewer')", [viewer]);
    for (const [name, kind, config] of [
      ["KEEL-RT-webhook", "webhook", { url: "https://sink.example.test/ingest" }],
      ["KEEL-RT-cef", "cef", { transport: "udp", host: "127.0.0.1", port: 5514, acknowledgement: "none" }],
      ["KEEL-RT-webhook-2", "webhook", { url: "https://sink.example.test/other" }],
    ] as const) {
      await setup.query(
        "INSERT INTO siem_destination (tenant_ref, name, kind, config, created_by) VALUES ($1, $2, $3, $4, $5)",
        [TENANT, name, kind, JSON.stringify(config), viewer],
      );
    }

    // One connection runs one query at a time: pg warns (and pg 9 will refuse) when a
    // second query is sent before the first has answered.
    let running = 0;
    let mostAtOnce = 0;
    let route: TestClient | null = null;
    const list = guardedIntegrationList({
      connect: async () => {
        const client = await database.connect();
        route = client;
        return {
          query(...args: Parameters<TestClient["query"]>) {
            running += 1;
            mostAtOnce = Math.max(mostAtOnce, running);
            return client.query(...args).finally(() => { running -= 1; });
          },
          end: () => client.end(),
        };
      },
      databaseUrl: () => database.url,
      tenantRef: () => TENANT,
    });
    const response = await list(new Request("http://localhost/api/integrations", {
      headers: { [PRINCIPAL_ID_HEADER]: viewer, [CAPABILITIES_HEADER]: "read" },
    }));
    assert.ok(route, "the route connected");
    assert.equal(response.status, 200);
    const body = await response.json() as { destinations: { id: string }[]; statuses: DestinationStatus[] };
    assert.equal(body.destinations.length, 3);
    assert.deepEqual(body.statuses.map((status) => status.destinationId), body.destinations.map((destination) => destination.id), "one status per destination, in order");
    assert.equal(mostAtOnce, 1, "queries overlapped on one connection");
  } finally {
    await setup.end();
    await database.cleanup();
  }
});
