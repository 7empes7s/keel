import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { CAPABILITIES_HEADER, PRINCIPAL_ID_HEADER } from "@/lib/principal";

// Next's server request stores are normally installed by its runtime. This focused
// server-component harness installs the Node implementation before importing the page
// so it can exercise the real page authorization boundary without a web server, the
// same harness portal/test/read-page-auth.test.ts uses for the other data pages.
(globalThis as typeof globalThis & {
  AsyncLocalStorage?: typeof AsyncLocalStorage;
}).AsyncLocalStorage = AsyncLocalStorage;

// A fail-open or misplaced page guard would otherwise fall through to a loader. Keep
// that path local and invalid: this test must never use the portal's configured DB.
process.env.KEEL_DB_URL = "";
process.env.__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS = "1";

type Page = () => Promise<unknown>;

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

function requestStoreFor(requestHeaders: Headers) {
  return {
    type: "request",
    phase: "render",
    headers: requestHeaders,
    implicitTags: [],
    url: { pathname: "/approvals", search: "" },
    rootParams: {},
    resumeDataCache: null,
    isHmrRefresh: false,
    serverComponentsHmrCache: undefined,
    hmrRefreshHash: undefined,
    fallbackParams: null,
  };
}

const workStore = { route: "/approvals", forceStatic: false, dynamicShouldError: false };

async function renderDenied(
  page: Page,
  workAsyncStorage: AsyncStore,
  workUnitAsyncStorage: AsyncStore,
  requestHeaders = new Headers(),
): Promise<void> {
  await assert.rejects(
    workAsyncStorage.run(workStore, () =>
      workUnitAsyncStorage.run(requestStoreFor(requestHeaders), () => page())),
    (error: unknown) => {
      assert.equal(
        (error as { digest?: unknown }).digest,
        "NEXT_HTTP_ERROR_FALLBACK;403",
        "the approvals page must reject before its loader can return a data fallback",
      );
      return true;
    },
  );
}

async function loadHarness() {
  const [approvalsPage, workUnitModule, workModule] = await Promise.all([
    import("../app/approvals/page"),
    import("next/dist/server/app-render/work-unit-async-storage.external.js"),
    import("next/dist/server/app-render/work-async-storage.external.js"),
  ]);
  const { workUnitAsyncStorage } = workUnitModule as { workUnitAsyncStorage: AsyncStore };
  const { workAsyncStorage } = workModule as { workAsyncStorage: AsyncStore };
  return { page: defaultPage(approvalsPage), workAsyncStorage, workUnitAsyncStorage };
}

test("the approvals page rejects before its loader without the approve capability", async () => {
  const { page, workAsyncStorage, workUnitAsyncStorage } = await loadHarness();

  await renderDenied(page, workAsyncStorage, workUnitAsyncStorage);
  await renderDenied(
    page,
    workAsyncStorage,
    workUnitAsyncStorage,
    new Headers([[CAPABILITIES_HEADER, "read"]]),
  );
  await renderDenied(
    page,
    workAsyncStorage,
    workUnitAsyncStorage,
    new Headers([
      [PRINCIPAL_ID_HEADER, "principal-viewer"],
      [CAPABILITIES_HEADER, "read"],
    ]),
  );
});

// A rejecting promise alone does not prove ordering: a guard relocated inside the
// page's own try/catch (after the loader starts) would have its forbidden() rejection
// swallowed by that same catch block, producing a resolved DataUnavailable fallback
// instead of a rejection -- which the test above would also catch. This test goes
// further and spies on the first read the approval loader makes reaching for its
// database configuration, to prove directly that it never runs while denied, even in
// a variant where the swallowed rejection still happens to surface as a thrown error.
test("the approvals page never reaches its data loader before the approve guard resolves", async () => {
  const dbEnvPath = join(tmpdir(), `keel-approvals-order-sentinel-${process.pid}.env`);
  fs.writeFileSync(
    dbEnvPath,
    "KEEL_DB_URL=postgres://127.0.0.1:1/keel-approvals-order-sentinel\n",
  );
  const originalDbEnvPath = process.env.KEEL_DB_ENV_PATH;
  const originalDbUrl = process.env.KEEL_DB_URL;
  const originalReadFileSync = fs.readFileSync;
  let dbEnvReads = 0;

  process.env.KEEL_DB_ENV_PATH = dbEnvPath;
  delete process.env.KEEL_DB_URL;
  fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
    if (args[0] === dbEnvPath) dbEnvReads += 1;
    return originalReadFileSync(...args);
  }) as typeof fs.readFileSync;

  try {
    const { page, workAsyncStorage, workUnitAsyncStorage } = await loadHarness();

    await renderDenied(page, workAsyncStorage, workUnitAsyncStorage);
    assert.equal(
      dbEnvReads,
      0,
      "the approvals page loader must not run before requireApprovalInboxAccess resolves",
    );

    // Positive control: prove the spy observes a real invocation once access is
    // granted, so the assertion above is evidence of ordering and not a spy that
    // never fires. The loader's own try/catch renders DataUnavailable when the
    // sentinel connection string fails to connect, so this does not reject.
    await workAsyncStorage.run(workStore, () =>
      workUnitAsyncStorage.run(
        requestStoreFor(new Headers([
          [PRINCIPAL_ID_HEADER, "principal-approver"],
          [CAPABILITIES_HEADER, "approve"],
        ])),
        () => page(),
      ));
    assert.ok(
      dbEnvReads >= 1,
      "expected the loader to run once access is granted, proving the spy observes real invocations",
    );
  } finally {
    fs.readFileSync = originalReadFileSync;
    if (originalDbEnvPath === undefined) delete process.env.KEEL_DB_ENV_PATH;
    else process.env.KEEL_DB_ENV_PATH = originalDbEnvPath;
    if (originalDbUrl === undefined) delete process.env.KEEL_DB_URL;
    else process.env.KEEL_DB_URL = originalDbUrl;
    fs.rmSync(dbEnvPath, { force: true });
  }
});
