#!/usr/bin/env node
/**
 * Dynamic-group impact scale harness (roadmap task-60, decision D3).
 *
 *   node tools/qualification/dynamicGroups.mjs benchmark --groups 2000 --nesting 500 --seed 7
 *   node tools/qualification/dynamicGroups.mjs sizing --evidence FILE
 *
 * Three pieces, none of which invents a tenant figure:
 *
 * 1. benchmark — a DETERMINISTIC synthetic tenant (seeded PRNG) run through
 *    the production predictor. The report carries the generated input size
 *    and the MEASURED runtime/steps of this run only. It is synthetic: D3 stays
 *    'unqualified' and `tenantFigures` is null.
 * 2. collectSizingEvidence(reader, ...) — a READ-ONLY sizing pass over an
 *    injected Graph reader (reader.collect only; there is no write path). It
 *    counts what it actually read and times one prediction over it. The
 *    orchestrating session runs it against a real tenant with collector
 *    credentials; this CLI never does (builder authorization, Global
 *    Constraint 2). A fixture reader yields `synthetic: true` evidence.
 * 3. sizing — validates externally captured evidence and reports it. D3
 *    becomes 'measured' only for complete, non-synthetic, tenant-scoped
 *    evidence read from Graph; otherwise it stays 'unqualified' with reasons.
 *    'measured' is not 'qualified': deciding the D3 ceiling is an operator call.
 */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { predictDynamicImpact } from '../../engine/graph/dynamicImpact.mjs';
import { assertTenantRef } from '../../engine/store/tenantRef.mjs';

export const HARNESS_VERSION = 1;
const DEPARTMENTS = ['Sales', 'Engineering', 'Finance', 'HR', 'Legal', 'Support', 'Marketing', 'Ops'];
const COUNTRIES = ['US', 'FR', 'MA', 'DE', 'JP', 'BR'];

/** mulberry32: small deterministic PRNG so the same seed yields the same tenant. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic synthetic dynamic-group estate. */
export function generateSyntheticTenant({ seed = 1, groups = 100, nesting = 20, memberOfRatio = 0.1 } = {}) {
  const random = prng(seed);
  const pick = (list) => list[Math.floor(random() * list.length)];
  const generated = [];
  let clauses = 0;
  let memberOfRules = 0;
  for (let i = 0; i < groups; i += 1) {
    const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    let rule;
    if (i > 0 && random() < memberOfRatio) {
      const target = generated[Math.floor(random() * generated.length)].sourceId;
      rule = `user.memberof -any (group.objectId -in ["${target}"])`;
      memberOfRules += 1;
      clauses += 1;
    } else {
      const parts = [`user.department -eq "${pick(DEPARTMENTS)}"`];
      if (random() < 0.5) parts.push(`user.country -eq "${pick(COUNTRIES)}"`);
      if (random() < 0.3) parts.push('user.accountEnabled -eq true');
      rule = parts.join(random() < 0.8 ? ' -and ' : ' -or ');
      clauses += parts.length;
    }
    generated.push({ naturalKey: `group:dyn-${i}`, sourceId: id, membershipRule: rule, processingState: 'On', isAssignableToRole: false });
  }
  const edges = [];
  for (let i = 0; i < nesting && groups > 1; i += 1) {
    const parent = generated[Math.floor(random() * groups)];
    const member = generated[Math.floor(random() * groups)];
    if (parent.sourceId !== member.sourceId) {
      edges.push({ parentSourceId: parent.sourceId, parentNaturalKey: `group:static-over-${parent.sourceId}`, memberSourceId: member.sourceId });
    }
  }
  const principal = {
    naturalKey: 'user:synthetic',
    subject: 'user',
    before: { attributes: { department: 'Sales', country: 'US', accountEnabled: true }, memberOf: [], memberOfComplete: true },
    after: { attributes: { department: 'Engineering', country: 'US', accountEnabled: true } },
  };
  return { groups: generated, nesting: edges, principal, input: { groups, rules: groups, clauses, memberOfRules, nestingEdges: edges.length } };
}

/** Run the synthetic benchmark; every number in `measured` comes from this run. */
export function runSyntheticBenchmark({ seed = 1, groups = 100, nesting = 20, budget, clock = () => performance.now() } = {}) {
  const tenant = generateSyntheticTenant({ seed, groups, nesting });
  const started = clock();
  const prediction = predictDynamicImpact({ principal: tenant.principal, groups: tenant.groups, nesting: tenant.nesting, budget, clock });
  const elapsedMs = clock() - started;
  return {
    harnessVersion: HARNESS_VERSION,
    kind: 'synthetic-benchmark',
    evidenceLevel: 'fixture-tested',
    synthetic: true,
    d3: 'unqualified',
    seed,
    input: tenant.input,
    measured: {
      elapsedMs,
      steps: prediction.budget.steps,
      complete: prediction.complete,
      exhausted: prediction.budget.exhausted,
      predictedChange: prediction.summary.predictedChange,
      possiblyAffected: prediction.summary.possiblyAffected,
    },
    tenantFigures: null,
  };
}

/**
 * Read-only sizing pass over an injected reader. Counts only what it read;
 * an incomplete read is recorded as incomplete, never extrapolated.
 */
export async function collectSizingEvidence(reader, { tenantRef, synthetic, capturedAt = new Date(), clock = () => performance.now(), budget } = {}) {
  assertTenantRef(tenantRef);
  if (typeof synthetic !== 'boolean') throw new Error('collectSizingEvidence requires an explicit synthetic flag');
  const path = '/groups?$select=id,displayName,groupTypes,membershipRule,membershipRuleProcessingState,isAssignableToRole';
  const read = await reader.collect('v1.0', path, {});
  const items = Array.isArray(read?.items) ? read.items : [];
  const complete = !read?.error && read?.capped !== true && Array.isArray(read?.items);
  const dynamic = items.filter((g) => Array.isArray(g.groupTypes) && g.groupTypes.includes('DynamicMembership'));
  const groups = dynamic.map((g) => ({
    naturalKey: `group:${g.displayName ?? g.id}`, sourceId: g.id, membershipRule: g.membershipRule,
    processingState: g.membershipRuleProcessingState ?? 'On', isAssignableToRole: g.isAssignableToRole === true,
  }));
  // One representative attribute edit timed over the groups actually read.
  const principal = {
    naturalKey: 'user:sizing-probe', subject: 'user',
    before: { attributes: { department: 'Sales' }, memberOf: [], memberOfComplete: false },
    after: { attributes: { department: 'Engineering' } },
  };
  const started = clock();
  const prediction = predictDynamicImpact({ principal, groups, budget, clock });
  return {
    harnessVersion: HARNESS_VERSION,
    tenantRef,
    capturedAt: new Date(capturedAt).toISOString(),
    source: 'graph-read',
    endpoint: path,
    synthetic,
    readComplete: complete,
    pagesRead: Number.isSafeInteger(read?.pages) ? read.pages : null,
    counts: { groups: complete ? items.length : null, dynamicGroups: complete ? dynamic.length : null, observedItems: items.length },
    measured: { predictionElapsedMs: clock() - started, steps: prediction.budget.steps, complete: prediction.complete },
  };
}

const isCount = (n) => Number.isSafeInteger(n) && n >= 0;

/** Validate external evidence; D3 is 'measured' only for real, complete, read evidence. */
export function sizingReport(evidence) {
  const reasons = [];
  try { assertTenantRef(evidence?.tenantRef); } catch { reasons.push('missing-or-raw-tenant-ref'); }
  if (evidence?.source !== 'graph-read') reasons.push('not-graph-read');
  if (evidence?.synthetic !== false) reasons.push('synthetic-or-unlabeled');
  if (evidence?.readComplete !== true) reasons.push('incomplete-read');
  if (!isCount(evidence?.counts?.groups) || !isCount(evidence?.counts?.dynamicGroups)) reasons.push('counts-missing');
  if (!(Number.isFinite(evidence?.measured?.predictionElapsedMs) && evidence.measured.predictionElapsedMs >= 0)) reasons.push('runtime-missing');
  if (Number.isNaN(Date.parse(evidence?.capturedAt ?? ''))) reasons.push('capture-time-missing');
  return {
    harnessVersion: HARNESS_VERSION,
    d3: reasons.length === 0 ? 'measured' : 'unqualified',
    reasons,
    // Copied from the evidence only — never estimated or defaulted.
    tenantRef: evidence?.tenantRef ?? null,
    capturedAt: evidence?.capturedAt ?? null,
    counts: {
      groups: isCount(evidence?.counts?.groups) ? evidence.counts.groups : null,
      dynamicGroups: isCount(evidence?.counts?.dynamicGroups) ? evidence.counts.dynamicGroups : null,
    },
    measured: {
      predictionElapsedMs: Number.isFinite(evidence?.measured?.predictionElapsedMs) ? evidence.measured.predictionElapsedMs : null,
      steps: isCount(evidence?.measured?.steps) ? evidence.measured.steps : null,
    },
  };
}

function argValue(argv, name, fallback) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
}

export function main(argv = process.argv.slice(2), { log = console.log, readFile = readFileSync } = {}) {
  const [command] = argv;
  if (command === 'benchmark') {
    log(JSON.stringify(runSyntheticBenchmark({
      seed: Number(argValue(argv, '--seed', 1)),
      groups: Number(argValue(argv, '--groups', 100)),
      nesting: Number(argValue(argv, '--nesting', 20)),
    }), null, 2));
    return 0;
  }
  if (command === 'sizing') {
    const file = argValue(argv, '--evidence');
    if (!file) { log('sizing requires --evidence FILE'); return 2; }
    const report = sizingReport(JSON.parse(readFile(file, 'utf8')));
    log(JSON.stringify(report, null, 2));
    return report.d3 === 'measured' ? 0 : 1;
  }
  log('usage: dynamicGroups.mjs benchmark [--groups N --nesting N --seed N] | sizing --evidence FILE');
  return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main();
