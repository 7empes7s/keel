import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { ACTIVITY_KINDS, ACTIVITY_KIND_ORDER, RECORD_KIND_WORDS } from "@/lib/activity-view";
import { ACTION_PHRASES, EVIDENCE_SENTENCE_KINDS, actionPhrase, evidenceSentence } from "@/lib/sentences";

// Backlog D2: every audit log entry reads as a plain sentence. Each kind of entry the
// engine, the portal or the tools write needs its own sentence, kind name and Activity
// group, and each action the portal records needs its own words. The lists come from the
// source, so a new kind or action fails here until it has words.

const REPO = fileURLToPath(new URL("../../", import.meta.url));

function sourceFiles(directory: string, extensions: RegExp): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", ".next", "test", "fixtures", "ui-harness"].includes(entry.name)) return [];
      return sourceFiles(path, extensions);
    }
    return extensions.test(entry.name) && !/\.test\.[a-z]+$/.test(entry.name) ? [path] : [];
  });
}

/** Every evidence kind written outside tests: [kind, where], or a template prefix. */
function writtenKinds(): { exact: Map<string, string>; prefixes: Map<string, string> } {
  const exact = new Map<string, string>();
  const prefixes = new Map<string, string>();
  const files = [
    ...sourceFiles(resolve(REPO, "engine"), /\.mjs$/),
    ...sourceFiles(resolve(REPO, "tools"), /\.mjs$/),
    ...sourceFiles(resolve(REPO, "portal/lib"), /\.ts$/),
    ...sourceFiles(resolve(REPO, "portal/app"), /\.ts$/),
  ];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const where = relative(REPO, file);
    for (const match of source.matchAll(/EVIDENCE_KIND\s*=\s*["']([^"']+)["']/g)) exact.set(match[1], where);
    for (const call of source.matchAll(/appendEvidence(?:InTransaction)?\(/g)) {
      if (/function\s+$/.test(source.slice(Math.max(0, call.index - 20), call.index))) continue;
      const start = call.index + call[0].length;
      const end = source.indexOf("});", start);
      const args = source.slice(start, end === -1 ? start + 600 : end);
      const kind = /\bkind:\s*(?:["']([^"']+)["']|`([^`$]*)\$\{)/.exec(args);
      if (kind?.[1]) exact.set(kind[1], where);
      else if (kind?.[2]) prefixes.set(kind[2], where);
    }
  }
  return { exact, prefixes };
}

test("the scan finds the kinds it should, so a broken scan cannot pass silently", () => {
  const { exact, prefixes } = writtenKinds();
  for (const kind of ["disposition", "change-intent", "action-attempt", "workload-restore", "policy-activation", "itsm-mirror", "breakglass.registered"]) {
    assert.ok(exact.has(kind), `expected the scan to find ${kind}`);
  }
  assert.ok(prefixes.has("breakglass."), "expected the scan to find the breakglass.<kind> template");
  assert.ok(exact.size >= 35, `only ${exact.size} kinds found`);
});

test("every audit-record kind written anywhere has a sentence, a kind name and an Activity group", () => {
  const { exact, prefixes } = writtenKinds();
  const grouped = new Set(ACTIVITY_KIND_ORDER.flatMap((key) => ACTIVITY_KINDS[key].records));
  for (const [kind, where] of exact) {
    assert.ok(EVIDENCE_SENTENCE_KINDS.includes(kind), `${kind} (written in ${where}) has no sentence in lib/sentences.ts`);
    assert.ok(RECORD_KIND_WORDS[kind], `${kind} (written in ${where}) has no kind name in lib/activity-view.ts`);
    assert.ok(grouped.has(kind), `${kind} (written in ${where}) is in no Activity group`);
  }
  for (const [prefix, where] of prefixes) {
    const covered = EVIDENCE_SENTENCE_KINDS.filter((kind) => kind.startsWith(prefix));
    assert.ok(covered.length > 0, `${prefix}* (written in ${where}) has no sentence`);
    for (const kind of covered) {
      assert.ok(RECORD_KIND_WORDS[kind], `${kind} has no kind name`);
      assert.ok(grouped.has(kind), `${kind} is in no Activity group`);
    }
  }
  for (const kind of EVIDENCE_SENTENCE_KINDS) assert.ok(RECORD_KIND_WORDS[kind], `${kind} has a sentence but no kind name`);
});

test("no sentence shows a code, even with an empty record", () => {
  for (const kind of EVIDENCE_SENTENCE_KINDS) {
    for (const subject of [{}, null, { action: "change-intents:approve", outcome: "refused", decision: "denied" }]) {
      const sentence = evidenceSentence({ kind, actor: "x", subject }, "Lee Chen");
      assert.match(sentence, /^[A-Z]/, `${kind}: ${sentence}`);
      assert.ok(!sentence.includes(kind), `${kind} shows its code: ${sentence}`);
      assert.doesNotMatch(sentence, /\b[a-z]+(?:-[a-z]+)*:[a-z]/, `${kind} shows an action code: ${sentence}`);
      assert.doesNotMatch(sentence, /\bLee Chen: /, `${kind} reads as "name: code": ${sentence}`);
      assert.doesNotMatch(sentence, /\bundefined\b|\bnull\b|\[object/, `${kind}: ${sentence}`);
    }
  }
});

/** Every action name the portal records, from the guard specs in app/ and lib/. */
function recordedActions(): { exact: Set<string>; templates: Set<string> } {
  const exact = new Set<string>();
  const templates = new Set<string>();
  const files = [...sourceFiles(resolve(REPO, "portal/app"), /\.ts$/), ...sourceFiles(resolve(REPO, "portal/lib"), /\.ts$/)];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    if (!/guarded(?:Action)?\(/.test(source)) continue;
    for (const match of source.matchAll(/\baction:\s*"([^"]+)"([^}]{0,300})/g)) {
      if (/capability|recordAttempt|jobKind/.test(match[2])) exact.add(match[1]);
    }
    for (const match of source.matchAll(/\bjobKind:\s*"([^"]+)"/g)) exact.add(match[1]);
    for (const match of source.matchAll(/\baction:\s*`([^`]+)`/g)) templates.add(match[1]);
    // Actions chosen before the spec: `const action = kind === … ? "channels:disable" : …`.
    for (const line of source.split("\n").filter((entry) => /\baction\b.*[?=]/.test(entry) && !/^\s*(\/\/|\*)/.test(entry))) {
      for (const match of line.matchAll(/"([a-z]+(?:-[a-z]+)*:[a-z]+(?:-[a-z]+)*)"/g)) exact.add(match[1]);
    }
  }
  return { exact, templates };
}

test("every action the portal records has words of its own", () => {
  const { exact, templates } = recordedActions();
  for (const action of ["collect", "backup", "change-intents:approve", "policies:list", "restore", "channels:disable", "escalation-rules:enable"]) {
    assert.ok(exact.has(action), `expected the scan to find ${action}`);
  }
  assert.ok(templates.size >= 4, "expected the scan to find the action templates");
  for (const action of exact) assert.ok(ACTION_PHRASES[action], `the action ${action} has no words in ACTION_PHRASES`);
  for (const template of templates) {
    const pattern = new RegExp(`^${template.split(/\$\{[^}]+\}/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[a-z-]+")}$`);
    assert.ok(Object.keys(ACTION_PHRASES).some((key) => pattern.test(key)), `no words for the actions ${template}`);
  }
  for (const [action, phrase] of Object.entries(ACTION_PHRASES)) {
    assert.match(phrase, /^[a-z]/, `${action}: a phrase continues a sentence`);
    assert.doesNotMatch(phrase, /:/, `${action}: ${phrase}`);
  }
  assert.equal(actionPhrase("something-new"), "take an action");
});

test("the entries the audit found read as sentences", () => {
  const sentence = (kind: string, subject: unknown, actor = "Marouane Defili") => evidenceSentence({ kind, actor: "x", subject }, actor);
  // "started a change intents", "started a policies", "Marouane Defili: disposition".
  assert.equal(sentence("action-attempt", { action: "change-intents:approve", decision: "attempted" }), "Marouane Defili started to approve an emergency change");
  assert.equal(sentence("action-attempt", { action: "policies:create", decision: "attempted" }), "Marouane Defili started to create an automatic rule");
  assert.equal(sentence("action-attempt", { action: "policies:list", decision: "denied", reason: "capability" }), "Marouane Defili was not allowed to view automatic rules: their role does not allow it");
  assert.match(
    sentence("disposition", { action: "accept", serviceChangeId: "1", workload: "teams-settings", resourceKey: "TeamsMeetingPolicy:Global", changeType: "modified", reason: "Planned" }),
    /^Marouane Defili accepted the changed setting .*Global.* in Teams settings into the approved setup: “Planned”$/,
  );
  assert.equal(sentence("disposition", { naturalKey: "group:5d1c0000-0000-4000-8000-0000000000f1", resourceType: "group" }), "Marouane Defili accepted a change to Unnamed group into the approved setup");
  // Approvals name the action, not a job-kind label: never "a roll back changes".
  assert.equal(sentence("approval-decision", { decision: "rejected", action: "remediate", reason: "Not now" }), "Marouane Defili rejected a request to roll back changes: “Not now”");
  assert.equal(sentence("approval-decision", { decision: "superseded", action: "restore" }), "A newer request replaced a request to restore from a backup, so it was closed");
  assert.equal(sentence("approval-request", { action: "baseline-activate" }), "Marouane Defili asked for approval to switch to another approved setup");
  assert.equal(sentence("change-intent", { outcome: "settled", naturalKey: "group:5d1c0000-0000-4000-8000-0000000000f1", resourceType: "group", currentState: "matches-baseline" }, "Keel"), "An emergency change to Unnamed group ended; it matches the approved setup again");
  assert.equal(sentence("workload-restore", { operationId: "exchange-mail-flow.restore", outcome: "verified" }), "Marouane Defili ran a restore of Exchange mail flow, which finished and was checked afterwards");
  assert.equal(sentence("itsm-callback", { adapter: "servicenow", outcome: "unmapped-identity" }, "Keel"), "ServiceNow sent an approval update, and Keel refused it because the ServiceNow user is not linked to a Keel account");
  assert.equal(sentence("itsm-callback", { adapter: "servicenow", outcome: "refused-bad-signature" }, "Keel"), "ServiceNow sent an approval update, and Keel refused it because its signature did not match");
  assert.equal(sentence("itsm-callback", { adapter: "servicenow", outcome: "refused-something-new" }, "Keel"), "ServiceNow sent an approval update, and Keel refused it");
  assert.equal(sentence("approval-request", { action: "content-restore" }), "Marouane Defili asked for approval to restore mail, files or Teams content");
  assert.equal(sentence("breakglass.registered", { label: "Emergency Admin 1" }), "Marouane Defili added “Emergency Admin 1” as an emergency access account");
});
