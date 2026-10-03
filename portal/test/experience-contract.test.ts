import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { NAV_MAP, NAV_SECTIONS, sectionForPath, visibleNavEntries } from "@/components/nav-links";
import { DISPLAY_ENUMS, accessSummary, displayEnum } from "@/lib/presentation";

// Roadmap task-129: the portal experience contract's shell. Boundary checks over the
// real page sources and the real navigation map, so a page cannot drift away from
// the one taxonomy and a stored code cannot reach the screen unmapped.

const appDirectory = fileURLToPath(new URL("../app/", import.meta.url));
function pages(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? (entry.name === "api" ? [] : pages(path)) : entry.name === "page.tsx" ? [path] : [];
  });
}
function routeOf(file: string): string {
  const dir = relative(appDirectory, file).replaceAll("\\", "/").replace(/\/?page\.tsx$/, "");
  return `/${dir}`.replace(/\[[^\]]+\]/g, "x").replace(/\/$/, "") || "/";
}

test("seven navigation entries, one map, in the contract's order", () => {
  assert.deepEqual([...NAV_SECTIONS], ["Overview", "Protect", "Changes", "Restore", "Approvals", "Activity", "Settings"]);
  const everything = visibleNavEntries({ canRead: true, canPolicies: true, canUsers: true, canApprove: true });
  assert.equal(everything.length, 7);
  assert.ok(everything.length <= 8, "the index never grows past eight");
  // A viewer without approve or read-gated pages loses entries, never gets empty ones.
  const minimal = visibleNavEntries({});
  assert.deepEqual(minimal.map((entry) => entry.label), ["Overview", "Protect", "Changes", "Restore"]);
  // Settings opens on the first tab the viewer may use.
  assert.equal(visibleNavEntries({ canRead: true }).find((entry) => entry.label === "Settings")?.href, "/notifications");
});

test("every portal page belongs to exactly one section, and every mapped route has a page", () => {
  const routes = pages(appDirectory).map(routeOf);
  for (const route of routes) assert.ok(sectionForPath(route), `${route} has no navigation section`);
  for (const section of NAV_SECTIONS) {
    for (const { href } of NAV_MAP[section]) assert.ok(routes.includes(href), `${href} (${section}) has no page`);
  }
  const all = NAV_SECTIONS.flatMap((section) => NAV_MAP[section].map((route) => route.href));
  assert.equal(new Set(all).size, all.length, "a route sits in one section only");
});

test("every page's eyebrow is the section that owns its route", () => {
  const checked: string[] = [];
  for (const file of pages(appDirectory)) {
    const source = readFileSync(file, "utf8");
    const route = routeOf(file);
    const expected = sectionForPath(route);
    const sections = [...source.matchAll(/section="([^"]+)"/g)].map((match) => match[1]);
    assert.equal(/eyebrow=/.test(source), false, `${route} still sets a free-text eyebrow`);
    for (const section of sections) assert.equal(section, expected, `${route} declares section "${section}"`);
    if (sections.length) checked.push(route);
  }
  // The Overview renders its header through DashboardView.
  const dashboard = readFileSync(fileURLToPath(new URL("../components/dashboard/dashboard-view.tsx", import.meta.url)), "utf8");
  assert.match(dashboard, /section="Overview"/);
  assert.ok(checked.length >= 15, `only ${checked.length} pages declare a section`);
});

test("every display-map entry reads differently from its stored code", () => {
  for (const [group, map] of Object.entries(DISPLAY_ENUMS)) {
    for (const [code, label] of Object.entries(map)) {
      assert.notEqual(label, code, `${group}.${code} is shown as its own code`);
      assert.ok(label.length > 0);
    }
  }
  assert.equal(displayEnum("blastRadius", "tenant-lockout"), "Could lock out admins");
  assert.equal(displayEnum("policyAction", "dispose-accept"), "Accept automatically");
});

test("every stored code the UI fixtures use is in the display map", () => {
  const harness = readFileSync(fileURLToPath(new URL("../ui-harness/app.tsx", import.meta.url)), "utf8");
  const jobs = [...harness.matchAll(/job\("[^"]+", "([^"]+)", "([^"]+)"/g)];
  assert.ok(jobs.length > 0);
  for (const [, kind, status] of jobs) {
    assert.ok(Object.hasOwn(DISPLAY_ENUMS.jobKind, kind), `job kind ${kind} is not in the display map`);
    assert.ok(Object.hasOwn(DISPLAY_ENUMS.jobStatus, status), `job status ${status} is not in the display map`);
  }
  for (const [, action] of harness.matchAll(/action: "([a-z_-]+)"/g)) {
    if (["dispose-accept", "alert", "require_approval", "auto_remediate"].includes(action)) {
      assert.ok(Object.hasOwn(DISPLAY_ENUMS.policyAction, action), `policy action ${action}`);
    }
  }
  for (const [, radius] of harness.matchAll(/blastRadius: "([a-z-]+)"/g)) {
    assert.ok(Object.hasOwn(DISPLAY_ENUMS.blastRadius, radius), `blast radius ${radius}`);
  }
});

test("the sidebar says what you can do in words, never 'capabilities'", () => {
  assert.equal(accessSummary(["read"]), "You can view");
  assert.equal(accessSummary(["read", "approve", "restore"]), "You can approve and restore");
  assert.doesNotMatch(accessSummary(["read", "approve", "restore", "rollback", "collect", "backup", "configuration"]), /capabilit/i);
});
