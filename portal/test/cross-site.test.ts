import assert from "node:assert/strict";
import { test } from "node:test";

import { NextRequest } from "next/server";

import nextConfig from "@/next.config";
import { InvalidActionRequest, readActionParams } from "@/lib/action";
import { isJsonContentType, isSameOriginRequest } from "@/lib/same-origin";
import { createAccessMiddleware } from "@/proxy";

const PORTAL = "keel.example.com";
const noEnv = {};

function headers(values: Record<string, string>): Headers {
  return new Headers({ host: PORTAL, ...values });
}

test("safe reads pass whatever site they come from", () => {
  for (const method of ["GET", "HEAD", "OPTIONS"]) {
    assert.equal(isSameOriginRequest(method, headers({ "sec-fetch-site": "cross-site", origin: "https://evil.example" }), noEnv), true);
  }
});

test("a state change from the portal's own pages passes", () => {
  assert.equal(isSameOriginRequest("POST", headers({ "sec-fetch-site": "same-origin", origin: `https://${PORTAL}` }), noEnv), true);
  // TLS ends in front of the portal, so the scheme the browser used may differ.
  assert.equal(isSameOriginRequest("POST", headers({ origin: `http://${PORTAL}` }), noEnv), true);
  assert.equal(isSameOriginRequest("POST", headers({ "x-forwarded-host": PORTAL, host: "127.0.0.1:3000", origin: `https://${PORTAL}` }), noEnv), true);
  assert.equal(isSameOriginRequest("POST", new Headers({ host: "127.0.0.1:3000", origin: "https://portal.example.org" }), { KEEL_PORTAL_URL: "https://portal.example.org/" }), true);
});

test("a request with no browser headers is left to the Access assertion", () => {
  assert.equal(isSameOriginRequest("POST", headers({}), noEnv), true);
});

test("a state change from another site is refused", () => {
  const refused: Record<string, string>[] = [
    { "sec-fetch-site": "cross-site" },
    { "sec-fetch-site": "same-site", origin: `https://other.${PORTAL}` },
    { origin: "https://evil.example" },
    { origin: `https://${PORTAL}.evil.example` },
    { origin: "null" },
    { origin: "not a url" },
    // A forged Sec-Fetch-Site cannot cover a foreign Origin.
    { "sec-fetch-site": "same-origin", origin: "https://evil.example" },
  ];
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    for (const values of refused) {
      assert.equal(isSameOriginRequest(method, headers(values), noEnv), false, `${method} ${JSON.stringify(values)}`);
    }
  }
});

test("only application/json counts as JSON", () => {
  assert.equal(isJsonContentType("application/json"), true);
  assert.equal(isJsonContentType("Application/JSON; charset=utf-8"), true);
  for (const value of [null, "", "text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "application/jsonx"]) {
    assert.equal(isJsonContentType(value), false, String(value));
  }
});

test("the proxy refuses a cross-site approve before it checks sign-in, and lets a same-origin one through to sign-in", async () => {
  let resolved = 0;
  const middleware = createAccessMiddleware(
    () => {
      throw new Error("config must not be read for a refused request");
    },
    async () => {
      resolved += 1;
      return { principalId: "principal-approver", capabilities: ["approve"] };
    },
  );
  const path = "http://keel.example.com/api/approvals/00000000-0000-0000-0000-000000000001/approve";

  const crossSite = await middleware(new NextRequest(path, {
    method: "POST",
    headers: { host: PORTAL, origin: "https://evil.example", "sec-fetch-site": "cross-site", "content-type": "text/plain", "cf-access-jwt-assertion": "anything" },
  }));
  assert.equal(crossSite.status, 403);
  assert.deepEqual(await crossSite.json(), { error: "cross-site request refused" });
  assert.equal(crossSite.headers.get("x-middleware-next"), null);
  assert.equal(resolved, 0);

  // Same-origin, no assertion: it reaches the sign-in check, which answers 401.
  const sameOrigin = await middleware(new NextRequest(path, {
    method: "POST",
    headers: { host: PORTAL, origin: `https://${PORTAL}`, "sec-fetch-site": "same-origin" },
  }));
  assert.equal(sameOrigin.status, 401);
});

test("action bodies must be sent as application/json", async () => {
  const post = (body: string, contentType?: string) =>
    new Request("http://localhost/api/actions/x", { method: "POST", body, headers: contentType ? { "content-type": contentType } : {} });

  for (const contentType of [undefined, "text/plain", "application/x-www-form-urlencoded"]) {
    await assert.rejects(readActionParams(post('{"reason":"=x"}', contentType)), InvalidActionRequest, String(contentType));
  }
  assert.deepEqual(await readActionParams(post('{"reason":"ok"}', "application/json; charset=utf-8")), { reason: "ok" });
  assert.deepEqual(await readActionParams(post("", "text/plain")), {});
});

test("no other site may frame the portal", async () => {
  assert.ok(nextConfig.headers, "next.config sets response headers");
  const rules = await nextConfig.headers();
  const all = rules.find((rule) => rule.source === "/:path*");
  assert.ok(all, "the frame rule covers every path");
  const byKey = new Map(all.headers.map((header) => [header.key.toLowerCase(), header.value]));
  assert.equal(byKey.get("content-security-policy"), "frame-ancestors 'none'");
  assert.equal(byKey.get("x-frame-options"), "DENY");
});
