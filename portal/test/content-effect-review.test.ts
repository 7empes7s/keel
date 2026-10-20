import "./next-async-storage";

import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ContentEffectsNote, contentEffectsLink } from "@/components/approval-inbox";
import { ContentEffectList, type ContentEffect } from "@/components/content-effects";
import type { ApprovalRequestRecord } from "@/lib/approval-inbox";
import { contentEffectReviewAccess, contentEffectReviewView, contentEffectVerdict, isArtifactId } from "@/lib/content-effect-review";
import { CAPABILITIES_HEADER, ENTITY_CAPABILITIES_HEADER, PRINCIPAL_ID_HEADER } from "@/lib/principal";
import { EMPTY_REFERENCES } from "@/lib/sentences";

// Q45: a dry run made with the CLI (`keel-restore --persist-artifact`) carries content
// effects the portal must show and let a different approver approve, exactly like a
// dry run made in the portal.

process.env.__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS = "1";

const ARTIFACT = "11111111-2222-4333-8444-555555555555";
const REQUESTER = "aaaaaaaa-0000-4000-8000-000000000001";
const APPROVER = "aaaaaaaa-0000-4000-8000-000000000002";

const effect: ContentEffect = {
  naturalKey: "groupLifecyclePolicy:default",
  resourceType: "groupLifecyclePolicy",
  field: "groupLifetimeInDays",
  effect: "retention-reducing",
  before: 400,
  after: 365,
  disclosure: "Content older than the new retention period can be permanently deleted.",
};

function restoreRequest(overrides: Partial<ApprovalRequestRecord> = {}, contentEffects = 1): ApprovalRequestRecord {
  return {
    id: "req-1", action: "restore", params: { artifactId: ARTIFACT }, requestedBy: REQUESTER, justification: null,
    status: "pending", decidedBy: null, decidedAt: null, reason: null, createdAt: null, expiresAt: null, executor: "cli",
    references: {
      ...EMPTY_REFERENCES,
      // A CLI-made dry run has no portal job that computed it.
      plan: { kind: "dry-run", id: ARTIFACT, name: null, readable: true, resources: 1, dryRunJobId: null, contentEffects },
    },
    ...overrides,
  };
}

test("the inbox links a restore with content effects to their review, even when the CLI planned it", () => {
  assert.deepEqual(contentEffectsLink(restoreRequest()), {
    href: `/approvals/content-effects/${ARTIFACT}`, label: "Review the content changes", count: 1,
  });
  const html = renderToStaticMarkup(createElement(ContentEffectsNote, { request: restoreRequest({}, 2) }));
  assert.match(html, /2 changes in this restore affect kept or shared content\. They need their own approval/);
  assert.match(html, new RegExp(`href="/approvals/content-effects/${ARTIFACT}"`));
  // No effects, an unreadable plan, or another action: no link.
  assert.equal(contentEffectsLink(restoreRequest({}, 0)), null);
  assert.equal(contentEffectsLink(restoreRequest({ action: "baseline-activate" })), null);
  assert.equal(contentEffectsLink(restoreRequest({ references: { ...EMPTY_REFERENCES, plan: { kind: "dry-run", id: ARTIFACT, name: null, readable: false } } })), null);
});

test("only a tenant-wide approver may open the review (the approval route's own audience)", () => {
  const h = (entries: [string, string][]) => new Headers(entries);
  assert.equal(contentEffectReviewAccess(h([[PRINCIPAL_ID_HEADER, APPROVER], [CAPABILITIES_HEADER, "approve"]])), APPROVER);
  assert.equal(contentEffectReviewAccess(h([[PRINCIPAL_ID_HEADER, APPROVER], [CAPABILITIES_HEADER, "read restore"]])), null);
  assert.equal(contentEffectReviewAccess(h([[CAPABILITIES_HEADER, "approve"]])), null, "no principal, no access");
  assert.equal(
    contentEffectReviewAccess(h([[PRINCIPAL_ID_HEADER, APPROVER], [CAPABILITIES_HEADER, "read"], [ENTITY_CAPABILITIES_HEADER, "approve:CREOS"]])),
    null,
    "an entity-only approver cannot approve content effects, so cannot open them either",
  );
  assert.equal(isArtifactId(ARTIFACT), true);
  assert.equal(isArtifactId("../etc"), false);
});

test("the review names people, refuses the requester and binds to the engine's digest", () => {
  const person = (id: string, name: string) => ({ kind: "person", id, name, readable: true });
  const names = new Map([[REQUESTER, person(REQUESTER, "Rita Requester")], [APPROVER, person(APPROVER, "Ada Approver")]]);
  const engine = {
    artifactId: ARTIFACT, requestedBy: REQUESTER, status: "completed", createdAt: "2026-10-13T08:00:00.000Z", resources: 1,
    effects: [effect], effectsDigest: "digest-1", approvals: [] as { approvedBy: string; approvedAt: unknown }[],
  };

  const asApprover = contentEffectReviewView(engine, names, APPROVER);
  assert.equal(asApprover.requestedByName, "Rita Requester");
  assert.equal(asApprover.viewerIsRequester, false);
  assert.equal(asApprover.effectsDigest, "digest-1");
  assert.equal(contentEffectVerdict(asApprover), "This restore changes kept or shared content. It cannot run until you approve those changes.");

  const asRequester = contentEffectReviewView(engine, names, REQUESTER);
  assert.equal(asRequester.viewerIsRequester, true);
  assert.match(contentEffectVerdict(asRequester), /someone else must approve/);

  const approved = contentEffectReviewView({ ...engine, approvals: [{ approvedBy: APPROVER, approvedAt: new Date("2026-10-13T09:00:00Z") }] }, names, APPROVER);
  assert.deepEqual(approved.approvals, [{ approvedBy: "Ada Approver", approvedAt: "2026-10-13T09:00:00.000Z" }]);
  assert.doesNotMatch(JSON.stringify(approved.approvals), new RegExp(APPROVER), "approvers are named, never shown by id");
  assert.match(contentEffectVerdict(approved), /are approved/);
});

// ------------------------------------------------------------------ page guard

type Page = (props: { params: Promise<{ id: string }> }) => Promise<unknown>;
interface AsyncStore { run<T>(store: object, callback: () => T): T }

async function harness() {
  const [pageModule, workUnitModule, workModule] = await Promise.all([
    import("../app/approvals/content-effects/[id]/page"),
    import("next/dist/server/app-render/work-unit-async-storage.external.js"),
    import("next/dist/server/app-render/work-async-storage.external.js"),
  ]);
  const loaded = pageModule as { default?: unknown };
  const page = (typeof loaded.default === "function" ? loaded.default : (loaded.default as { default: unknown }).default) as Page;
  const { workUnitAsyncStorage } = workUnitModule as { workUnitAsyncStorage: AsyncStore };
  const { workAsyncStorage } = workModule as { workAsyncStorage: AsyncStore };
  const route = "/approvals/content-effects/[id]";
  const render = (requestHeaders: Headers) => workAsyncStorage.run(
    { route, forceStatic: false, dynamicShouldError: false },
    () => workUnitAsyncStorage.run({
      type: "request", phase: "render", headers: requestHeaders, implicitTags: [],
      url: { pathname: `/approvals/content-effects/${ARTIFACT}`, search: "" }, rootParams: {}, resumeDataCache: null,
      isHmrRefresh: false, serverComponentsHmrCache: undefined, hmrRefreshHash: undefined, fallbackParams: null,
    }, () => page({ params: Promise.resolve({ id: ARTIFACT }) })),
  );
  return render;
}

test("the content-effects page refuses before its loader without tenant-wide approve, and loads with it", async () => {
  const dbEnvPath = join(tmpdir(), `keel-content-effects-sentinel-${process.pid}.env`);
  fs.writeFileSync(dbEnvPath, "KEEL_DB_URL=postgres://127.0.0.1:1/keel-content-effects-sentinel\n");
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
    const render = await harness();
    const denied = [
      new Headers(),
      new Headers([[PRINCIPAL_ID_HEADER, REQUESTER], [CAPABILITIES_HEADER, "read restore"]]),
      new Headers([[PRINCIPAL_ID_HEADER, APPROVER], [CAPABILITIES_HEADER, "read"], [ENTITY_CAPABILITIES_HEADER, "approve:CREOS"]]),
    ];
    for (const requestHeaders of denied) {
      await assert.rejects(render(requestHeaders), (error: unknown) => {
        assert.equal((error as { digest?: unknown }).digest, "NEXT_HTTP_ERROR_FALLBACK;403");
        return true;
      });
    }
    assert.equal(dbEnvReads, 0, "the loader must not run before the approve guard resolves");

    // Positive control: a tenant-wide approver reaches the loader (which fails to
    // connect to the sentinel and renders the unavailable notice).
    await render(new Headers([[PRINCIPAL_ID_HEADER, APPROVER], [CAPABILITIES_HEADER, "approve"]]));
    assert.ok(dbEnvReads >= 1, "the loader runs once access is granted");
  } finally {
    fs.readFileSync = originalReadFileSync;
    if (originalDbEnvPath === undefined) delete process.env.KEEL_DB_ENV_PATH;
    else process.env.KEEL_DB_ENV_PATH = originalDbEnvPath;
    if (originalDbUrl === undefined) delete process.env.KEEL_DB_URL;
    else process.env.KEEL_DB_URL = originalDbUrl;
    fs.rmSync(dbEnvPath, { force: true });
  }
});

test("the review names each effect's object and its people, never by email or id", () => {
  const GROUP = "0f5e1c2a-1b2c-4d3e-8f4a-5b6c7d8e9f00";
  const engine = {
    artifactId: ARTIFACT, requestedBy: REQUESTER, status: "completed", createdAt: null, resources: 1,
    effects: [{ ...effect, naturalKey: GROUP, resourceType: "group" }], effectsDigest: "digest-1",
    approvals: [{ approvedBy: APPROVER, approvedAt: null }],
  };
  const people = new Map([
    [REQUESTER, { kind: "person", id: REQUESTER, name: "rita.requester@contoso.test", email: "rita.requester@contoso.test", readable: true }],
    [APPROVER, { kind: "person", id: APPROVER, name: null, readable: false }],
  ]);
  const view = contentEffectReviewView(engine, people, APPROVER, { [GROUP]: { name: "Finance", resourceType: "group" } });
  assert.equal(view.requestedByName, "Rita Requester");
  assert.equal(view.approvals[0].approvedBy, "an account that no longer exists");
  const html = renderToStaticMarkup(createElement(ContentEffectList, { effects: view.effects, names: view.names }));
  assert.match(html, /Finance \(group\)/);
  assert.doesNotMatch(html + JSON.stringify(view.approvals) + view.requestedByName, new RegExp(`${GROUP}|${APPROVER}|@contoso`));
});
