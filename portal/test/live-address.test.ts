import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import { DetailsSheet } from "@/components/baselines/details-sheet";
import { announceUrl, pushUrl, replaceUrl, subscribeUrl } from "@/lib/url-history";

// The Alerts panel did not open from a search on a slow server, and the Find box then
// stopped filtering. Next.js applies an address change as a low-priority router update,
// and the 10-second background refresh held it back while it waited on the server. View
// state now reads the browser's address at once after each write (useLiveSearchParams).

function fakeWindow() {
  const address = { pathname: "/alerts", search: "" };
  const popListeners = new Set<() => void>();
  const write = (_state: unknown, _title: string, href: string) => {
    const [path, query = ""] = href.split("?");
    address.pathname = path;
    address.search = query ? `?${query}` : "";
  };
  (globalThis as { window?: unknown }).window = {
    location: address,
    history: { replaceState: write, pushState: write },
    addEventListener: (type: string, fn: () => void) => { if (type === "popstate") popListeners.add(fn); },
    removeEventListener: (type: string, fn: () => void) => { if (type === "popstate") popListeners.delete(fn); },
  };
  return { address, popListeners };
}

test("each address write tells the pages at once, and Back does too", (t) => {
  t.after(() => { delete (globalThis as { window?: unknown }).window; });
  const { address, popListeners } = fakeWindow();
  const seen: string[] = [];
  const stop = subscribeUrl(() => seen.push(address.search));

  replaceUrl("/alerts?q=Keel+Restorer");
  pushUrl("/alerts?q=Keel+Restorer&open=a1");
  announceUrl();
  for (const fn of popListeners) fn();
  assert.deepEqual(seen, ["?q=Keel+Restorer", "?q=Keel+Restorer&open=a1", "?q=Keel+Restorer&open=a1", "?q=Keel+Restorer&open=a1"]);

  stop();
  replaceUrl("/alerts");
  assert.equal(seen.length, 4, "a stopped listener hears nothing");
  assert.equal(popListeners.size, 0, "it stops listening for Back as well");
});

test("a link that opens a panel draws on the server without touching the page body", () => {
  // The server has no `document`: drawing the panel there failed ("document is not
  // defined", React error 419) and the browser redrew the whole page.
  assert.equal(typeof (globalThis as { document?: unknown }).document, "undefined");
  const html = renderToString(createElement(DetailsSheet, { title: "Block legacy auth", onClose: () => {}, children: "Details" }));
  assert.equal(html, "");
});

// Every page reads its URL view state through useLiveSearchParams, so none can fall back
// to the router's held-back copy.
const ROOT = join(import.meta.dirname, "..");
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name.startsWith(".")) return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.tsx?$/.test(path) ? [path] : [];
  });
}

test("no page reads the address through useSearchParams", () => {
  const sources = ["app", "components", "lib"].flatMap((dir) => files(join(ROOT, dir)));
  const users = sources.filter((path) => /\buseSearchParams\(/.test(readFileSync(path, "utf8"))).map((path) => relative(ROOT, path));
  assert.deepEqual(users, ["lib/use-view-state.ts"], "use useLiveSearchParams from lib/use-view-state");
  const live = sources.filter((path) => /\buseLiveSearchParams\(/.test(readFileSync(path, "utf8")));
  assert.ok(live.length >= 15, "the scan finds the list pages");
});
