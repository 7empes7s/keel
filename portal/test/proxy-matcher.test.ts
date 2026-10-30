import assert from "node:assert/strict";
import { test } from "node:test";

import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";

import { config } from "@/proxy";

const matches = (url: string): boolean => unstable_doesMiddlewareMatch({ config, url });

test("sign-in check skips the build's static files and the app icon", () => {
  for (const url of [
    "/_next/static/chunks/app/page-0123abcd.js",
    "/_next/static/css/4567ef.css",
    "/_next/static/media/font-subset.woff2",
    "/_next/static/build-id/_buildManifest.js",
    "/icon.svg",
    "/icon.svg?7f3a1c2b",
  ]) {
    assert.equal(matches(url), false, `${url} should skip the sign-in check`);
  }
});

test("sign-in check still runs on every page, API route and other Next.js path", () => {
  for (const url of [
    "/",
    "/activity",
    "/restore/abc",
    "/api/dashboard",
    "/api/health",
    "/api/approvals?state=pending",
    "/_next/image?url=%2Ficon.svg&w=64&q=75",
    "/_next/data/build-id/index.json",
    "/_next/staticx/chunk.js",
    "/_next/static",
    "/icon.svg.json",
    "/icon.svgx",
    "/icons/icon.svg",
    "/api/icon.svg",
    "/api/_next/static/x.js",
    "/activity?next=/_next/static/x.js",
  ]) {
    assert.equal(matches(url), true, `${url} must stay behind the sign-in check`);
  }
});
