import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { WAITING_CARDS } from "@/components/dashboard/dashboard-view";
import { NAV_MAP, NAV_SECTIONS } from "@/components/nav-links";

// No hidden pages: every portal page is reached by clicking, from the sidebar, a
// section tab, or a link on another page. A page reachable only by typing its URL
// fails here. Legacy routes that only redirect to their new home are exempt.

const portal = fileURLToPath(new URL("../", import.meta.url));
const appDirectory = resolve(portal, "app");

function files(directory: string, keep: (name: string) => boolean): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "api" || entry.name === "node_modules" ? [] : files(path, keep);
    return keep(entry.name) ? [path] : [];
  });
}

interface Page { route: string; file: string; source: string }

function portalPages(): Page[] {
  return files(appDirectory, (name) => name === "page.tsx").map((file) => {
    const dir = relative(appDirectory, file).replaceAll("\\", "/").replace(/\/?page\.tsx$/, "");
    return { route: `/${dir}`.replace(/\/$/, "") || "/", file, source: readFileSync(file, "utf8") };
  });
}

// A link to the route inside a string or template literal: `"/alerts"`, `"/alerts?x"`,
// `` `/jobs/${id}` ``. A dynamic segment matches any interpolation.
function linkPattern(route: string): RegExp {
  if (route === "/") return /href=["'{`]+\/["'`]/;
  const body = route.split("/").filter(Boolean)
    .map((segment) => (/^\[.+\]$/.test(segment) ? "\\$\\{[^}]+\\}" : segment.replace(/[.*+?^$()|\\]/g, "\\$&")))
    .join("/");
  return new RegExp(`["'\`]/${body}(?=["'\`?#])`);
}

function isRedirectOnly(source: string): boolean {
  return /\bredirect\(/.test(source) && !/return\s*\(?\s*</.test(source) && !/<\w/.test(source);
}

/** Routes nobody can click to: not in the sidebar or a tab, not linked from any other source. */
export function unreachableRoutes(pages: Page[], sources: { file: string; source: string }[], navigable: Set<string>): string[] {
  return pages.filter((page) => {
    if (navigable.has(page.route) || isRedirectOnly(page.source)) return false;
    const pattern = linkPattern(page.route);
    return !sources.some(({ file, source }) => file !== page.file && !file.endsWith("not-found.tsx") && pattern.test(source));
  }).map((page) => page.route);
}

function navigableRoutes(): Set<string> {
  return new Set(NAV_SECTIONS.flatMap((section) => NAV_MAP[section].filter((route) => !route.hidden).map((route) => route.href)));
}

function linkSources() {
  return [...files(appDirectory, (name) => /\.tsx?$/.test(name)), ...files(resolve(portal, "components"), (name) => /\.tsx?$/.test(name))]
    .map((file) => ({ file, source: readFileSync(file, "utf8") }));
}

test("every portal page has an inbound link: sidebar, section tab, or another page", () => {
  const pages = portalPages();
  assert.ok(pages.length >= 25, `only ${pages.length} pages found`);
  assert.deepEqual(unreachableRoutes(pages, linkSources(), navigableRoutes()), []);
});

test("a hidden route in the map is a redirect or is linked from another page", () => {
  const hidden = NAV_SECTIONS.flatMap((section) => NAV_MAP[section].filter((route) => route.hidden).map((route) => route.href));
  const pages = portalPages().filter((page) => hidden.includes(page.route));
  assert.equal(pages.length, hidden.length, "every hidden route has a page");
  assert.deepEqual(unreachableRoutes(pages, linkSources(), new Set()), []);
});

test("the check fails for a page nothing links to", () => {
  const orphan = { route: "/orphan", file: "/x/app/orphan/page.tsx", source: "export default function Orphan() { return <p>hi</p>; }" };
  const detail = { route: "/things/[id]", file: "/x/app/things/[id]/page.tsx", source: "export default function T() { return <p>hi</p>; }" };
  const legacy = { route: "/old", file: "/x/app/old/page.tsx", source: "export default async function Old() { redirect(\"/new\"); }" };
  const sources = [
    { file: "/x/app/orphan/page.tsx", source: "<Link href=\"/orphan\">self</Link>" },
    { file: "/x/app/not-found.tsx", source: "<Link href=\"/orphan\">lost?</Link>" },
    { file: "/x/components/a.tsx", source: "<Link href=\"/orphanage\">other</Link> <Link href={`/things/${id}`}>thing</Link>" },
  ];
  assert.deepEqual(unreachableRoutes([orphan, detail, legacy], sources, new Set()), ["/orphan"]);
  assert.deepEqual(unreachableRoutes([orphan], sources, new Set(["/orphan"])), [], "a sidebar or tab entry counts");
});

test("every waiting count on the Overview opens a real page", () => {
  const routes = portalPages().map((page) => page.route);
  for (const card of WAITING_CARDS) {
    const path = card.href.split(/[?#]/)[0];
    assert.ok(routes.includes(path), `${card.key} links to ${card.href}, which has no page`);
  }
});
