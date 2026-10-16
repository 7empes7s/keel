import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { MENU_SECTIONS, NAV_MAP, NAV_SECTIONS, sectionForPath, visibleNavEntries } from "@/components/nav-links";
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

test("eight menu sections, one map, in the order Marouane set; approvals and alerts sit behind the bell", () => {
  assert.deepEqual([...MENU_SECTIONS], ["Dashboards", "Backup", "Restore", "Baselines", "Reports", "Automation center", "Audit log", "Settings"]);
  assert.deepEqual([...NAV_SECTIONS], [...MENU_SECTIONS, "Inbox"]);
  const everything = visibleNavEntries({ canRead: true, canPolicies: true, canUsers: true, canApprove: true, canConfigure: true });
  assert.equal(everything.length, 8);
  assert.ok(everything.every((entry) => entry.group !== "Inbox"), "the inbox is reached from the bell, not the menu list");
  // A viewer without read-gated pages loses sections, never gets empty ones.
  const minimal = visibleNavEntries({});
  assert.deepEqual(minimal.map((entry) => entry.label), ["Dashboards", "Backup", "Restore", "Baselines"]);
  // Settings opens on the first page the viewer may use.
  assert.equal(visibleNavEntries({ canRead: true }).find((entry) => entry.label === "Settings")?.href, "/notifications");
  // The plan's route map (PLAN.md section 7).
  const owner = (href: string) => sectionForPath(href);
  assert.equal(owner("/protect"), "Backup");
  assert.equal(owner("/drift"), "Baselines");
  assert.equal(owner("/compare"), "Baselines");
  assert.equal(owner("/emergency-changes"), "Automation center");
  assert.equal(owner("/policies/p1"), "Automation center");
  assert.equal(owner("/reports"), "Reports");
  assert.equal(owner("/evidence"), "Audit log");
  assert.equal(owner("/approvals"), "Inbox");
  assert.equal(owner("/alerts"), "Inbox");
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

test("every page's header names the section that owns its route", () => {
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
  assert.match(dashboard, /section="Dashboards"/);
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

test("the menu says what you can do in words, never 'capabilities'", () => {
  assert.equal(accessSummary(["read"]), "You can view");
  assert.equal(accessSummary(["read", "approve", "restore"]), "You can approve and restore");
  assert.doesNotMatch(accessSummary(["read", "approve", "restore", "rollback", "collect", "backup", "configuration"]), /capabilit/i);
});
