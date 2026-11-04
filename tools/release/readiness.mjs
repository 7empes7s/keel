#!/usr/bin/env node
/**
 * Release readiness recorder (roadmap task-45). Read-only by construction:
 * it records the source and deployed revisions, the portal health probe and
 * authenticated feature-probe outcomes into docs/release/readiness.json.
 * It never changes deployment state and never prints session material.
 *
 *   node tools/release/readiness.mjs [--portal-url http://localhost:3000]
 *     [--source /opt/keel] [--deployed /opt/keel-live]
 *     [--session-env KEEL_PORTAL_SESSION] [--out docs/release/readiness.json]
 *
 * The session assertion is read from the environment variable named by
 * --session-env (the Cloudflare Access JWT for the portal). A missing
 * session yields probe outcome 'unknown' — never 'pass'. A healthy portal
 * with an unauthorized feature probe does not prove feature parity: the
 * verdict stays 'not-ready'.
 */

import { execFileSync } from 'node:child_process';
import fs, { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path, { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { HYBRID_RUNTIME, hybridRuntimeInventory, runtimeDeclarationProblems } from '../../engine/contracts/topology.mjs';
import { WORKLOAD_WRITE_OPERATIONS, buildOperationLedger } from '../../engine/coverage/qualification.mjs';
import { NATIVE_RECOVERY_ROUTES } from '../../engine/restore/recoveryMechanism.mjs';
import { DSC_WRITES_LIVE_GATE } from '../qualification/dscDistributionGroupsAcceptance.mjs';
import { ROLE_WRITES_LIVE_GATE } from '../qualification/exchangeRoleDefinitionsAcceptance.mjs';
import { evidenceStem, registeredOperations } from '../qualification/live-gate-plan.mjs';
import { UNPUBLISH_LIVE_GATE } from '../qualification/purviewUnpublishAcceptance.mjs';
import { SITE_GRANTS_LIVE_GATE } from '../qualification/sharepointSiteGrantsAcceptance.mjs';
import { SITE_PERMISSIONS_LIVE_GATE } from '../qualification/sharepointSitePermissionsAcceptance.mjs';
import { STRUCTURE_WRITES_LIVE_GATE } from '../qualification/sharepointStructureWritesAcceptance.mjs';
import { READ_FAMILIES, WORKLOAD_READS_LIVE_GATE, workloadReadsRecordFile } from '../qualification/workloadReadsAcceptance.mjs';
import { WORKLOAD_WRITES_LIVE_GATE, WRITTEN_WORKLOADS, workloadWritesRecordFile } from '../qualification/workloadWritesAcceptance.mjs';
import {
  LIVE_ACCEPTANCE_GATES, OBJECTIVE_GAPS_DECISION, RELEASE_OBJECTIVES, classifyEntraOperation, loadEntraLiveFiles,
} from './acceptanceLedger.mjs';
import {
  DEFAULT_MAX_AGE_HOURS, DEPLOYED_ACCEPTANCE_GATE, DEPLOYED_ACCEPTANCE_MAX_AGE_HOURS, verifyEvidence,
} from './qualification.mjs';

export const READINESS_CONTRACT_VERSION = 1;

export const ACCESS_ASSERTION_HEADER = 'cf-access-jwt-assertion';

export const DEFAULT_FEATURE_PROBES = Object.freeze([
  { feature: 'coverage', path: '/api/coverage' },
  { feature: 'drift', path: '/api/drift' },
  { feature: 'jobs', path: '/api/jobs' },
]);

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}

/** Revision of a git checkout, or null when the path is absent/not a repo. */
export function gitRevision(execFn, repoPath) {
  try {
    const revision = execFn(['-C', repoPath, 'rev-parse', 'HEAD']).trim();
    const dirty = execFn(['-C', repoPath, 'status', '--porcelain']).trim().length > 0;
    return { path: repoPath, revision, dirty };
  } catch {
    return null;
  }
}

/**
 * One authenticated feature probe. Without a session assertion the outcome is
 * 'unknown' — an unauthenticated probe can never pass. 401/403 is recorded as
 * 'unauthorized', which is evidence of absence for parity, not a failure to
 * reach the server.
 */
export async function probeFeature(fetchFn, baseUrl, { feature, path }, sessionAssertion) {
  if (!sessionAssertion) {
    return { feature, path, outcome: 'unknown', reason: 'no-session' };
  }
  let response;
  try {
    response = await fetchFn(new URL(path, baseUrl), {
      headers: { [ACCESS_ASSERTION_HEADER]: sessionAssertion },
    });
  } catch {
    return { feature, path, outcome: 'unknown', reason: 'unreachable' };
  }
  if (response.status === 200) return { feature, path, outcome: 'pass', httpStatus: 200 };
  if (response.status === 401 || response.status === 403) {
    return { feature, path, outcome: 'unauthorized', httpStatus: response.status };
  }
  return { feature, path, outcome: 'fail', httpStatus: response.status };
}

export async function buildReadiness({
  execFn, fetchFn, sourcePath, deployedPath, portalUrl,
  sessionAssertion = null, featureProbes = DEFAULT_FEATURE_PROBES, now = new Date(),
}) {
  const source = gitRevision(execFn, sourcePath);
  const deployed = deployedPath ? gitRevision(execFn, deployedPath) : null;

  let health;
  try {
    const response = await fetchFn(new URL('/api/health', portalUrl));
    health = { httpStatus: response.status, ok: response.status === 200 };
  } catch {
    health = { httpStatus: null, ok: false, error: 'unreachable' };
  }

  const probes = [];
  for (const probe of featureProbes) {
    probes.push(await probeFeature(fetchFn, portalUrl, probe, sessionAssertion));
  }

  // null = at least one side unknown; the verdict can then never be 'ready'.
  const revisionMatch = source?.revision && deployed?.revision
    ? source.revision === deployed.revision
    : null;

  // 'ready' requires affirmative evidence on every axis. Any definitive
  // negative is 'not-ready'; anything unproven — including a missing session —
  // is 'unknown', never a pass.
  let verdict;
  if (
    !health.ok
    || probes.some((p) => p.outcome === 'unauthorized' || p.outcome === 'fail')
    || revisionMatch === false
  ) {
    verdict = 'not-ready';
  } else if (!sessionAssertion || probes.some((p) => p.outcome === 'unknown') || revisionMatch === null) {
    verdict = 'unknown';
  } else {
    verdict = 'ready';
  }

  return {
    contractVersion: READINESS_CONTRACT_VERSION,
    generatedAt: now.toISOString(),
    source,
    deployed,
    revisionMatch,
    portal: { url: portalUrl, health },
    probes,
    verdict,
  };
}

// ---------------------------------------------------------------------------
// Release sign-off (roadmap task-124).
//
// One candidate build is judged against every checked-in live record. A record
// counts only when it is fresh (30 days; 7 for deployed acceptance), was
// captured at the candidate build and verifies with --require-live semantics.
// Evidence from another build decides nothing at the candidate: it is listed
// for recapture, never as qualified and never as a failure of the candidate.
// The report keeps four things apart for every objective: implemented (its
// tests exist), live-qualified (its gates verify at the candidate), manual or
// unsupported routes, and deferred scope. Nothing here captures, signs,
// deploys or edits evidence.
// ---------------------------------------------------------------------------

export const SIGNOFF_CONTRACT_VERSION = 1;
export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const QUALIFICATIONS_PATH = 'docs/release/qualifications';
const HOUR_MS = 60 * 60 * 1000;

/** Gate states, worst first. Only 'live-qualified' counts toward ready. */
export const GATE_STATES = Object.freeze([
  'failed', 'demoted', 'missing', 'placeholder', 'stale', 'other-build', 'unverified', 'live-qualified',
]);
/** States a recapture at the candidate build fixes ('failed' and 'demoted' need a code look first). */
export const RECAPTURE_STATES = Object.freeze(['failed', 'demoted', 'missing', 'placeholder', 'stale', 'other-build']);

const VERIFY = (gate, file) => `node tools/release/qualification.mjs verify --require-live --gate ${gate} `
  + `--evidence ${QUALIFICATIONS_PATH}/${file} --tenant <tenant ref> --build <B>`;
const HMAC = 'KEEL_QUALIFICATION_HMAC_KEY=... ';

/**
 * How to capture each single-record gate. Commands are copied from
 * docs/roadmap/operator-gates.md and each gate's doc; "[see doc]" means the
 * full flag list is in the linked doc, which the operator follows.
 */
const CAPTURE = Object.freeze({
  'deployed-acceptance': {
    doc: 'docs/roadmap/deployed-acceptance.md',
    capture: 'node tools/release/deployed-acceptance.mjs capture --portal-url https://<portal-host> --source /opt/keel --deployed /opt/keel-live --build <B> --out docs/release/qualifications/deployed-acceptance.json',
  },
  'storage-live-acceptance': {
    doc: 'docs/roadmap/storage-live-acceptance.md',
    capture: `sudo -u keel-recovery env ${HMAC}KEEL_TENANT_CONFIG_PATH=/etc/keel/tenant.json node tools/qualification/storageLiveAcceptance.mjs capture --live --primary-root ... --copy-root ... [see doc]`,
  },
  'native-live-acceptance': {
    doc: 'docs/roadmap/native-live-acceptance.md',
    capture: `${HMAC}node tools/qualification/nativeRecovery.mjs capture --live --resource-type group --object-id <id> --confirm-disposable-fixture <id> --target-config /etc/keel/restorer.json --docs-retrieved-at <YYYY-MM-DD> --permission Group.ReadWrite.All --out docs/release/qualifications`,
  },
  'drill-live-acceptance': {
    doc: 'docs/roadmap/drill-live-acceptance.md',
    capture: 'node tools/release/qualification.mjs capture-drill --out docs/release/qualifications/drill-live-acceptance.json --db-url "$KEEL_DB_TEST_URL" --tenant <tenant ref> --reconstruction reconstruction.json --onboarding onboarding.json --build <B>',
  },
  'sentinel-live-acceptance': {
    doc: 'docs/roadmap/sentinel-live-acceptance.md',
    capture: 'node tools/qualification/sentinelLive.mjs capture --confirm-live-workspace-ingest [see doc] --out docs/release/qualifications/sentinel-live-acceptance.json',
  },
  'servicenow-live-acceptance': {
    doc: 'docs/roadmap/servicenow-live-acceptance.md',
    capture: 'node tools/qualification/servicenowLive.mjs capture --confirm-non-production-instance <instance host> --declared-by "<you>" [see doc] --out docs/release/qualifications/servicenow-live-acceptance.json',
  },
  'nist-benchmark-acceptance': {
    doc: 'docs/roadmap/nist-benchmark-acceptance.md',
    capture: `${HMAC}node tools/qualification/nistLive.mjs capture --live --db-url "$KEEL_DB_URL" --principal-email <operator email> --tenant <tenant ref> --build <B> --out docs/release/qualifications/nist-benchmark-acceptance.json`,
  },
  'sharepoint-live-acceptance': {
    doc: 'docs/roadmap/sharepoint-live-acceptance.md',
    capture: 'node tools/qualification/sharepointLive.mjs capture --confirm-live-tenant-write [see doc] --out docs/release/qualifications/sharepoint-live-acceptance.json',
  },
  'teams-live-acceptance': {
    doc: 'docs/roadmap/teams-live-acceptance.md',
    capture: 'node tools/qualification/teamsLive.mjs capture --confirm-live-tenant-write [see doc] --sharepoint-evidence docs/release/qualifications/sharepoint-live-acceptance.json --out docs/release/qualifications/teams-live-acceptance.json',
  },
  'exchange-live-acceptance': {
    doc: 'docs/roadmap/exchange-live-acceptance.md',
    capture: 'node tools/qualification/exchangeLive.mjs capture --confirm-live-tenant-write [see doc] --teams-evidence docs/release/qualifications/teams-live-acceptance.json --out docs/release/qualifications/exchange-live-acceptance.json',
  },
  'onedrive-purview-live-acceptance': {
    doc: 'docs/roadmap/onedrive-purview-live-acceptance.md',
    capture: 'node tools/qualification/onedrivePurviewLive.mjs capture --confirm-live-tenant-write [see doc] --exchange-evidence docs/release/qualifications/exchange-live-acceptance.json --out docs/release/qualifications/onedrive-purview-live-acceptance.json',
  },
  [SITE_GRANTS_LIVE_GATE]: { doc: 'tools/qualification/sharepointSiteGrantsLive.mjs', tool: 'sharepointSiteGrantsLive' },
  [SITE_PERMISSIONS_LIVE_GATE]: { doc: 'tools/qualification/sharepointSitePermissionsLive.mjs', tool: 'sharepointSitePermissionsLive' },
  [STRUCTURE_WRITES_LIVE_GATE]: { doc: 'tools/qualification/sharepointStructureWritesLive.mjs', tool: 'sharepointStructureWritesLive' },
  [DSC_WRITES_LIVE_GATE]: { doc: 'tools/qualification/dscDistributionGroupsLive.mjs', tool: 'dscDistributionGroupsLive' },
  [ROLE_WRITES_LIVE_GATE]: { doc: 'tools/qualification/exchangeRoleDefinitionsLive.mjs', tool: 'exchangeRoleDefinitionsLive' },
  [UNPUBLISH_LIVE_GATE]: { doc: 'tools/qualification/purviewUnpublishLive.mjs', tool: 'purviewUnpublishLive' },
  'scubagear-benchmark-acceptance': {
    doc: 'docs/roadmap/scubagear-benchmark-acceptance.md',
    capture: 'run ScubaGear on the test tenant and import its runner evidence as the doc describes [see doc] --out docs/release/qualifications/scubagear-benchmark-acceptance.live.json',
  },
});

function captureFor(gate, file) {
  const entry = CAPTURE[gate];
  const capture = entry.capture ?? `${HMAC}node tools/qualification/${entry.tool}.mjs capture --confirm-live-tenant-write `
    + `[all flags: see the tool's header] --build <B> --out ${QUALIFICATIONS_PATH}/${file}`;
  return { doc: entry.doc, capture, verify: VERIFY(gate, file) };
}

/**
 * Every live record the release consumes, derived from the code that defines
 * the gates (never hand-kept): the task-112 ledger gates, one writer record per
 * written workload, one read record per Wave 2 workload, the single-record
 * writer gates and the ScubaGear benchmark. Entra (issue #148) is judged per
 * registered write, separately. Every entry holds readiness unless an operator
 * decision descoped it (acceptedGap).
 */
export function releaseGateInventory() {
  const rows = [];
  for (const spec of LIVE_ACCEPTANCE_GATES.filter((entry) => !entry.perOperation)) {
    const file = `${spec.gate}.json`;
    rows.push({ id: spec.gate, gate: spec.gate, task: spec.task, title: spec.title, family: 'release', file,
      acceptedGap: spec.acceptedGap ?? null,
      maxAgeHours: spec.gate === DEPLOYED_ACCEPTANCE_GATE ? DEPLOYED_ACCEPTANCE_MAX_AGE_HOURS : DEFAULT_MAX_AGE_HOURS,
      ...captureFor(spec.gate, file) });
  }
  for (const workload of Object.keys(WRITTEN_WORKLOADS)) {
    const file = workloadWritesRecordFile(workload);
    rows.push({ id: `${WORKLOAD_WRITES_LIVE_GATE}:${workload}`, gate: WORKLOAD_WRITES_LIVE_GATE, task: 'WKLD',
      title: `Wave 2 writes: ${workload}`, family: 'workload-writes', file, acceptedGap: null, maxAgeHours: DEFAULT_MAX_AGE_HOURS,
      doc: 'docs/roadmap/workload-writers-live-acceptance.md',
      capture: `node tools/qualification/workloadWritesLive.mjs capture --confirm-live-tenant-write --workload ${workload} [see doc] --build <B> --out ${QUALIFICATIONS_PATH}/${file}`,
      verify: VERIFY(WORKLOAD_WRITES_LIVE_GATE, file) });
  }
  for (const workload of Object.keys(READ_FAMILIES)) {
    const file = workloadReadsRecordFile(workload);
    rows.push({ id: `${WORKLOAD_READS_LIVE_GATE}:${workload}`, gate: WORKLOAD_READS_LIVE_GATE, task: 'WKLD-R',
      title: `Wave 2 reads: ${workload}`, family: 'workload-reads', file, acceptedGap: null, maxAgeHours: DEFAULT_MAX_AGE_HOURS,
      doc: 'docs/roadmap/workload-reads-live-acceptance.md',
      capture: `${HMAC}node tools/qualification/workloadReadsLive.mjs capture --workload ${workload} [see doc] --build <B> --out ${QUALIFICATIONS_PATH}/${file}`,
      verify: VERIFY(WORKLOAD_READS_LIVE_GATE, file) });
  }
  for (const [gate, title] of [
    [SITE_GRANTS_LIVE_GATE, 'SharePoint site app grant writes'],
    [SITE_PERMISSIONS_LIVE_GATE, 'SharePoint site permission writes'],
    [STRUCTURE_WRITES_LIVE_GATE, 'SharePoint structure writes'],
    [DSC_WRITES_LIVE_GATE, 'Distribution list writes through Microsoft365DSC'],
    [ROLE_WRITES_LIVE_GATE, 'Custom Exchange admin role writes'],
    [UNPUBLISH_LIVE_GATE, 'Purview label unpublish and put back'],
  ]) {
    const file = `${gate}.json`;
    rows.push({ id: gate, gate, task: 'writer', title, family: 'writer', file, acceptedGap: null,
      maxAgeHours: DEFAULT_MAX_AGE_HOURS, ...captureFor(gate, file) });
  }
  rows.push({ id: 'scubagear-benchmark-acceptance', gate: 'scubagear-benchmark-acceptance', task: 'task-126',
    title: 'CISA ScubaGear benchmark pack', family: 'benchmark', file: 'scubagear-benchmark-acceptance.live.json',
    acceptedGap: null, maxAgeHours: DEFAULT_MAX_AGE_HOURS, ...captureFor('scubagear-benchmark-acceptance', 'scubagear-benchmark-acceptance.live.json') });
  return rows.map((row) => Object.freeze(row));
}

const ageDays = (observedAt, now) => {
  const at = Date.parse(observedAt);
  return Number.isNaN(at) ? null : Math.floor((now.getTime() - at) / (24 * HOUR_MS));
};

/**
 * One record's state at the candidate build. `verify` is verifyEvidence (tests
 * inject a stand-in). Order: missing, unreadable, placeholder, stale, another
 * build, then (with key and tenant) the full --require-live verification.
 */
export function classifyRecordAtBuild(entry, record, {
  candidateBuild = null, hmacKey = null, tenantRef = null, now = new Date(), evidenceDir, verify = verifyEvidence,
} = {}) {
  if (!record) return { state: 'missing', build: null, observedAt: null, ageDays: null, reasons: ['no record has been captured'] };
  if (record.unreadable) return { state: 'failed', build: null, observedAt: null, ageDays: null, reasons: [`record unreadable: ${record.unreadable}`] };
  const base = { build: record.build ?? null, observedAt: record.observedAt ?? null, ageDays: ageDays(record.observedAt, now) };
  if (record.status !== undefined) {
    return { ...base, state: 'placeholder', reasons: [`placeholder (${record.status}): no live capture yet`] };
  }
  const at = Date.parse(record.observedAt);
  if (Number.isNaN(at)) return { ...base, state: 'failed', reasons: ['observedAt is not a valid timestamp'] };
  if (record.synthetic !== false || record.evidenceLevel !== 'live-qualified') {
    return { ...base, state: 'failed', reasons: ['synthetic or fixture evidence is never live qualification'] };
  }
  const reasons = [];
  const stale = now.getTime() - at > entry.maxAgeHours * HOUR_MS;
  if (stale) reasons.push(`${base.ageDays} days old; the limit is ${entry.maxAgeHours / 24} days`);
  const otherBuild = candidateBuild !== null && record.build !== candidateBuild;
  if (otherBuild) reasons.push(`captured at build ${String(record.build).slice(0, 10)}, not the candidate ${candidateBuild.slice(0, 10)}`);
  if (stale) return { ...base, state: 'stale', reasons };
  if (otherBuild) return { ...base, state: 'other-build', reasons };
  if (!candidateBuild || !hmacKey || !tenantRef) {
    const missing = [!candidateBuild && 'candidate build', !hmacKey && 'verification key', !tenantRef && 'tenant'].filter(Boolean);
    return { ...base, state: 'unverified', reasons: [`cannot verify without the ${missing.join(', ')}`] };
  }
  const result = verify(record, {
    gate: entry.gate, tenantRef, build: candidateBuild, requireLive: true, hmacKey, evidenceDir, now, maxAgeHours: entry.maxAgeHours,
  });
  return result.ok ? { ...base, state: 'live-qualified', reasons: [] } : { ...base, state: 'failed', reasons: result.failures };
}

/**
 * One registered Entra write at the candidate build: the ledger's own
 * classification, then the build rule on top (an Entra record from another
 * build is recaptured, not trusted).
 */
export function classifyEntraAtBuild(files, { candidateBuild = null, hmacKey = null, now = new Date() } = {}) {
  const ledger = classifyEntraOperation(files, { hmacKey, now });
  const record = files?.record && !files.record.unreadable ? files.record : null;
  const base = { build: record?.build ?? null, observedAt: ledger.observedAt ?? null, ageDays: ageDays(ledger.observedAt, now) };
  const map = { 'live-qualified': 'live-qualified', unverified: 'unverified', expired: 'stale', demoted: 'demoted', failed: 'failed', missing: 'missing' };
  let state = map[ledger.status];
  const reasons = [...ledger.failures];
  if (['live-qualified', 'unverified'].includes(state) && candidateBuild !== null && record?.build !== candidateBuild) {
    state = 'other-build';
    reasons.splice(0, reasons.length, `captured at build ${String(record?.build ?? 'unknown').slice(0, 10)}, not the candidate ${candidateBuild.slice(0, 10)}`);
  }
  if (state === 'unverified' && !candidateBuild) reasons.push('no candidate build given');
  return { ...base, state, reasons };
}

const worst = (states) => GATE_STATES.find((state) => states.includes(state)) ?? 'missing';

function readJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return { unreadable: error.message };
  }
}

/**
 * Write coverage per writer family: the operations registered in
 * WORKLOAD_WRITE_OPERATIONS against those a writer record proves (written and
 * read back, not synthetic). A family appears once any record writes it.
 */
export function writeFamilyCoverage(records, { operations = Object.keys(WORKLOAD_WRITE_OPERATIONS) } = {}) {
  const proven = new Set();
  const attempted = new Map();
  for (const record of records) {
    for (const write of Array.isArray(record?.subject?.writes) ? record.subject.writes : []) {
      if (typeof write.operationId !== 'string') continue;
      if (write.ok === true && write.readBackVerified === true && write.synthetic === false) proven.add(write.operationId);
      else if (!proven.has(write.operationId)) attempted.set(write.operationId, write.error ?? 'not read back');
    }
  }
  const familyOf = (id) => id.split('.')[0];
  const families = [...new Set([...proven, ...attempted.keys()].map(familyOf))].sort();
  return families.map((family) => {
    const registered = operations.filter((id) => familyOf(id) === family);
    const missing = registered.filter((id) => !proven.has(id));
    return {
      family, registered: registered.length, proven: registered.length - missing.length,
      missing: missing.map((id) => ({ operationId: id, lastAttempt: attempted.has(id) ? attempted.get(id) : null })),
    };
  });
}

/**
 * Recovery routes by how they run. A type whose explicit decision is 'manual'
 * and a native route that is not credential-qualified are manual handoffs:
 * they are listed, and never counted as automated recovery.
 */
export function recoveryRoutes({ ledger = buildOperationLedger(), nativeRoutes = NATIVE_RECOVERY_ROUTES } = {}) {
  const automated = [];
  const manual = [];
  for (const type of ledger.types) {
    if (type.decision === 'automated') automated.push({ resourceType: type.resourceType, recovery: 'automated' });
    else manual.push({ route: type.resourceType, kind: 'resource-type', recovery: 'manual', automated: false, reason: type.reason });
  }
  for (const [resourceType, route] of Object.entries(nativeRoutes)) {
    if (route.qualified === true) continue;
    manual.push({ route: route.route, kind: 'native-recovery', resourceType, recovery: 'manual', automated: false, reason: route.reason });
  }
  manual.push({ route: 'conditional-access-enforcement', kind: 'operator-step', recovery: 'manual', automated: false,
    reason: 'KEEL never enforces a Conditional Access policy; turning one on after a restore is the operator\'s step' });
  return { automated, manual };
}

/**
 * Scope that is deferred or excluded. Never shipped, whatever the gates say.
 * The hybrid entry is checked against the artifact inventory: a deferred
 * runtime with an entrypoint in the tree, or one declared available, is a
 * problem that blocks sign-off.
 */
export function deferredScope({ runtime = HYBRID_RUNTIME, root = REPO_ROOT } = {}) {
  const problems = runtimeDeclarationProblems(hybridRuntimeInventory({ root, fs, path }), runtime);
  if (runtime.status === 'deferred' && runtime.available) problems.push('hybrid runtime is declared deferred but also available');
  return [
    { item: 'hybrid-agent-runtime', status: runtime.status, shipped: false, source: 'engine/contracts/topology.mjs',
      reason: runtime.explanation, problems },
    { item: 'global-reference-templates', status: 'excluded', shipped: false, source: 'engine/restore/administrativeOperations.mjs',
      reason: 'Microsoft-published templates, identical in every tenant; KEEL never writes them', problems: [] },
  ];
}

/** Per objective: the manual or unsupported routes and the deferred items that belong to it. */
const OBJECTIVE_ROUTES = Object.freeze({
  D2: { manual: ['native-recovery', 'conditional-access-enforcement'] },
  G6: { manual: ['native-recovery'] },
  G5: { deferred: ['hybrid-agent-runtime'] },
  D4: { deferred: ['global-reference-templates'] },
});

function objectiveRow(objective, gateById, routes, deferred, { objectiveGapsAccepted, root }) {
  const tests = objective.tests.map((file) => ({ path: file, exists: existsSync(path.join(root, file)) }));
  const gates = objective.evidence.map((gate) => {
    const row = gateById.get(gate);
    return { gate, state: row?.state ?? 'missing', build: row?.build ?? null, ageDays: row?.ageDays ?? null };
  });
  const map = OBJECTIVE_ROUTES[objective.id] ?? {};
  const manualOrUnsupported = [
    ...routes.manual.filter((route) => (map.manual ?? []).includes(route.kind === 'native-recovery' ? 'native-recovery' : route.route))
      .map((route) => ({ item: route.route, label: 'manual', automated: false, reason: route.reason })),
    ...(objective.gap ? [{ item: objective.id, label: 'unsupported', automated: false, reason: objective.gap }] : []),
  ];
  const liveQualified = gates.length === 0 ? 'no-live-gate'
    : gates.every((gate) => gate.state === 'live-qualified') ? 'live-qualified' : 'not-live-qualified';
  return {
    id: objective.id, definition: objective.definition, owners: objective.owners,
    implemented: { status: tests.every((test) => test.exists) ? 'implemented' : 'incomplete', tests },
    liveQualified: { status: liveQualified, gates },
    manualOrUnsupported,
    deferred: deferred.filter((item) => (map.deferred ?? []).includes(item.item))
      .map(({ item, status, shipped, reason }) => ({ item, status, shipped, reason })),
    gap: objective.gap, gapAccepted: Boolean(objective.gap) && objectiveGapsAccepted,
  };
}

/**
 * The sign-off. Verdict:
 *  - 'ready': a candidate build is named, every fixture journey passed, every
 *    gate holding readiness (all but accepted gaps) and every registered Entra
 *    write is live-qualified at that build, every objective is live-qualified
 *    or an accepted gap, and no deferred scope has a problem;
 *  - 'blocked': a journey failed, a record failed its checks, or deferred scope
 *    is declared or found shipped;
 *  - 'pending': anything else (missing, placeholder, stale, another build,
 *    unverified, demoted and awaiting its fix and recapture).
 */
export function buildReleaseSignoff({
  fixture = null, candidateBuild = null, hmacKey = null, tenantRef = null, now = new Date(),
  dir = path.join(REPO_ROOT, QUALIFICATIONS_PATH), root = REPO_ROOT, verify = verifyEvidence,
  inventory = releaseGateInventory(), entraOperations = registeredOperations(), objectiveGapsAccepted = false,
  routes = recoveryRoutes(), deferred = deferredScope({ root }), classifyEntra = classifyEntraAtBuild,
} = {}) {
  const reasons = [];
  let blocked = false;
  let pending = false;
  const hold = (reason) => { pending = true; reasons.push(reason); };
  const block = (reason) => { blocked = true; reasons.push(reason); };

  if (!candidateBuild) hold('no candidate build was named (--build)');
  const journeys = fixture?.evidenceLevel === 'fixture-tested' && Array.isArray(fixture.journeys) ? fixture.journeys : null;
  if (!journeys) hold('no fixture journey results were supplied (--fixture)');
  else {
    for (const id of ['J1', 'J2', 'J3', 'J4', 'J5', 'J6']) {
      const journey = journeys.find((entry) => entry.journey === id);
      if (!journey) hold(`journey ${id} has no fixture result`);
      else if (journey.outcome !== 'passed') block(`journey ${id} failed`);
    }
  }

  const records = [];
  const gates = inventory.map((entry) => {
    const record = readJson(path.join(dir, entry.file));
    if (record && !record.unreadable) records.push(record);
    const classified = classifyRecordAtBuild(entry, record, { candidateBuild, hmacKey, tenantRef, now, evidenceDir: dir, verify });
    return {
      id: entry.id, gate: entry.gate, task: entry.task, title: entry.title, family: entry.family,
      record: record ? `${QUALIFICATIONS_PATH}/${entry.file}` : null, doc: entry.doc, capture: entry.capture, verify: entry.verify,
      maxAgeDays: entry.maxAgeHours / 24, acceptedGap: entry.acceptedGap, holdsReadiness: !entry.acceptedGap, ...classified,
    };
  });
  for (const gate of gates) {
    if (gate.state === 'live-qualified') continue;
    const line = `${gate.id} is ${gate.state}${gate.reasons[0] ? `: ${gate.reasons[0]}` : ''}`;
    if (!gate.holdsReadiness) {
      if (gate.state === 'failed') block(`${line} (an accepted gap still blocks when its record fails)`);
      continue;
    }
    if (gate.state === 'failed') block(line);
    else hold(line);
  }

  const entraFiles = loadEntraLiveFiles(path.join(dir, 'entra-live'));
  const entraRows = entraOperations.map(({ resourceType, operation }) => {
    const stem = evidenceStem(resourceType, operation);
    const files = entraFiles.get(stem);
    return {
      resourceType, operation, stem,
      record: files?.record ? `${QUALIFICATIONS_PATH}/entra-live/${stem}.json` : null,
      demotion: files?.demotion ? `${QUALIFICATIONS_PATH}/entra-live/${stem}.demotion.json` : null,
      ...classifyEntra(files, { candidateBuild, hmacKey, now }),
    };
  });
  const entraCounts = Object.fromEntries(GATE_STATES.map((state) => [state, entraRows.filter((row) => row.state === state).length])
    .filter(([, count]) => count > 0));
  const entraState = entraRows.length === 0 ? 'missing' : worst(entraRows.map((row) => row.state));
  const entra = {
    id: 'entra-live-acceptance', gate: 'entra-live-acceptance', task: 'issue-148', title: 'Entra writes proven live on the test tenant',
    family: 'entra', state: entraState, holdsReadiness: true, registered: entraRows.length, counts: entraCounts,
    doc: 'docs/roadmap/live-gate-148.md',
    capture: `${HMAC}node tools/qualification/entraLive.mjs capture --restore-ref <A> --resource-type <T> --operation <O> --fixture <KEEL-RT-148-...> --target-config /etc/keel/restorer.json --build <B> --out <DIR>`,
    verify: 'node tools/qualification/entraLive.mjs promote --evidence <DIR>/<T>.<O>.json --tenant <tenant ref>',
    operations: entraRows,
  };
  for (const row of entraRows.filter((entry) => entry.state === 'failed')) block(`Entra ${row.stem} failed: ${row.reasons[0]}`);
  if (entraState !== 'live-qualified' && entraState !== 'failed') {
    hold(`entra-live-acceptance: ${entraRows.length} registered writes, ${Object.entries(entraCounts).map(([state, count]) => `${count} ${state}`).join(', ')}`);
  }

  for (const item of deferred) {
    if (item.shipped !== false) block(`${item.item} is ${item.status} and can never count as shipped`);
    for (const problem of item.problems) block(problem);
  }

  const gateById = new Map([...gates.map((gate) => [gate.gate, gate]), [entra.gate, entra]]);
  const objectives = RELEASE_OBJECTIVES.map((objective) => objectiveRow(objective, gateById, routes, deferred, { objectiveGapsAccepted, root }));
  for (const objective of objectives) {
    if (objective.implemented.status !== 'implemented') {
      hold(`objective ${objective.id}: test files missing (${objective.implemented.tests.filter((test) => !test.exists).map((test) => test.path).join(', ')})`);
    }
    if (objective.gap) {
      if (!objective.gapAccepted) hold(`objective ${objective.id} is a gap: ${objective.gap}`);
    } else if (objective.liveQualified.status !== 'live-qualified') {
      hold(`objective ${objective.id} is not live-qualified at the candidate build`);
    }
  }

  const verdict = blocked ? 'blocked' : pending ? 'pending' : 'ready';
  return {
    contractVersion: SIGNOFF_CONTRACT_VERSION,
    generatedAt: now.toISOString(),
    candidateBuild,
    verification: { key: hmacKey ? 'supplied' : 'absent', tenant: tenantRef ? 'supplied' : 'absent' },
    verdict,
    reasons,
    objectiveGapsDecision: objectiveGapsAccepted ? OBJECTIVE_GAPS_DECISION : null,
    fixture: journeys ? { evidenceLevel: 'fixture-tested', build: fixture.build ?? null, journeys: journeys.map(({ journey, outcome }) => ({ journey, outcome })) } : null,
    gates,
    entra,
    writeCoverage: writeFamilyCoverage(records),
    objectives,
    recovery: { automatedTypes: routes.automated.length, manual: routes.manual },
    deferred,
    // What may be called shipped and live-qualified at this build: gates and objectives that verified, never deferred scope.
    shipped: verdict === 'ready'
      ? [...gates.filter((gate) => gate.state === 'live-qualified').map((gate) => gate.id), ...objectives.filter((o) => o.liveQualified.status === 'live-qualified').map((o) => o.id)]
      : [],
  };
}

/**
 * What the operator recaptures at the candidate build: every gate whose
 * record is missing, a placeholder, stale, from another build, failed or
 * demoted, with its capture and verify commands; the Entra writes that need a
 * capture (demotions first, with why they failed); and the writer families
 * with registered writes no record proves yet. Accepted gaps are listed apart.
 */
export function buildRecapturePlan(signoff) {
  const needs = (state) => RECAPTURE_STATES.includes(state);
  const order = (a, b) => GATE_STATES.indexOf(a.state) - GATE_STATES.indexOf(b.state);
  const gates = signoff.gates.filter((gate) => gate.holdsReadiness && needs(gate.state)).sort(order)
    .map(({ id, task, title, state, build, ageDays: age, reasons, record, doc, capture, verify }) => ({
      id, task, title, state, build, ageDays: age, why: reasons.join('; '), record, doc, capture, verify }));
  const entraNeeds = signoff.entra.operations.filter((row) => needs(row.state)).sort(order);
  return {
    contractVersion: SIGNOFF_CONTRACT_VERSION,
    generatedAt: signoff.generatedAt,
    candidateBuild: signoff.candidateBuild,
    gates,
    entra: {
      doc: signoff.entra.doc, capture: signoff.entra.capture, verify: signoff.entra.verify,
      plan: 'node tools/qualification/live-gate-plan.mjs (per-operation fixtures and order)',
      demoted: entraNeeds.filter((row) => row.state === 'demoted' || row.state === 'failed')
        .map((row) => ({ operation: row.stem, state: row.state, why: row.reasons.join('; '), demotion: row.demotion })),
      recapture: entraNeeds.filter((row) => row.state !== 'demoted' && row.state !== 'failed')
        .map((row) => ({ operation: row.stem, state: row.state, build: row.build, ageDays: row.ageDays })),
    },
    partialWrites: signoff.writeCoverage.filter((family) => family.proven < family.registered),
    acceptedGaps: signoff.gates.filter((gate) => !gate.holdsReadiness && gate.state !== 'live-qualified')
      .map((gate) => ({ id: gate.id, state: gate.state, acceptedGap: gate.acceptedGap })),
  };
}

const short = (build) => (build ? `\`${String(build).slice(0, 10)}\`` : '—');
const days = (value) => (value === null || value === undefined ? '—' : `${value} d`);

/** Markdown tables from the generated report, for the docs (never hand-copied). */
export function renderSignoffMarkdown(signoff, plan = buildRecapturePlan(signoff)) {
  const lines = [];
  lines.push(`Generated ${signoff.generatedAt.slice(0, 10)} by \`node tools/release/readiness.mjs signoff\` for candidate build ${short(signoff.candidateBuild)}`
    + ` (verification key ${signoff.verification.key}, tenant ${signoff.verification.tenant}). **Verdict: ${signoff.verdict}.**`, '');
  lines.push('| Gate | Task | State | Build | Age | Record |', '|---|---|---|---|---|---|');
  for (const gate of signoff.gates) {
    const state = gate.acceptedGap ? `${gate.state} (accepted gap)` : gate.state;
    lines.push(`| \`${gate.id}\` | ${gate.task} | ${state} | ${short(gate.build)} | ${days(gate.ageDays)} | ${gate.record ? 'yes' : 'none'} |`);
  }
  const counts = Object.entries(signoff.entra.counts).map(([state, count]) => `${count} ${state}`).join(', ');
  lines.push(`| \`entra-live-acceptance\` | issue-148 | ${signoff.entra.state} | per write | per write | ${signoff.entra.registered} registered writes: ${counts} |`, '');
  lines.push('**Objectives** (implemented / live-qualified / manual or unsupported / deferred):', '');
  lines.push('| Objective | Implemented | Live-qualified | Manual or unsupported | Deferred |', '|---|---|---|---|---|');
  for (const o of signoff.objectives) {
    const manual = o.manualOrUnsupported.map((m) => `${m.label}: ${m.item}${o.gapAccepted && m.item === o.id ? ' (accepted gap)' : ''}`).join('; ') || '—';
    const deferred = o.deferred.map((d) => `${d.item} (${d.status}, not shipped)`).join('; ') || '—';
    lines.push(`| ${o.id} | ${o.implemented.status} | ${o.liveQualified.status} | ${manual} | ${deferred} |`);
  }
  lines.push('', `**Recapture at the candidate build** (${plan.gates.length} gates, ${plan.entra.demoted.length + plan.entra.recapture.length} Entra writes):`, '');
  lines.push('| Gate | State | Build | Age | Why |', '|---|---|---|---|---|');
  for (const gate of plan.gates) lines.push(`| \`${gate.id}\` | ${gate.state} | ${short(gate.build)} | ${days(gate.ageDays)} | ${gate.why.replace(/\|/g, '/')} |`);
  if (plan.entra.demoted.length > 0) {
    lines.push('', 'Entra writes that failed live (fix, then recapture):', '');
    for (const row of plan.entra.demoted) lines.push(`- \`${row.operation}\`: ${row.why.replace(/\|/g, '/')}`);
  }
  if (plan.partialWrites.length > 0) {
    lines.push('', 'Writer families with registered writes no writer record proves yet (writes that gates 120-123 prove, such as the'
      + ' SharePoint tenant toggle, Teams team settings and members and Purview labels, are in those gates\' own records):', '');
    for (const family of plan.partialWrites) {
      lines.push(`- \`${family.family}\`: ${family.proven} of ${family.registered} proven; missing ${family.missing.map((m) => `\`${m.operationId}\``).join(', ')}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function signoffArg(argv, name, fallback = null) {
  const index = argv.indexOf(`--${name}`);
  return index > -1 ? argv[index + 1] : fallback;
}

/**
 * `readiness.mjs signoff|recapture-plan --build <candidate> [--fixture <journeys.json>] [--tenant <ref>]
 *   [--accept-objective-gaps] [--format json|markdown] [--out <file>] [--require-ready]`.
 * The key comes from KEEL_QUALIFICATION_HMAC_KEY only and is never printed.
 */
export function runSignoffCommand(argv = process.argv, { env = process.env, logger = console, now = new Date() } = {}) {
  const command = argv[2];
  const fixturePath = signoffArg(argv, 'fixture');
  const signoff = buildReleaseSignoff({
    fixture: fixturePath ? JSON.parse(readFileSync(fixturePath, 'utf8')) : null,
    candidateBuild: signoffArg(argv, 'build', env.KEEL_QUALIFICATION_BUILD ?? null),
    hmacKey: env.KEEL_QUALIFICATION_HMAC_KEY ?? null,
    tenantRef: signoffArg(argv, 'tenant', env.KEEL_QUALIFICATION_TENANT_REF ?? null),
    objectiveGapsAccepted: argv.includes('--accept-objective-gaps'),
    now,
  });
  const report = command === 'recapture-plan' ? buildRecapturePlan(signoff) : { ...signoff, recapturePlan: buildRecapturePlan(signoff) };
  const text = signoffArg(argv, 'format') === 'markdown' ? renderSignoffMarkdown(signoff) : `${JSON.stringify(report, null, 2)}\n`;
  const out = signoffArg(argv, 'out');
  if (out) {
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, text);
  }
  logger.log(text.trimEnd());
  return argv.includes('--require-ready') && signoff.verdict !== 'ready' ? 1 : 0;
}

async function main() {
  if (process.argv[2] === 'signoff' || process.argv[2] === 'recapture-plan') {
    process.exitCode = runSignoffCommand(process.argv);
    return;
  }
  if (process.argv.includes('--help')) {
    console.log('usage: readiness.mjs [--portal-url URL] [--source PATH] [--deployed PATH] [--session-env NAME] [--out PATH]\n'
      + '       readiness.mjs signoff|recapture-plan --build <candidate> [--fixture <journeys.json>] [--tenant <ref>] '
      + '[--accept-objective-gaps] [--format json|markdown] [--out <file>] [--require-ready]');
    return;
  }
  const portalUrl = arg('portal-url', process.env.KEEL_PORTAL_URL ?? 'http://localhost:3000');
  const sourcePath = arg('source', '/opt/keel');
  const deployedPath = arg('deployed', '/opt/keel-live');
  const sessionEnv = arg('session-env', 'KEEL_PORTAL_SESSION');
  const out = arg('out', 'docs/release/readiness.json');
  const sessionAssertion = process.env[sessionEnv] ?? null;

  const readiness = await buildReadiness({
    execFn: (args) => execFileSync('git', args, { encoding: 'utf8' }),
    fetchFn: fetch,
    sourcePath,
    deployedPath,
    portalUrl,
    sessionAssertion,
  });

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(readiness, null, 2)}\n`);

  // Only verdicts and revisions are printed — never session material.
  console.log(`readiness : ${readiness.verdict}`);
  console.log(`source    : ${readiness.source?.revision ?? 'unknown'}${readiness.source?.dirty ? ' (dirty)' : ''}`);
  console.log(`deployed  : ${readiness.deployed?.revision ?? 'unknown'}`);
  console.log(`health    : ${readiness.portal.health.ok ? 'ok' : 'unavailable'}`);
  for (const probe of readiness.probes) {
    console.log(`probe ${probe.feature}: ${probe.outcome}${probe.reason ? ` (${probe.reason})` : ''}`);
  }
  console.log(`written   : ${out}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
