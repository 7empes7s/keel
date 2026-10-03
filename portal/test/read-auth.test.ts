import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  DATA_SURFACES,
  guardedRead,
  readAccess,
  type DataSurface,
} from "@/lib/read";
import { CAPABILITIES_HEADER, PRINCIPAL_ID_HEADER } from "@/lib/principal";

// Task 34 intentionally gives the approval inbox its own approve-only contract:
// a pure approver must not need general tenant-data read access. Its own closed
// inventory lives in approvals.test.ts, so the read inventory excludes only these
// two explicitly named non-read surfaces.
const NON_READ_SURFACES = new Set([
  "approvals/page.tsx",
  "api/approvals/route.ts",
]);

function getRequest(
  principalId: string | null,
  capabilities: string[],
): Request {
  const headers = new Headers();
  if (principalId) headers.set(PRINCIPAL_ID_HEADER, principalId);
  headers.set(CAPABILITIES_HEADER, capabilities.join(" "));
  return new Request("http://localhost/api/tenant-data", { headers });
}

async function responseFor(
  surface: DataSurface,
  request: Request,
): Promise<{ response: Response; loaderCalls: () => number }> {
  let calls = 0;
  const route = guardedRead(surface, async () => {
    calls += 1;
    return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  });
  return { response: await route(request), loaderCalls: () => calls };
}

test("a disabled principal and a principal without read are refused before their loaders run", async () => {
  for (const [label, principalId, capabilities] of [
    ["disabled", "principal-disabled", []],
    ["without-read", "principal-operator", ["collect"]],
  ] as const) {
    const { response, loaderCalls } = await responseFor(
      DATA_SURFACES.driftApi,
      getRequest(principalId, [...capabilities]),
    );
    assert.equal(response.status, 403, label);
    assert.equal(response.headers.get("cache-control"), "no-store", label);
    assert.deepEqual(await response.json(), { error: "forbidden" }, label);
    assert.equal(loaderCalls(), 0, `${label} must not invoke the loader`);
  }
});

test("a read grant without a principal identifier is refused before its loader runs", async () => {
  const request = getRequest(null, ["read"]);

  assert.equal(readAccess(request.headers, DATA_SURFACES.driftApi), null);

  const { response, loaderCalls } = await responseFor(
    DATA_SURFACES.driftApi,
    request,
  );
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { error: "forbidden" });
  assert.equal(loaderCalls(), 0, "a missing principal must not invoke the loader");
});

test("the declared capability reads each data surface and an expired grant reads none", async () => {
  for (const [name, surface] of Object.entries(DATA_SURFACES)) {
    const current = await responseFor(
      surface,
      getRequest("principal-authorized", [surface.capability]),
    );
    assert.equal(current.response.status, 200, `${name}: current viewer`);
    assert.equal(current.loaderCalls(), 1, `${name}: current viewer loader`);

    // Principal resolution excludes expired grants from the downstream capabilities
    // header, so this is the same request shape an expired viewer reaches here with.
    const expired = await responseFor(
      surface,
      getRequest("principal-viewer", []),
    );
    assert.equal(expired.response.status, 403, `${name}: expired viewer`);
    assert.equal(expired.loaderCalls(), 0, `${name}: expired viewer loader`);
  }
});

function appSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? appSources(path) : [path];
  });
}

test("the route and page inventory is closed around each declared capability", () => {
  const appDirectory = fileURLToPath(new URL("../app/", import.meta.url));
  const sources = appSources(appDirectory)
    .filter((path) => path.endsWith("page.tsx") || path.endsWith("route.ts"));
  const relativeSource = (path: string) => relative(appDirectory, path).replaceAll("\\", "/");
  const declared = Object.entries(DATA_SURFACES);
  const declaredBySource = new Map<string, { name: string; surface: DataSurface }>(
    declared.map(([name, surface]) => [surface.source, { name, surface }]),
  );

  for (const [name, surface] of declared) {
    assert.equal(surface.capability, surface.source.includes("principals") ? (["principalGrantApi", "principalRevokeApi"].includes(name) ? "roles" : "users") : surface.source.includes("policies") ? "policies" : ["channelsApi", "subscriptionsApi", "setupApi", "setupPage"].includes(name) ? "configuration" : "read", `${name} must require its designated capability`);
  }

  const pages = sources
    .filter((path) => path.endsWith("page.tsx"))
    .map(relativeSource)
    .filter((source) => !NON_READ_SURFACES.has(source))
    .sort();
  const declaredPages = declared
    .map(([, surface]) => surface.source)
    .filter((source) => source.endsWith("page.tsx"))
    .sort();
  assert.deepEqual(declaredPages, pages, "every server-rendered page must declare read");

  const getRoutes = sources
    .filter((path) => {
      if (!path.endsWith("route.ts")) return false;
      return /export\s+(?:async\s+)?(?:function|const)\s+GET\b/.test(
        readFileSync(path, "utf8"),
      );
    })
    .map(relativeSource)
    .filter((source) => !NON_READ_SURFACES.has(source))
    .filter((source) => source !== "api/health/route.ts")
    .sort();
  const declaredGetRoutes = declared
    .map(([, surface]) => surface.source)
    .filter((source) => getRoutes.includes(source))
    .sort();
  assert.deepEqual(
    declaredGetRoutes,
    getRoutes,
    "every data GET must declare read; health is the sole public exception",
  );

  assert.deepEqual(
    declared.map(([, surface]) => surface.source).filter((source) => source.startsWith("api/policies/")).sort(),
    sources.map(relativeSource).filter((source) => source.startsWith("api/policies/")).sort(),
    "every policy route, including write-only routes, must declare policies",
  );

  assert.deepEqual(
    declared.map(([, surface]) => surface.source).filter((source) => source.startsWith("api/principals/")).sort(),
    sources.map(relativeSource).filter((source) => source.startsWith("api/principals/")).sort(),
    "every principal write must be inventoried",
  );
  assert.deepEqual(
    declared.map(([, surface]) => surface.source).filter((source) => source.endsWith("/selection/route.ts")).sort(),
    sources.map(relativeSource).filter((source) => source.endsWith("/selection/route.ts")).sort(),
    "every POST selection preview must be inventoried",
  );
  for (const path of sources) {
    const source = relativeSource(path);
    const declaration = declaredBySource.get(source);
    if (!declaration) continue;
    const content = readFileSync(path, "utf8");
    const reference = `DATA_SURFACES.${declaration.name}`;
    assert.ok(content.includes(reference), `${source} must declare ${reference}`);
    if (source.endsWith("page.tsx")) {
      assert.match(
        content,
        new RegExp(`await\\s+requireReadAccess\\(\\s*${reference}\\s*\\)`),
        `${source} must invoke its declared read guard before its loader`,
      );
      if (["jobsPage", "jobPage", "policiesPage", "policyPage", "notificationsPage", "principalsPage", "evidencePage", "schedulesPage", "activityPage"].includes(declaration.name)) {
        const guard = content.indexOf(`await requireReadAccess(${reference})`);
        // Task-130: /jobs and /evidence now redirect into Activity — after the guard.
        const loader = content.search(/await load(?:Jobs?|Polic(?:y|ies)|Deliveries|Principals|Evidence|Schedules)\(|redirect\(/);
        assert.ok(loader > guard, `${source} must guard before its API loader`);
      }
    } else if (/api\/principals\/\[id\]\//.test(source)) {
      assert.ok(content.includes(`export const POST = guardedPrincipalWrite(`));
      assert.ok(content.includes(`, ${reference})`));
    } else if (source === "api/policies/[id]/enabled/route.ts" || source === "api/policies/[id]/clear-pause/route.ts") {
      assert.match(content, new RegExp(`export\\s+const\\s+POST\\s*=\\s+guardedPolicyUpdate\\([^,]+,\\s*${reference}\\)`));
    } else {
      if (source === "api/schedules/route.ts") {
        assert.match(content, /export const POST = guardedScheduleUpdate\(\)/);
        const actions = readFileSync(new URL("../lib/action.ts", import.meta.url), "utf8");
        assert.match(actions.slice(actions.indexOf("export function guardedScheduleUpdate")), /return guarded\(\s*\{ action: "schedules:update", capability: "configuration", recordAttempt: true \}/);
      }
      if (source === "api/policies/route.ts") {
        assert.match(content, /export const POST = guardedPolicyCreate\(DATA_SURFACES.policiesApi\)/);
      }
      assert.match(
        content,
        new RegExp(
          `export\\s+const\\s+(?:GET|POST)\\s*=\\s+guardedRead\\(\\s*${reference}\\b`,
        ),
        `${source} must export its declared read guard`,
      );
    }
  }
});
