import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, beforeEach, test } from "node:test";

import { capabilitySummaryFor } from "../../engine/coverage/capabilities.mjs";
import { withLiveRecords } from "../../engine/coverage/report.mjs";
import { signEvidence } from "../../tools/release/qualification.mjs";
import { getLiveRecords, resetLiveRecordsCache } from "@/lib/live-records";
import { restoreOperations, workloadLiveLines } from "@/lib/protect-view";
import { qualificationKey } from "@/lib/runtime-config";
import type { CoverageData, CoverageType, WriteCapabilitySummary } from "@/lib/types";

// Gap P2: the portal loads the committed live records, verifies them with the key from
// its own environment, and says why a record does not count. The key is made here.

const COMMITTED = resolve(process.cwd(), "..", "docs", "release", "qualifications");
const TEST_TENANT = "sha256:f7b3959300856957";
const KEY = randomBytes(32).toString("hex");
const scratch = mkdtempSync(join(tmpdir(), "keel-portal-live-"));
const ENV_KEYS = ["KEEL_QUALIFICATION_HMAC_KEY", "KEEL_QUALIFICATION_ENV_PATH", "KEEL_LIVE_EVIDENCE_DIR"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

after(() => {
  rmSync(scratch, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});
beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.KEEL_QUALIFICATION_ENV_PATH = join(scratch, "absent.env");
  resetLiveRecordsCache();
});

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const userUpdate = readJson(join(COMMITTED, "entra-live", "user.update.json"));
const sharepoint = readJson(join(COMMITTED, "sharepoint-live-acceptance.json"));
const FRESH = new Date(Math.max(Date.parse(userUpdate.observedAt), Date.parse(sharepoint.observedAt)) + 24 * 60 * 60 * 1000);

/** The committed user update and SharePoint records, re-signed with this test's key. */
function evidenceDir(name: string): string {
  const dir = join(scratch, name);
  mkdirSync(join(dir, "entra-live"), { recursive: true });
  writeFileSync(join(dir, "entra-live", "user.update.json"), JSON.stringify(signEvidence(userUpdate, KEY, "keel-release-runner")));
  copyFileSync(join(COMMITTED, "entra-live", "user.update.capture.json"), join(dir, "entra-live", "user.update.capture.json"));
  writeFileSync(join(dir, "sharepoint-live-acceptance.json"), JSON.stringify(signEvidence(sharepoint, KEY, "keel-release-runner")));
  copyFileSync(join(COMMITTED, "sharepoint-live-acceptance.capture.json"), join(dir, "sharepoint-live-acceptance.capture.json"));
  return dir;
}

function keyFile(name: string, mode: number): string {
  const path = join(scratch, name);
  writeFileSync(path, `KEEL_QUALIFICATION_HMAC_KEY=${KEY}\n`);
  chmodSync(path, mode);
  return path;
}

function typeWith(writeCapability: WriteCapabilitySummary): CoverageType {
  return { type: "user", writeCapability } as unknown as CoverageType;
}

test("with the key in a mode 600 file, a signed live record shows the operation as proven", () => {
  process.env.KEEL_LIVE_EVIDENCE_DIR = evidenceDir("valid");
  process.env.KEEL_QUALIFICATION_ENV_PATH = keyFile("qualification.env", 0o600);
  const records = getLiveRecords(TEST_TENANT, FRESH);
  assert.equal(records.keyConfigured, true);

  const summary = withLiveRecords(capabilitySummaryFor("user"), records) as WriteCapabilitySummary;
  assert.equal(summary.operations.update.claim, "live-qualified");
  const lines = restoreOperations(typeWith(summary));
  assert.ok(lines.some((line) => /^Can update in place: proven on this tenant by a live run on \d+ \w+ 2026, valid until/.test(line)), lines.join("\n"));

  const sharepointLine = workloadLiveLines({ liveEvidence: { keyConfigured: true, workloads: records.workloads.map((w) => ({ ...w })) } } as unknown as CoverageData);
  assert.match(sharepointLine[0], /^SharePoint site settings: proven on this tenant/);
});

test("without a key every record is not live and the reason is shown", () => {
  process.env.KEEL_LIVE_EVIDENCE_DIR = evidenceDir("nokey");
  const records = getLiveRecords(TEST_TENANT, FRESH);
  assert.equal(records.keyConfigured, false);
  const summary = withLiveRecords(capabilitySummaryFor("user"), records) as WriteCapabilitySummary;
  assert.equal(summary.operations.update.claim, "fixture-tested");
  assert.ok(restoreOperations(typeWith(summary)).includes(
    "Can update in place: tested, not yet proven on this tenant (a live run was recorded but does not count: the key that checks live records is not set up on this server).",
  ));
  const lines = workloadLiveLines({ liveEvidence: { keyConfigured: false, workloads: [...records.workloads] } } as unknown as CoverageData);
  assert.equal(lines[0], "SharePoint site settings: not proven on this tenant. A live run was recorded but does not count: the key that checks live records is not set up on this server.");
});

test("a key file other users can read is refused and the reason says so", () => {
  process.env.KEEL_LIVE_EVIDENCE_DIR = evidenceDir("loose");
  process.env.KEEL_QUALIFICATION_ENV_PATH = keyFile("loose.env", 0o644);
  assert.equal(qualificationKey().key, null);
  const records = getLiveRecords(TEST_TENANT, FRESH);
  assert.equal(records.operations.find((r) => r.operation === "update")?.live, false);
  assert.match(records.operations[0].reason ?? "", /can be read by other users/);
});

test("the environment variable wins; an expired record stops counting on the next refresh", () => {
  process.env.KEEL_LIVE_EVIDENCE_DIR = evidenceDir("expiry");
  process.env.KEEL_QUALIFICATION_HMAC_KEY = KEY;
  assert.equal(getLiveRecords(TEST_TENANT, FRESH).operations[0].live, true);
  const late = new Date(Date.parse(userUpdate.observedAt) + 31 * 24 * 60 * 60 * 1000);
  const expired = getLiveRecords(TEST_TENANT, late).operations[0];
  assert.equal(expired.live, false);
  assert.equal(expired.reason, "it is more than 30 days old");
});

test("records are cached between refreshes and re-read for another tenant", () => {
  process.env.KEEL_LIVE_EVIDENCE_DIR = evidenceDir("cache");
  process.env.KEEL_QUALIFICATION_HMAC_KEY = KEY;
  const first = getLiveRecords(TEST_TENANT, FRESH);
  assert.equal(getLiveRecords(TEST_TENANT, new Date(FRESH.getTime() + 60 * 1000)), first);
  const other = getLiveRecords("sha256:0000000000000000", FRESH);
  assert.notEqual(other, first);
  assert.equal(other.operations[0].reason, "it was recorded on a different tenant");
});

test("the default evidence directory is the repository's committed records", () => {
  process.env.KEEL_QUALIFICATION_HMAC_KEY = KEY;
  const records = getLiveRecords(TEST_TENANT, FRESH);
  assert.ok(records.operations.length > 0);
  // The committed records were signed with the release key, not this test's key.
  assert.ok(records.operations.every((record) => !record.live && record.reason));
});
