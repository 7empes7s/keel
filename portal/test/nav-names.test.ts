import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { MENU_SECTIONS, NAV_MAP, NAV_SECTIONS } from "@/lib/nav-sections";
import { cameFrom, tabTitle } from "@/lib/nav-sections";
import { RENAMED_ROUTES, renamedPath } from "@/lib/route-names";

// UI audit D4, D5, D6 (31 Oct 2026): the menu, the page title, the URL, the browser tab
// and the breadcrumb all name a page the same way, and a breadcrumb says where the
// person came from.

const portal = fileURLToPath(new URL("../", import.meta.url));
const appDirectory = resolve(portal, "app");

function files(directory: string, keep: (name: string) => boolean): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" || entry.name === "__screenshots__" ? [] : files(path, keep);
    return keep(entry.name) ? [path] : [];
  });
}

function pageFile(href: string): string {
  return resolve(appDirectory, `.${href}`, "page.tsx");
}

// The title a page's header shows: title="…", or title={TITLE} with const TITLE = "…".
function headerTitles(source: string): string[] {
  const constant = /const TITLE = "([^"]+)";/.exec(source)?.[1];
  return [...source.matchAll(/<PageHeader[\s\S]*?\/>/g)].flatMap((match) => {
    const literal = /\btitle="([^"]+)"/.exec(match[0]);
    if (literal) return [literal[1]];
    if (/\btitle=\{TITLE\}/.test(match[0]) && constant) return [constant];
    return [];
  });
}

test("every menu page's header title is its menu name", () => {
  const checked: string[] = [];
  for (const section of NAV_SECTIONS) {
    for (const route of NAV_MAP[section].filter((candidate) => !candidate.hidden)) {
      if (route.href === "/") continue; // The Overview's header is in DashboardView.
      const titles = headerTitles(readFileSync(pageFile(route.href), "utf8"));
      assert.ok(titles.length > 0, `${route.href} has no header title the test can read`);
      for (const title of titles) assert.equal(title, route.label, `${route.href} is "${route.label}" in the menu but "${title}" on the page`);
      checked.push(route.href);
    }
  }
  const dashboard = readFileSync(resolve(portal, "components/dashboard/dashboard-view.tsx"), "utf8");
  assert.match(dashboard, /title="Overview"/);
  assert.ok(checked.length >= 20, `only ${checked.length} menu pages checked`);
});

test("no menu page shares its name with its section, so no breadcrumb is dropped", () => {
  for (const section of MENU_SECTIONS) {
    for (const route of NAV_MAP[section]) assert.notEqual(route.label.toLowerCase(), section.toLowerCase(), `${route.href} is called ${section}, like its section`);
  }
});

test("each URL is the page's menu name or its section's", () => {
  // Restore settings at /restore and Value report at /reports keep their section's name.
  for (const section of NAV_SECTIONS) {
    for (const route of NAV_MAP[section].filter((candidate) => !candidate.hidden && candidate.href !== "/")) {
      const slug = route.href.slice(1).split("-").join(" ");
      const words = `${route.label} ${section}`.toLowerCase().replace(/[^a-z ]/g, "");
      assert.ok(words.includes(slug), `${route.href} does not name "${route.label}"`);
    }
  }
});

test("every old URL sends you to its page's new name, and no page links to an old one", () => {
  for (const [from, to] of Object.entries(RENAMED_ROUTES)) {
    assert.equal(renamedPath(from), to);
    assert.equal(renamedPath(`${from}/x`), `${to}/x`);
    assert.equal(renamedPath(`${from}x`), null, `${from}x is another page`);
    assert.ok(readFileSync(pageFile(to), "utf8").length > 0, `${to} has a page`);
    assert.throws(() => readFileSync(pageFile(from)), `${from} still has a page of its own`);
  }
  assert.equal(renamedPath("/changes"), null);
  assert.equal(renamedPath("/api/drift"), null);

  const old = new RegExp(`["'\`(]/(${Object.keys(RENAMED_ROUTES).map((path) => path.slice(1)).join("|")})(?=["'\`/?#)]|$)`);
  const sources = [
    ...files(resolve(portal, "app"), (name) => /\.tsx?$/.test(name)),
    ...files(resolve(portal, "components"), (name) => /\.tsx?$/.test(name)),
    ...files(resolve(portal, "lib"), (name) => /\.tsx?$/.test(name) && name !== "route-names.ts"),
  ];
  for (const file of sources) {
    readFileSync(file, "utf8").split("\n").forEach((line, index) => {
      if (/^\s*(\/\/|\*)/.test(line)) return; // A comment may name a Graph path ("/policies/x").
      assert.doesNotMatch(line, old, `${relative(portal, file)}:${index + 1} links to an old URL`);
    });
  }
});

test("the browser tab names the page, then Keel", () => {
  assert.equal(tabTitle("Changes"), "Changes · Keel");
  assert.equal(tabTitle(" Finance "), "Finance · Keel");
  assert.equal(tabTitle(""), "Keel");
  const header = readFileSync(resolve(portal, "components/page-header.tsx"), "utf8");
  assert.match(header, /<title>\{tabTitle\(title\)\}<\/title>/);
  // The layout sets no title of its own, so the page's is the only one.
  assert.doesNotMatch(readFileSync(resolve(appDirectory, "layout.tsx"), "utf8"), /\btitle:/);
});

test("a breadcrumb names the menu page the person came from", () => {
  const usual = { section: "Audit log" as const, parents: [{ href: "/activity", label: "Activity" }] };
  const hosts = ["keel.example.com"];
  // A restore follow-up opened from Restore: Restore › Restore settings › Job.
  assert.deepEqual(cameFrom("https://keel.example.com/restore", hosts, usual), { section: "Restore", parents: [{ href: "/restore", label: "Restore settings" }] });
  // Filters on the page you came from are kept, so the crumb goes back to the same list.
  assert.deepEqual(cameFrom("https://keel.example.com/schedules?state=failed", hosts, usual), { section: "Backup", parents: [{ href: "/schedules?state=failed", label: "Schedules" }] });
  assert.deepEqual(cameFrom("https://keel.example.com/rules", hosts, usual).parents, [{ href: "/rules", label: "Automatic rules" }]);
  // The usual parent, another site, a page outside the menu, nothing at all: the usual trail.
  assert.equal(cameFrom("https://keel.example.com/activity?show=jobs", hosts, usual), usual);
  assert.equal(cameFrom("https://elsewhere.example/restore", hosts, usual), usual);
  assert.equal(cameFrom("https://keel.example.com/jobs/abc", hosts, usual), usual);
  assert.equal(cameFrom("https://keel.example.com/backups", hosts, usual), usual, "a redirect page is not a menu page");
  assert.equal(cameFrom(null, hosts, usual), usual);
  assert.equal(cameFrom("not a url", hosts, usual), usual);
  assert.equal(cameFrom("https://keel.example.com/restore", [null], usual), usual);
  // Behind a proxy that names the site in X-Forwarded-Host.
  assert.equal(cameFrom("https://keel.example.com/restore", ["127.0.0.1:3000", "keel.example.com"], usual).section, "Restore");
});
