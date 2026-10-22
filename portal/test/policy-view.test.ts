import assert from "node:assert/strict";
import { test } from "node:test";

import { createRule, changeRule } from "@/lib/policy-change";
import {
  actionKindLine, actionLine, actionName, actionOutcome, ceilingWords, changeRefusal, failureWords, filterWords, kindWords, lastActionWords, matchWords, namePattern,
  parseFilters, rateWords, ruleCounts, ruleKind, ruleMatches, ruleSentence, ruleState, rulesStatus, rulesVerdict, runAsRef, turnOffDetail, watchChips,
} from "@/lib/policy-view";
import type { Policy, PolicyAction } from "@/lib/policies";
import { renderPoliciesAt, renderPolicy } from "./render-policies";

// Policies (portal audit): the words of the page, checked without a browser.

const NOW = "2026-10-02T09:40:00Z";
const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
// The text a person reads: attributes that carry an id for a link or a row are not it.
const visible = (html: string) => html.replace(/(href|title|value|data-row-id|aria-labelledby|id|for)="[^"]*"/g, "");

const undo: Policy = {
  id: "7a1d0f3e-0000-4000-8000-000000000001", name: "Undo low-risk changes", enabled: true, paused_at: null, run_as_repair_required: false,
  run_as_principal_id: "3f9c2b1e-0000-4000-8000-000000000002",
  run_as_principal: { id: "3f9c2b1e-0000-4000-8000-000000000002", email: "svc-policy@contoso.com", name: "Policy service account", readable: true },
  resource_type: null, blast_radius: "cosmetic", natural_key_glob: null, change_type: "modified", action: "auto_remediate",
  max_blast_radius: "cosmetic", max_actions_per_window: 50, window_seconds: 3600, created_by: "8c1e0000-0000-4000-8000-0000000000a1", created_at: "2026-09-12T08:00:00Z",
  last_action_at: "2026-10-02T07:40:00Z", last_action_status: "executed", last_action_natural_key: "namedLocation:Branch offices", last_action_job_id: "a3",
  last_action_name: "Branch offices", last_action_resource_type: "namedLocation", actions_last_7_days: 14,
};
const none = { last_action_at: null, last_action_status: null, last_action_natural_key: null, last_action_job_id: null, last_action_name: null, last_action_resource_type: null, actions_last_7_days: 0 };
const approval: Policy = { ...undo, ...none, id: "7a1d0f3e-0000-4000-8000-000000000005", name: "Ask before changing sign-in rules", action: "require_approval", resource_type: "conditionalAccessPolicy", blast_radius: null, change_type: null, max_blast_radius: "access-affecting", max_actions_per_window: 10, paused_at: "2026-10-02T08:55:00Z", run_as_principal: null, run_as_principal_id: null };
const stopped: Policy = { ...undo, ...none, id: "7a1d0f3e-0000-4000-8000-000000000006", name: "Undo mail flow changes", run_as_repair_required: true, max_actions_per_window: null, window_seconds: null };
const off: Policy = { ...undo, ...none, id: "7a1d0f3e-0000-4000-8000-000000000004", name: "Undo changes to admin groups", enabled: false, resource_type: "group", natural_key_glob: "group:Admin*", blast_radius: null, change_type: null, max_blast_radius: "access-affecting", max_actions_per_window: 5 };
const alert: Policy = { ...undo, ...none, id: "7a1d0f3e-0000-4000-8000-000000000003", name: "Alert on lockout risk", action: "alert", blast_radius: "tenant-lockout", change_type: null, max_blast_radius: "tenant-lockout", max_actions_per_window: null, window_seconds: null, run_as_principal: null, run_as_principal_id: null };
const all = [undo, approval, stopped, off, alert];

test("a rule's sentence says what it does to what, in plain words", () => {
  assert.equal(ruleSentence(undo), "Undoes low-risk changes to anything, up to 50 an hour.");
  assert.equal(ruleSentence(approval), "Asks an approver before undoing changes to sign-in rules, up to 10 an hour.");
  assert.equal(ruleSentence(off), "Undoes changes to groups with a name like “Admin*”, up to 5 an hour.");
  assert.equal(ruleSentence(alert), "Alerts on changes to anything that could lock out admins and changes nothing.");
  assert.equal(matchWords({ ...undo, change_type: "added", blast_radius: "access-affecting", resource_type: "roleAssignment" }), "additions of role assignments that affect access");
  assert.equal(kindWords({ resource_type: "conditionalAccessPolicy", natural_key_glob: null }), "sign-in rules");
  assert.equal(kindWords({ resource_type: null, natural_key_glob: "group:Admin*" }), "groups");
  assert.equal(namePattern({ natural_key_glob: "group:*" }), null);
  assert.equal(rateWords({ max_actions_per_window: 3, window_seconds: 86_400 }), "3 a day");
  assert.equal(rateWords({ max_actions_per_window: null, window_seconds: null }), null);
  assert.equal(ceilingWords(off), "Affects access");
  assert.deepEqual(watchChips(off).map((chip) => chip.label), ["Groups", "Any change", "Any risk", "Name like “Admin*”"]);
  assert.deepEqual(watchChips(undo).map((chip) => chip.label), ["Anything", "Changed", "Low risk"]);
  for (const text of all.flatMap((policy) => [ruleSentence(policy), ...watchChips(policy).map((chip) => chip.label)])) {
    assert.doesNotMatch(text, /auto_remediate|require_approval|tenant-lockout|cosmetic|group:|conditionalAccessPolicy/);
  }
});

test("kind, state, counts, status and the verdict", () => {
  assert.deepEqual(all.map(ruleKind), ["undo", "approval", "undo", "undo", "alert"]);
  assert.deepEqual(all.map(ruleState), ["running", "paused", "stopped", "off", "running"]);
  assert.deepEqual(ruleCounts(all), { total: 5, running: 2, paused: 1, stopped: 1, off: 1, undoOff: 1, actionsWeek: 14 });
  assert.deepEqual(rulesStatus(ruleCounts(all), false), { tone: "urgent", label: "1 stopped" });
  assert.deepEqual(rulesStatus(ruleCounts([undo, approval]), false), { tone: "soon", label: "1 paused" });
  assert.deepEqual(rulesStatus(ruleCounts([undo]), false), { tone: "fine", label: "Automation on" });
  assert.deepEqual(rulesStatus(ruleCounts([undo]), true), { tone: "urgent", label: "Automation halted" });
  // Stopped beats paused; paused names the rule and is what Resume resumes; halted beats everything.
  const stoppedFirst = rulesVerdict(all, false, NOW);
  assert.equal(stoppedFirst.text, "Undo mail flow changes is stopped: the account it acts as needs repair.");
  assert.equal(stoppedFirst.resume, null);
  const paused = rulesVerdict([undo, approval, alert], false, NOW);
  assert.equal(paused.text, "Ask before changing sign-in rules paused itself after hitting its limit 45 minutes ago.");
  assert.equal(paused.resume?.id, approval.id);
  assert.equal(rulesVerdict([undo, alert], false, NOW).text, "2 rules running; nothing needs you.");
  assert.equal(rulesVerdict([undo, alert], false, NOW).detail, "14 actions this week.");
  assert.equal(rulesVerdict([], false, NOW).text, "No automatic rules yet. Keel only reports changes; nothing acts on its own.");
  assert.equal(rulesVerdict(all, true, NOW).tone, "urgent");
  for (const verdict of [stoppedFirst, paused, rulesVerdict(all, true, NOW)]) assert.ok(verdict.text.split(/\s+/).length <= 25, verdict.text);
});

test("tiles filter by state, paused covering stopped; the note names the filter", () => {
  const get = (search: string) => (key: string) => new URLSearchParams(search).get(key);
  assert.deepEqual(parseFilters(get("state=paused")), { state: "paused", what: null });
  assert.deepEqual(parseFilters(get("state=bogus&what=alert")), { state: null, what: "alert" });
  assert.deepEqual(all.filter((policy) => ruleMatches(policy, { state: "paused", what: null })).map((policy) => policy.name), ["Ask before changing sign-in rules", "Undo mail flow changes"]);
  assert.deepEqual(all.filter((policy) => ruleMatches(policy, { state: "off", what: null })).map((policy) => policy.name), ["Undo changes to admin groups"]);
  assert.deepEqual(all.filter((policy) => ruleMatches(policy, { state: "running", what: "undo" })).map((policy) => policy.name), ["Undo low-risk changes"]);
  assert.equal(filterWords({ state: "paused", what: null }), "paused or stopped rules");
  assert.equal(filterWords({ state: null, what: "alert" }), "alert only rules");
});

test("the last action, the run-as account and the action history read as names, never ids", () => {
  assert.equal(lastActionWords(undo, NOW), "Last undid Branch offices 2 hours ago");
  assert.equal(lastActionWords(approval, NOW), "Hit its limit 45 minutes ago");
  assert.equal(lastActionWords(stopped, NOW), "Needs the restorer role");
  assert.equal(lastActionWords(off, NOW), "Preview to turn on");
  assert.equal(lastActionWords(alert, NOW), "Has not acted yet");
  assert.equal(lastActionWords({ ...undo, last_action_status: "failed", last_action_name: null }, NOW), "Last failed on an unnamed trusted location 2 hours ago");
  assert.deepEqual(runAsRef(undo), { kind: "person", id: undo.run_as_principal_id, name: "Policy service account", email: "svc-policy@contoso.com", readable: true });
  assert.equal(runAsRef(alert), null);
  const action: PolicyAction = { job_id: "a3", status: "failed", queued_at: "2026-10-02T07:38:00Z", finished_at: "2026-10-02T07:40:00Z", error: "Graph 403: Authorization_RequestDenied on PATCH /groups/5d1c0000-0000-4000-8000-0000000000f2\nat x", drift_id: "d1", natural_key: "group:Helpdesk admins", resource_type: "group", change_type: "modified", blast_radius: "cosmetic", name: "Helpdesk admins" };
  assert.deepEqual(actionOutcome(action), { label: "Failed", tone: "urgent", icon: "x-circle" });
  assert.equal(actionOutcome({ status: "executed" }).label, "Undone");
  assert.equal(actionOutcome({ status: "queued" }).label, "Waiting");
  assert.equal(actionName(action), "Helpdesk admins");
  assert.equal(actionName({ name: null, resource_type: "namedLocation" }), "Unnamed trusted location");
  assert.equal(actionKindLine(action), "Group · Entra ID · changed");
  assert.equal(actionLine(action, NOW), "Microsoft refused the write: not enough rights · 2 hours ago");
  assert.equal(failureWords("Graph 429: throttled after 5 retries"), "Microsoft throttled the request");
  assert.equal(failureWords("conflict on 5d1c0000-0000-4000-8000-0000000000f2"), "Microsoft 365 would not accept what Keel sent");
  assert.equal(failureWords(null), "It stopped with an error");
  assert.equal(actionLine({ ...action, status: "queued", finished_at: null, error: null }, NOW), "Waiting to run · queued 2 hours ago");
  assert.equal(actionLine({ ...action, status: "executed", error: null }, NOW), "Put back · 2 hours ago");
});

test("turning rules off says what happens first; refusals read in words", () => {
  assert.equal(turnOffDetail(2, 1, 0), "They stop acting on new changes. The undo rule needs a preview to turn back on.");
  assert.equal(turnOffDetail(3, 2, 1), "They stop acting on new changes. 2 undo rules need a preview to turn back on. 1 is already off and stays as it is.");
  assert.equal(turnOffDetail(1, 0, 0), "It stops acting on new changes.");
  assert.equal(changeRefusal(409, "activation_preview_required", "turn-on"), "Undo rules turn on from a preview on the rule's page.");
  assert.equal(changeRefusal(409, "conflict", "resume"), "The account this rule acts as can no longer undo changes. Give it the restorer role first.");
  assert.equal(changeRefusal(403, undefined, "turn-off"), "You do not have the policies permission.");
});

test("the controls call the guarded routes with an idempotency key, and read the refusal", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    if (String(url).endsWith("/enabled") && JSON.parse(String(init?.body)).enabled === true) return new Response(JSON.stringify({ error: "activation_preview_required" }), { status: 409 });
    if (String(url).endsWith("/api/policies")) return new Response(JSON.stringify({ policy: { id: "7a1d0f3e-0000-4000-8000-000000000009" } }), { status: 201 });
    return new Response(JSON.stringify({ policy: {} }), { status: 200 });
  }) as typeof fetch;
  try {
    assert.deepEqual(await changeRule(undo.id, "turn-off"), { ok: true });
    assert.deepEqual(await changeRule(approval.id, "resume"), { ok: true });
    assert.deepEqual(await changeRule(off.id, "turn-on"), { ok: false, reason: "Undo rules turn on from a preview on the rule's page." });
    assert.deepEqual(await createRule({ name: "Alert on lockout risk", action: "alert", maxBlastRadius: "tenant-lockout" }), { ok: true, id: "7a1d0f3e-0000-4000-8000-000000000009" });
    assert.deepEqual(calls.map((call) => `${call.init.method} ${call.url}`), [
      `POST /api/policies/${undo.id}/enabled`, `POST /api/policies/${approval.id}/clear-pause`, `POST /api/policies/${off.id}/enabled`, "POST /api/policies",
    ]);
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), { enabled: false });
    for (const call of calls) assert.match(String((call.init.headers as Record<string, string>)["idempotency-key"]), GUID);
  } finally {
    globalThis.fetch = original;
  }
});

test("the list and the rule page keep ids, emails and codes inside the record", async () => {
  const list = await renderPoliciesAt("state=paused", { canEdit: true, policies: all, halted: false, now: NOW });
  const [outside, record] = list.split('data-layer="record"');
  assert.match(outside, /Showing paused or stopped rules only: 2 of 5\./);
  assert.match(outside, /Ask before changing sign-in rules/);
  assert.doesNotMatch(outside, /Undo low-risk changes</, "the running rule is filtered out");
  assert.match(outside, />Resume</, "Resume is the page's action while a rule is paused");
  assert.doesNotMatch(visible(outside), GUID);
  assert.doesNotMatch(visible(outside), /svc-policy@|lee\.chen@|auto_remediate|conditionalAccessPolicy/);
  for (const id of [approval.id, stopped.id, undo.run_as_principal_id, "svc-policy@contoso.com"]) assert.ok(record.includes(id!), `record keeps ${id}`);
  // The rule page: the sentence once, the chips, the actions with their job links, one record.
  const action: PolicyAction = { job_id: "a3", status: "executed", queued_at: "2026-10-02T07:38:00Z", finished_at: "2026-10-02T07:40:00Z", error: null, drift_id: "d9200000-0000-4000-8000-000000000012", natural_key: "namedLocation:Branch offices", resource_type: "namedLocation", change_type: "modified", blast_radius: "cosmetic", name: "Branch offices" };
  const page = await renderPolicy({ canEdit: true, policy: undo, actions: [action], halted: false, now: NOW });
  const [pageOutside, pageRecord] = page.split('data-layer="record"');
  assert.equal(pageOutside.split("Undoes low-risk changes to anything, up to 50 an hour.").length, 2, "the sentence appears once");
  assert.match(pageOutside, /href="\/jobs\/a3"/);
  assert.match(pageOutside, /Branch offices/);
  assert.match(pageOutside, /Policy service account/);
  assert.match(pageOutside, />Turn off</);
  assert.doesNotMatch(pageOutside, /Preview turning on|>Turn on</);
  assert.doesNotMatch(visible(pageOutside), GUID);
  assert.ok(pageRecord.includes("d9200000-0000-4000-8000-000000000012"));
  // An undo rule that is off: "Preview turning on" is the one amber action and there is no plain Turn on.
  const offPage = await renderPolicy({ canEdit: true, policy: off, actions: [], halted: false, now: NOW });
  const [offOutside] = offPage.split('data-layer="record"');
  assert.equal((offOutside.match(/btn-primary/g) ?? []).length, 1);
  assert.match(offOutside, /btn btn-primary btn-sm"[^>]*>(<[^>]+>)*<svg[\s\S]*?Preview turning on/);
  assert.doesNotMatch(offOutside, />Turn on</);
  // A viewer sees no controls.
  const viewer = await renderPolicy({ canEdit: false, policy: approval, actions: [], halted: false, now: NOW });
  assert.doesNotMatch(viewer, />Resume<|>Turn off<|>Turn on</);
});
