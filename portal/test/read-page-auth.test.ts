import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { CAPABILITIES_HEADER, PRINCIPAL_ID_HEADER } from "@/lib/principal";

// Next's server request stores are normally installed by its runtime. This focused
// server-component harness installs the Node implementation before importing a page
// so it can exercise the real page authorization boundary without a web server.
(globalThis as typeof globalThis & {
  AsyncLocalStorage?: typeof AsyncLocalStorage;
}).AsyncLocalStorage = AsyncLocalStorage;

// A fail-open or misplaced page guard would otherwise fall through to a loader. Keep
// that path local and invalid: this test must never use the portal's configured DB.
process.env.KEEL_DB_URL = "";
process.env.__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS = "1";

type Page = (props?: {
  searchParams: Promise<{ snapshot?: string }>;
  params: Promise<{ id: string }>;
}) => Promise<unknown>;

interface AsyncStore {
  run<T>(store: object, callback: () => T): T;
}

function defaultPage(module: unknown): Page {
  const loaded = module as { default?: unknown };
  const page = typeof loaded.default === "function"
    ? loaded.default
    : (loaded.default as { default?: unknown } | undefined)?.default;
  assert.equal(typeof page, "function", "page module must have a default export");
  return page as Page;
}

async function renderWithoutReadGrant(
  route: string,
  page: Page,
  workAsyncStorage: AsyncStore,
  workUnitAsyncStorage: AsyncStore,
  requestHeaders = new Headers(),
): Promise<void> {
  const requestStore = {
    type: "request",
    phase: "render",
    headers: requestHeaders,
    implicitTags: [],
    url: { pathname: route, search: "" },
    rootParams: {},
    resumeDataCache: null,
    isHmrRefresh: false,
    serverComponentsHmrCache: undefined,
    hmrRefreshHash: undefined,
    fallbackParams: null,
  };
  const workStore = {
    route,
    forceStatic: false,
    dynamicShouldError: false,
  };

  await assert.rejects(
    workAsyncStorage.run(workStore, () =>
      workUnitAsyncStorage.run(requestStore, () => page({ searchParams: Promise.resolve({}), params: Promise.resolve({ id: "00000000-0000-0000-0000-000000000001" }) })),
    ),
    (error: unknown) => {
      assert.equal(
        (error as { digest?: unknown }).digest,
        "NEXT_HTTP_ERROR_FALLBACK;403",
        `${route} must reject before its loader can return a data fallback`,
      );
      return true;
    },
  );
}

test("every server-rendered data page rejects before its loader without a read grant", async () => {
  const [
    home,
    backups,
    baselines,
    coverage,
    drift,
    restore,
    jobs,
    job,
    policies,
    policy,
    workUnitModule,
    workModule,
  ] = await Promise.all([
    import("../app/page"),
    import("../app/backups/page"),
    import("../app/baselines/page"),
    import("../app/coverage/page"),
    import("../app/drift/page"),
    import("../app/restore/page"),
    import("../app/jobs/page"),
    import("../app/jobs/[id]/page"),
    import("../app/policies/page"),
    import("../app/policies/[id]/page"),
    import("next/dist/server/app-render/work-unit-async-storage.external.js"),
    import("next/dist/server/app-render/work-async-storage.external.js"),
  ]);
  const { workUnitAsyncStorage } = workUnitModule as {
    workUnitAsyncStorage: AsyncStore;
  };
  const { workAsyncStorage } = workModule as { workAsyncStorage: AsyncStore };

  for (const [route, module] of [
    ["/", home],
    ["/backups", backups],
    ["/baselines", baselines],
    ["/coverage", coverage],
    ["/drift", drift],
    ["/restore", restore],
    ["/jobs", jobs],
    ["/jobs/[id]", job],
    ["/policies", policies],
    ["/policies/[id]", policy],
  ] as const) {
    await renderWithoutReadGrant(
      route,
      defaultPage(module),
      workAsyncStorage,
      workUnitAsyncStorage,
    );
    await renderWithoutReadGrant(
      route, defaultPage(module), workAsyncStorage, workUnitAsyncStorage,
      new Headers([[PRINCIPAL_ID_HEADER, "operator"], [CAPABILITIES_HEADER, route.startsWith("/policies") ? "read collect" : "collect"]]),
    );
  }
});

test("every server-rendered data page rejects a read grant without a principal identifier", async () => {
  const [
    home,
    backups,
    baselines,
    coverage,
    drift,
    restore,
    jobs,
    job,
    policies,
    policy,
    workUnitModule,
    workModule,
  ] = await Promise.all([
    import("../app/page"),
    import("../app/backups/page"),
    import("../app/baselines/page"),
    import("../app/coverage/page"),
    import("../app/drift/page"),
    import("../app/restore/page"),
    import("../app/jobs/page"),
    import("../app/jobs/[id]/page"),
    import("../app/policies/page"),
    import("../app/policies/[id]/page"),
    import("next/dist/server/app-render/work-unit-async-storage.external.js"),
    import("next/dist/server/app-render/work-async-storage.external.js"),
  ]);
  const { workUnitAsyncStorage } = workUnitModule as {
    workUnitAsyncStorage: AsyncStore;
  };
  const { workAsyncStorage } = workModule as { workAsyncStorage: AsyncStore };

  for (const [route, module] of [
    ["/", home],
    ["/backups", backups],
    ["/baselines", baselines],
    ["/coverage", coverage],
    ["/drift", drift],
    ["/restore", restore],
    ["/jobs", jobs],
    ["/jobs/[id]", job],
    ["/policies", policies],
    ["/policies/[id]", policy],
  ] as const) {
    await renderWithoutReadGrant(
      route,
      defaultPage(module),
      workAsyncStorage,
      workUnitAsyncStorage,
      new Headers([[CAPABILITIES_HEADER, "read"]]),
    );
  }
});

// A rejecting promise alone does not prove ordering: a page whose guard runs after a
// loader that itself fails (e.g. on a bad DB URL) can still reject, hiding a guard that
// never ran at all. This spies on the first synchronous read the dashboard loader makes
// (tenantRef's config read) to prove directly that it is never reached while denied, the
// same invariant the API "loader must not run" tests already assert via a call counter.
test("the dashboard page never reaches its data loader before the read guard resolves", async () => {
  const sentinelPath = join(tmpdir(), `keel-read-order-sentinel-${process.pid}.json`);
  fs.writeFileSync(sentinelPath, JSON.stringify({ tenantId: "read-order-sentinel-tenant" }));
  const originalTenantConfigPath = process.env.KEEL_TENANT_CONFIG_PATH;
  const originalReadFileSync = fs.readFileSync;
  let tenantConfigReads = 0;

  process.env.KEEL_TENANT_CONFIG_PATH = sentinelPath;
  fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
    if (args[0] === sentinelPath) tenantConfigReads += 1;
    return originalReadFileSync(...args);
  }) as typeof fs.readFileSync;

  try {
    const [home, workUnitModule, workModule] = await Promise.all([
      import("../app/page"),
      import("next/dist/server/app-render/work-unit-async-storage.external.js"),
      import("next/dist/server/app-render/work-async-storage.external.js"),
    ]);
    const { workUnitAsyncStorage } = workUnitModule as { workUnitAsyncStorage: AsyncStore };
    const { workAsyncStorage } = workModule as { workAsyncStorage: AsyncStore };
    const page = defaultPage(home);

    await renderWithoutReadGrant("/", page, workAsyncStorage, workUnitAsyncStorage);
    assert.equal(
      tenantConfigReads,
      0,
      "the dashboard loader must not run before requireReadAccess resolves",
    );

    // Positive control: prove the spy observes a real invocation once access is granted,
    // so the assertion above is evidence of ordering and not a spy that never fires.
    const requestStore = {
      type: "request",
      phase: "render",
      headers: new Headers([
        [PRINCIPAL_ID_HEADER, "principal-viewer"],
        [CAPABILITIES_HEADER, "read"],
      ]),
      implicitTags: [],
      url: { pathname: "/", search: "" },
      rootParams: {},
      resumeDataCache: null,
      isHmrRefresh: false,
      serverComponentsHmrCache: undefined,
      hmrRefreshHash: undefined,
      fallbackParams: null,
    };
    const workStore = { route: "/", forceStatic: false, dynamicShouldError: false };
    await workAsyncStorage.run(workStore, () =>
      workUnitAsyncStorage.run(requestStore, () => page({ searchParams: Promise.resolve({}), params: Promise.resolve({ id: "00000000-0000-0000-0000-000000000001" }) })),
    );
    assert.ok(
      tenantConfigReads >= 1,
      "expected the loader to run once access is granted, proving the spy observes real invocations",
    );
  } finally {
    fs.readFileSync = originalReadFileSync;
    if (originalTenantConfigPath === undefined) delete process.env.KEEL_TENANT_CONFIG_PATH;
    else process.env.KEEL_TENANT_CONFIG_PATH = originalTenantConfigPath;
    fs.rmSync(sentinelPath, { force: true });
  }
});

test("requireReadAccess rejects a read grant without a principal identifier", async () => {
  const [readModule, workUnitModule, workModule] = await Promise.all([
    import("@/lib/read"),
    import("next/dist/server/app-render/work-unit-async-storage.external.js"),
    import("next/dist/server/app-render/work-async-storage.external.js"),
  ]);
  const { DATA_SURFACES, requireReadAccess } = readModule;
  const { workUnitAsyncStorage } = workUnitModule as {
    workUnitAsyncStorage: AsyncStore;
  };
  const { workAsyncStorage } = workModule as { workAsyncStorage: AsyncStore };
  const requestStore = {
    type: "request",
    phase: "render",
    headers: new Headers([[CAPABILITIES_HEADER, "read"]]),
    implicitTags: [],
    url: { pathname: "/drift", search: "" },
    rootParams: {},
    resumeDataCache: null,
    isHmrRefresh: false,
    serverComponentsHmrCache: undefined,
    hmrRefreshHash: undefined,
    fallbackParams: null,
  };
  const workStore = {
    route: "/drift",
    forceStatic: false,
    dynamicShouldError: false,
  };

  await assert.rejects(
    workAsyncStorage.run(workStore, () =>
      workUnitAsyncStorage.run(requestStore, () =>
        requireReadAccess(DATA_SURFACES.driftPage),
      ),
    ),
    (error: unknown) => {
      assert.equal((error as { digest?: unknown }).digest, "NEXT_HTTP_ERROR_FALLBACK;403");
      return true;
    },
  );
});

test("jobs pages do not reach their API database loader for unauthenticated or no-read requests", async () => {
  const [jobs, job, workUnitModule, workModule] = await Promise.all([
    import("../app/jobs/page"), import("../app/jobs/[id]/page"),
    import("next/dist/server/app-render/work-unit-async-storage.external.js"),
    import("next/dist/server/app-render/work-async-storage.external.js"),
  ]);
  const { workUnitAsyncStorage } = workUnitModule as { workUnitAsyncStorage: AsyncStore };
  const { workAsyncStorage } = workModule as { workAsyncStorage: AsyncStore };
  const originalUrl = process.env.KEEL_DB_URL;
  const originalPath = process.env.KEEL_DB_ENV_PATH;
  const originalRead = fs.readFileSync;
  const sentinel = join(process.cwd(), "job-loader-sentinel.env");
  let loaderCalls = 0;
  delete process.env.KEEL_DB_URL;
  process.env.KEEL_DB_ENV_PATH = sentinel;
  fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
    if (args[0] === sentinel) {
      loaderCalls += 1;
      throw new Error("Observed job loader; no database connection allowed");
    }
    return originalRead(...args);
  }) as typeof fs.readFileSync;
  try {
    for (const [route, module] of [["/jobs", jobs], ["/jobs/[id]", job]] as const) {
      loaderCalls = 0;
      const page = defaultPage(module);
      for (const requestHeaders of [
        new Headers(),
        new Headers([[CAPABILITIES_HEADER, "read"]]),
        new Headers([[PRINCIPAL_ID_HEADER, "operator"], [CAPABILITIES_HEADER, "collect"]]),
      ]) {
        await renderWithoutReadGrant(route, page, workAsyncStorage, workUnitAsyncStorage, requestHeaders);
        assert.equal(loaderCalls, 0, `${route}: denied requests must never load jobs`);
      }
      await workAsyncStorage.run({ route, forceStatic: false, dynamicShouldError: false }, () =>
        workUnitAsyncStorage.run({
          type: "request", phase: "render",
          headers: new Headers([[PRINCIPAL_ID_HEADER, "viewer"], [CAPABILITIES_HEADER, "read"]]),
          implicitTags: [], url: { pathname: route, search: "" }, rootParams: {},
          resumeDataCache: null, isHmrRefresh: false, fallbackParams: null,
        }, () => page({
          searchParams: Promise.resolve({}),
          params: Promise.resolve({ id: "00000000-0000-0000-0000-000000000001" }),
        })),
      );
      assert.equal(loaderCalls, 1, `${route}: positive control must reach the actual loader`);
    }
  } finally {
    fs.readFileSync = originalRead;
    if (originalUrl === undefined) delete process.env.KEEL_DB_URL;
    else process.env.KEEL_DB_URL = originalUrl;
    if (originalPath === undefined) delete process.env.KEEL_DB_ENV_PATH;
    else process.env.KEEL_DB_ENV_PATH = originalPath;
  }
});
