import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { useViewState } from "@/lib/use-view-state";

// Two address writes close together (a filter tile, then the Find box's delayed write)
// must both stay. The page has not redrawn between them, so a write built from the last
// drawn query would wipe the one before it.

function fakeAddress(start: string) {
  const address = { pathname: "/changes", search: start };
  (globalThis as { window?: unknown }).window = {
    location: address,
    history: {
      replaceState(_state: unknown, _title: string, href: string) {
        const [path, query = ""] = href.split("?");
        address.pathname = path;
        address.search = query ? `?${query}` : "";
      },
    },
  };
  return address;
}

function captureSet() {
  let set: ReturnType<typeof useViewState>["set"] | undefined;
  function Probe() {
    set = useViewState().set;
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  assert.ok(set);
  return set;
}

test("writes made before the page redraws keep each other", (t) => {
  t.after(() => { delete (globalThis as { window?: unknown }).window; });
  const address = fakeAddress("?sort=newest");
  const set = captureSet();

  set({ service: "entra" });
  set({ q: "policy" });
  set({ open: "row-7" });

  assert.deepEqual(Object.fromEntries(new URLSearchParams(address.search)), {
    sort: "newest", service: "entra", q: "policy", open: "row-7",
  });
});

test("a removed filter stays removed when another write follows", (t) => {
  t.after(() => { delete (globalThis as { window?: unknown }).window; });
  const address = fakeAddress("?sort=oldest&service=entra&q=policy");
  const set = captureSet();

  set({ service: null });
  set({ q: "rule" }, { q: "" });

  assert.equal(address.search, "?sort=oldest&q=rule");
});

test("defaults and empty values leave the address", (t) => {
  t.after(() => { delete (globalThis as { window?: unknown }).window; });
  const address = fakeAddress("?sort=oldest&q=x");
  const set = captureSet();

  set({ sort: "newest", q: "" }, { sort: "newest" });

  assert.equal(address.search, "");
});
