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
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

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

async function main() {
  if (process.argv.includes('--help')) {
    console.log('usage: readiness.mjs [--portal-url URL] [--source PATH] [--deployed PATH] [--session-env NAME] [--out PATH]');
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
