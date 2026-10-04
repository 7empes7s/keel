#!/usr/bin/env node
/**
 * Proposed-policy scenario qualification harness (roadmap task-95).
 *
 *   node tools/qualification/conditionalAccess.mjs benchmark --policies 200 --locations 20 --seed 7 [--max-scenarios N]
 *   node tools/qualification/conditionalAccess.mjs what-if --evidence FILE
 *
 * 1. benchmark: a DETERMINISTIC synthetic policy estate (seeded PRNG) run through the
 *    production evaluator for one synthetic emergency account. It reports the input
 *    size, the scenario coverage (complete or sampled, truncated or not) and the
 *    measured runtime of this run only. It is synthetic: nothing about a real tenant
 *    is claimed (`tenantFigures: null`).
 * 2. what-if: validates captured What If evidence ({ principalId, readAt, response,
 *    source }) against the read contract. Any accepted read is reported as a
 *    live-policy read with `provesProposedState: false`: it describes the tenant's
 *    current policies, never a proposed combined set. This harness makes no call;
 *    capturing evidence needs delegated credentials KEEL does not hold.
 */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

import { evaluateProposedPolicySet, readLiveWhatIf } from '../../engine/safety/policyScenario.mjs';

export const HARNESS_VERSION = 1;
const PLATFORMS = ['windows', 'macOS', 'iOS', 'android', 'linux'];
const CONTROLS = ['mfa', 'compliantDevice', 'domainJoinedDevice', 'approvedApplication'];

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

const EMERGENCY = '0e000000-0000-4000-8000-0000000000e1';

/** Deterministic synthetic estate: named locations and enforced policies. */
export function generateSyntheticPolicies({ seed = 1, policies = 50, locations = 5 } = {}) {
  const random = prng(seed);
  const pick = (list) => list[Math.floor(random() * list.length)];
  const named = Array.from({ length: locations }, (_, i) => ({
    id: `10000000-0000-4000-8000-${String(i).padStart(12, '0')}`, label: `Site ${i}`, trusted: random() < 0.5,
  }));
  const set = [];
  for (let i = 0; i < policies; i += 1) {
    const conditions = {
      users: { includeUsers: ['All'], excludeUsers: random() < 0.8 ? [EMERGENCY] : [] },
      applications: { includeApplications: ['All'] },
      clientAppTypes: random() < 0.3 ? ['browser'] : ['all'],
    };
    if (random() < 0.3) conditions.platforms = { includePlatforms: [pick(PLATFORMS)] };
    if (random() < 0.3 && named.length) conditions.locations = { includeLocations: ['All'], excludeLocations: [pick(named).id] };
    set.push({
      naturalKey: `conditionalAccessPolicy:Synthetic ${i}`,
      payload: {
        id: `20000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        displayName: `Synthetic ${i}`,
        state: random() < 0.85 ? 'enabled' : 'enabledForReportingButNotEnforced',
        conditions,
        grantControls: random() < 0.1 ? { operator: 'OR', builtInControls: ['block'] } : { operator: 'OR', builtInControls: [pick(CONTROLS)] },
      },
    });
  }
  return { policies: set, locations: named };
}

export function runBenchmark({ seed = 1, policies = 50, locations = 5, maxScenarios, maxSteps } = {}) {
  const estate = generateSyntheticPolicies({ seed, policies, locations });
  const started = performance.now();
  const evaluation = evaluateProposedPolicySet({
    currentPolicies: estate.policies,
    changes: [],
    principals: [{ id: EMERGENCY, label: 'synthetic emergency account', capabilities: { mfa: true, compliantDevice: false, domainJoinedDevice: false, approvedApplication: false } }],
    locations: estate.locations,
    budget: { ...(maxScenarios ? { maxScenarios } : {}), ...(maxSteps ? { maxSteps } : {}) },
  });
  const elapsedMs = Math.round((performance.now() - started) * 1000) / 1000;
  const [result] = evaluation.principals;
  return {
    harness: 'conditional-access-scenarios',
    harnessVersion: HARNESS_VERSION,
    synthetic: true,
    tenantFigures: null,
    input: { seed, policies, locations },
    verdict: result.verdict,
    basis: result.basis,
    coverage: result.coverage,
    counts: result.counts,
    measured: { elapsedMs },
  };
}

/** Validates captured What If evidence; never a proposed-state proof. */
export function checkWhatIfEvidence(evidence) {
  const read = readLiveWhatIf(evidence?.response, {
    principalId: evidence?.principalId, scenario: evidence?.scenario ?? null, readAt: evidence?.readAt, source: evidence?.source ?? 'fixture',
  });
  return {
    harness: 'conditional-access-what-if',
    harnessVersion: HARNESS_VERSION,
    accepted: true,
    read,
    qualifies: read.synthetic ? 'nothing (synthetic evidence)' : 'the live policy outcome for one sign-in at readAt only',
    provesProposedState: false,
  };
}

function arg(argv, name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i > -1 ? argv[i + 1] : fallback;
}

export function main(argv = process.argv.slice(2), { log = console.log, readFile = readFileSync } = {}) {
  const [command] = argv;
  if (command === 'benchmark') {
    log(JSON.stringify(runBenchmark({
      seed: Number(arg(argv, 'seed', 1)),
      policies: Number(arg(argv, 'policies', 50)),
      locations: Number(arg(argv, 'locations', 5)),
      maxScenarios: arg(argv, 'max-scenarios') ? Number(arg(argv, 'max-scenarios')) : undefined,
      maxSteps: arg(argv, 'max-steps') ? Number(arg(argv, 'max-steps')) : undefined,
    }), null, 2));
    return 0;
  }
  if (command === 'what-if') {
    const file = arg(argv, 'evidence');
    if (!file) { log('what-if requires --evidence FILE'); return 2; }
    log(JSON.stringify(checkWhatIfEvidence(JSON.parse(readFile(file, 'utf8'))), null, 2));
    return 0;
  }
  log('usage: conditionalAccess.mjs benchmark [--policies N] [--locations N] [--seed N] [--max-scenarios N] | what-if --evidence FILE');
  return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try { process.exitCode = main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
