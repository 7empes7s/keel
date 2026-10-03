#!/usr/bin/env node
/**
 * Roadmap task-101: the workload configuration qualification ledger, on the command
 * line, with a fixture harness and operator-supplied read-only captures.
 *
 *   node tools/qualification/workloads.mjs                    # table: every operation and its state
 *   node tools/qualification/workloads.mjs --json             # the full ledger
 *   node tools/qualification/workloads.mjs --harness          # also run the fixture harness
 *   node tools/qualification/workloads.mjs --check            # exit 1 if any descriptor is out of scope
 *   node tools/qualification/workloads.mjs --tenant-ref sha256:... \
 *        --capture probe.json [--capture graph-capture.json] [--grants grants.json]
 *
 * --capture takes the JSON that ops/powershell/probe-workloads.ps1 prints (an array of
 * rows), or a Graph capture file ({ captures: [{ operationId, version, capturedAt, ok,
 * synthetic: false, observed }] }). Captures are read only from files named here; the
 * tool itself makes no network call and touches no tenant.
 *
 * --grants takes { permissions: [...], roles: [...] }: what the collector app holds.
 *
 * Results never enable anything by themselves: the harness yields synthetic
 * `fixture-tested` proof, and every capture is checked by workloadContract.mjs
 * (tenant, age, version, non-synthetic) before it counts.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import {
  WORKLOAD_DESCRIPTORS, buildWorkloadLedger, currentVersion, descriptorProblems, evidenceFromProbeRows,
  readGraphConfiguration,
} from '../../engine/collect/workloadContract.mjs';

export const HARNESS_PROOF_REF = 'tools/qualification/workloads.mjs#harness';

const SAMPLE = Object.freeze({
  'sharepoint.tenant-settings': { sharingCapability: 'externalUserSharingOnly', isUnmanagedSyncAppForTenantRestricted: false },
  'sharepoint.site-properties': { id: 'contoso.sharepoint.com,site-guid,web-guid', displayName: 'Fixture site' },
  'teams.settings': { memberSettings: { allowCreateUpdateChannels: true }, guestSettings: { allowCreateUpdateChannels: false } },
  'teams.membership': [{ id: 'm1', roles: ['owner'] }, { id: 'm2', roles: [] }],
  'exchange.mailbox-settings': { timeZone: 'UTC', automaticRepliesSetting: { status: 'disabled' } },
});
const SUBSTITUTE = Object.freeze({ 'site-id': 'fixture-site', 'team-id': 'fixture-team', 'user-id': 'fixture-user' });

/**
 * A fake Graph for one operation: the first request is throttled (Retry-After: 2),
 * then pages are served, two of them when the operation pages.
 */
export function fixtureGraph(descriptor) {
  const sample = SAMPLE[descriptor.id] ?? {};
  const requests = [];
  let throttled = false;
  return {
    requests,
    async transport(url) {
      requests.push(url);
      if (!throttled) {
        throttled = true;
        return { status: 429, headers: { 'retry-after': '2' }, body: null };
      }
      if (descriptor.paging !== 'odata-nextLink') return { status: 200, headers: {}, body: sample };
      const page = new URL(url).searchParams.get('$skiptoken') ? 2 : 1;
      const values = Array.isArray(sample) ? sample : [sample];
      return page === 1
        ? { status: 200, headers: {}, body: { value: values.slice(0, 1), '@odata.nextLink': `${url}?$skiptoken=fixture` } }
        : { status: 200, headers: {}, body: { value: values.slice(1) } };
    },
  };
}

/**
 * Fixture evidence for every in-scope operation. Graph operations run through the
 * production reader against fixtureGraph; cmdlet operations go through the capture
 * mapping with a canned, explicitly synthetic probe row. All of it is synthetic.
 */
export async function runFixtureHarness({ descriptors = WORKLOAD_DESCRIPTORS, runtime = {} } = {}) {
  const evidence = [];
  const results = [];
  for (const descriptor of descriptors) {
    if (descriptorProblems(descriptor).length) continue;
    const version = currentVersion(descriptor, runtime);
    try {
      let observed;
      if (descriptor.operation.kind === 'graph') {
        const graph = fixtureGraph(descriptor);
        ({ observed } = await readGraphConfiguration(descriptor, { transport: graph.transport, substitute: SUBSTITUTE }));
      } else {
        const { evidence: mapped } = evidenceFromProbeRows([{
          workload: descriptor.workload, connected: true, cmdlet: descriptor.operation.probeName, ok: true, count: 1, error: null,
          module: descriptor.operation.module, moduleVersion: version, synthetic: true,
        }], { tenantRef: null, proofRef: HARNESS_PROOF_REF, descriptors: [descriptor] });
        if (mapped.length !== 1 || mapped[0].synthetic !== true) throw new Error('probe row did not map to this operation');
        observed = mapped[0].observed;
      }
      evidence.push({ operationId: descriptor.id, kind: 'fixture', synthetic: true, version, ok: true, observed, proofRef: HARNESS_PROOF_REF });
      results.push({ id: descriptor.id, ok: true, observed });
    } catch (error) {
      results.push({ id: descriptor.id, ok: false, error: error.message });
    }
  }
  return { evidence, results };
}

const digest = (text) => `sha256:${createHash('sha256').update(text).digest('hex')}`;

/** Evidence and module versions from one operator-supplied capture file's text. */
export function evidenceFromCaptureText(text, { tenantRef, label = 'capture' }) {
  const parsed = JSON.parse(text);
  const proofRef = `${label}@${digest(text)}`;
  if (Array.isArray(parsed)) return evidenceFromProbeRows(parsed, { tenantRef, proofRef });
  const captures = Array.isArray(parsed?.captures) ? parsed.captures : [];
  return {
    evidence: captures.map((capture) => ({
      operationId: capture.operationId,
      kind: 'live-capture',
      synthetic: capture.synthetic === false ? false : true,
      tenantRef,
      capturedAt: capture.capturedAt ?? null,
      version: capture.version ?? null,
      ok: capture.ok === true,
      error: capture.error ?? null,
      observed: capture.observed ?? null,
      proofRef,
    })),
    runtime: { modules: {} },
  };
}

function parseArgs(argv) {
  const options = { json: false, harness: false, check: false, captures: [], tenantRef: null, grants: null, now: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--harness') options.harness = true;
    else if (arg === '--check') options.check = true;
    else if (arg === '--capture') options.captures.push(argv[++index]);
    else if (arg === '--tenant-ref') options.tenantRef = argv[++index];
    else if (arg === '--grants') options.grants = argv[++index];
    else if (arg === '--now') options.now = argv[++index];
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (options.captures.length && !options.tenantRef) throw new Error('--capture needs --tenant-ref: a capture counts only for the tenant it came from');
  return options;
}

export async function main(argv = process.argv.slice(2), { out = console.log, readFile = (path) => readFileSync(path, 'utf8') } = {}) {
  const options = parseArgs(argv);
  const evidence = [];
  const runtime = { modules: {} };
  for (const path of options.captures) {
    const result = evidenceFromCaptureText(readFile(path), { tenantRef: options.tenantRef, label: path });
    evidence.push(...result.evidence);
    Object.assign(runtime.modules, result.runtime.modules);
  }
  let harness = null;
  if (options.harness) {
    harness = await runFixtureHarness({ runtime });
    evidence.push(...harness.evidence);
  }
  const grants = options.grants ? JSON.parse(readFile(options.grants)) : null;
  const ledger = buildWorkloadLedger({
    evidence, grants, runtime, tenantRef: options.tenantRef, now: options.now ? new Date(options.now) : new Date(),
  });
  if (options.json) out(JSON.stringify({ ledger, harness: harness?.results ?? null }, null, 2));
  else {
    for (const row of ledger.rows) {
      const why = row.prerequisite?.message ?? row.reasons[0] ?? '';
      out(`${row.id.padEnd(28)} ${row.state.padEnd(20)} ${(row.enabled ? 'enabled' : 'off').padEnd(8)} ${String(row.version ?? '?').padEnd(8)} ${why}`);
    }
    if (harness) for (const result of harness.results.filter((item) => !item.ok)) out(`harness failed: ${result.id}: ${result.error}`);
  }
  const refused = ledger.rows.filter((row) => row.state === 'refused');
  return options.check && refused.length ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then((code) => { process.exitCode = code; }, (error) => { console.error(error.message); process.exitCode = 2; });
}
