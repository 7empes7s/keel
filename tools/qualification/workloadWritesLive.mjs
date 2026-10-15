#!/usr/bin/env node
/**
 * Wave 2 WKLD: capture one live write per writer family of a workload, as the proof
 * workloadWriteQualification needs before that writer may run. The operator runs this
 * against the test tenant; builders and CI never point it at a tenant.
 *
 *   node tools/qualification/workloadWritesLive.mjs plan --workload exchange-mail-flow
 *     Offline (the default). Prints what a capture would send, family by family. No network.
 *
 *   [KEEL_QUALIFICATION_HMAC_KEY=...] node tools/qualification/workloadWritesLive.mjs capture --confirm-live-tenant-write \
 *        --workload <workload> --tenant-ref sha256:... --directory-tenant-id <guid> \
 *        --collector-ref app:<collector app id> --restorer-ref app:<restorer app id> \
 *        --collector-config /etc/keel/<collector>.json --restorer-config /etc/keel/<restorer>.json \
 *        [--module-version <x.y.z>] --grants grants.json \
 *        --out docs/release/qualifications/workload-writers-<workload>-live-acceptance.json \
 *        [--build <sha>] [--powershell-image <tag>] [--no-create]
 *
 * Workloads: exchange-mail-flow, exchange-extended, teams-org-policies,
 * teams-voice-policies, purview-retention-dlp, purview-governance.
 *
 * The record is bound to the version of the workload's own module (MicrosoftTeams for
 * the Teams workloads, ExchangeOnlineManagement for the rest) that ops/powershell/Dockerfile
 * pins. --module-version is optional; one that is not that pin is refused before anything
 * is sent, so a Teams record can never carry the Exchange module's version.
 *
 * What a capture does, in order (and nothing else):
 *  0. offline: asks the write transport for a Remove- cmdlet and for an undeclared
 *     parameter. Both must be refused before anything is sent;
 *  1. collector: reads every written family once, with the workload's own collector;
 *  2. per family, when the family can re-create a named Teams policy (unless
 *     --no-create): restorer New- of KEEL-RT-capture-<random> with a Description;
 *     collector reads it back. KEEL never deletes, so the policy stays, assigned to nobody;
 *  3. per family, on the first KEEL-RT- object of that kind (matched by the prefix,
 *     never an exact name) that reports no preservation lock: collector reads it;
 *     restorer sets one harmless field (a comment or description, or on a policy a
 *     switch) to a marker; collector reads it back; restorer puts the original back;
 *     collector reads it back. Which field is decided by workloadWritesAcceptance.mjs:
 *     only a change the content-effect classifier finds nothing in, both ways.
 * A family with no KEEL-RT- object, or nothing harmless to change, is skipped and
 * listed; its writer stays off. Only KEEL-RT- objects are written: never a Global
 * policy, a tenant-wide setting, a Conditional Access policy or any account.
 *
 * Every cmdlet runs through the bounded job transport with the production allowlists
 * (reads through the collector, writes through workloadWriteCmdlet). Tenant ids are
 * pseudonymized. With KEEL_QUALIFICATION_HMAC_KEY set the record is signed as
 * `keel-release-runner`; without it the record cannot verify.
 *
 * ledgerEvidenceFromWorkloadWritesAcceptance() is the import seam: a record that passes
 * `verify --require-live` becomes one live write capture per proven write, the
 * restorer's grants, and the module version the captures are bound to. Anything less
 * becomes nothing.
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { exchangeCmdlet, structuredFailure } from '../../engine/collect/workloads/exchange.mjs';
import { readExchangeExtended } from '../../engine/collect/workloads/exchangeExtended.mjs';
import { readMailFlow } from '../../engine/collect/workloads/mailFlow.mjs';
import { lockState } from '../../engine/collect/workloads/purview.mjs';
import { readPurviewExtended } from '../../engine/collect/workloads/purviewExtended.mjs';
import { readRetentionDlp } from '../../engine/collect/workloads/purviewRetentionDlp.mjs';
import { readTeamsExtended } from '../../engine/collect/workloads/teamsExtended.mjs';
import { readTeamsPolicies } from '../../engine/collect/workloads/teamsPolicies.mjs';
import { CmdletError } from '../../engine/powershell/jobQueue.mjs';
import { workloadTarget, workloadWriteCmdlet, writeFamilies } from '../../engine/restore/workloads/cmdletSettings.mjs';
import { TENANT_WIDE_OPTION, onTestTenant } from '../../engine/restore/workloads/fixtureGuard.mjs';
import { WKLD_WRITE_OPERATIONS } from '../../engine/restore/workloads/writeDeclarations.mjs';
import { tenantRefFor } from '../../engine/store/tenantRef.mjs';
import { QUALIFICATION_CONTRACT_VERSION, signEvidence, verifyEvidence } from '../release/qualification.mjs';
import { pseudonymizeCapture } from './pseudonymize.mjs';
import {
  CAPTURE_CREATE_PREFIX, WORKLOAD_WRITES_CREDENTIAL_MODE, WORKLOAD_WRITES_LIVE_GATE, WORKLOAD_WRITES_LIVE_OPERATION,
  WORKLOAD_WRITES_TRANSPORT, WRITTEN_WORKLOADS, TENANT_WIDE_WRITES, chooseCaptureChange, fixtureNameOf, identityNamesFixture, isFixtureName, provenWrites, sameValue,
  workloadWritesRecordFile,
} from './workloadWritesAcceptance.mjs';

/** Each written workload's own read-only collector. */
export const WORKLOAD_READERS = Object.freeze({
  'exchange-mail-flow': readMailFlow,
  'exchange-extended': readExchangeExtended,
  'teams-org-policies': readTeamsPolicies,
  'teams-voice-policies': readTeamsExtended,
  'purview-retention-dlp': readRetentionDlp,
  'purview-governance': readPurviewExtended,
});

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODULE_VERSION_RE = /^\d+\.\d+\.\d+(\.\d+)?$/;
const sha256Hex = (text) => createHash('sha256').update(text).digest('hex');

function knownWorkload(workload) {
  if (!WRITTEN_WORKLOADS[workload]) throw new Error(`--workload must be one of: ${Object.keys(WRITTEN_WORKLOADS).join(', ')}`);
  return workload;
}

/** Offline: what a capture of `workload` would send, family by family. */
export function workloadWritesCapturePlan({ workload, includeCreates = true, allowTenantWide = false }) {
  knownWorkload(workload);
  const steps = [
    { step: 0, credential: 'none', refused: 'a Remove- cmdlet (KEEL never deletes; refused before sending)' },
    { step: 0, credential: 'none', refused: 'a declared write with an undeclared parameter (refused before sending)' },
    { step: 1, credential: 'collector', read: `${workload}: every written family` },
  ];
  for (const [family, ops] of Object.entries(writeFamilies(workload))) {
    if (includeCreates && ops.add) {
      const add = WKLD_WRITE_OPERATIONS[ops.add];
      steps.push({ step: 2, credential: 'restorer', cmdlet: add.method, parameters: { Identity: `${CAPTURE_CREATE_PREFIX}<random>`, Description: '<marker>' }, operationId: ops.add, note: 'stays, assigned to nobody' });
      steps.push({ step: 2, credential: 'collector', read: family, operationId: ops.add, note: 'read back' });
    }
    const write = WKLD_WRITE_OPERATIONS[ops.update];
    const tenantWide = allowTenantWide && TENANT_WIDE_WRITES.includes(ops.update);
    steps.push({ step: 3, credential: 'collector', read: family, operationId: ops.update, note: tenantWide
      ? 'the first KEEL-RT- object with no lock; with none, the tenant-wide setting when it is the only object'
      : 'the first KEEL-RT- object with no lock; skipped when there is none' });
    steps.push({ step: 3, credential: 'restorer', cmdlet: write.method, parameters: { Identity: '<the fixture>', '<a comment, description or switch>': '<marker>' }, operationId: ops.update });
    steps.push({ step: 3, credential: 'collector', read: family, operationId: ops.update, note: 'read back' });
    steps.push({ step: 3, credential: 'restorer', cmdlet: write.method, parameters: { Identity: '<the fixture>', '<the same field>': '<original>' }, operationId: ops.update, note: 'put back' });
    steps.push({ step: 3, credential: 'collector', read: family, operationId: ops.update, note: 'read back' });
  }
  return steps;
}

/** Reads until `matches`; a read that fails counts as no match and is retried. */
async function readUntil(readOnce, matches, { sleep, attempts, delayMs }) {
  let found = null;
  let error = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt) await sleep(delayMs);
    try {
      found = await readOnce();
      error = null;
    } catch (failure) {
      found = null;
      error = failure;
      continue;
    }
    if (matches(found)) return { found, matched: true, error: null };
  }
  return { found, matched: false, error };
}

const isLocked = (entry) => entry?.lock === 'locked' || lockState(entry?.fields) === 'locked';

/** Why `entry` cannot be written, or null. A rule's policy must be read and unlocked. */
function lockProblem(entry, resources) {
  if (isLocked(entry)) return 'it reports a preservation lock';
  if (entry.parentPolicy || entry.parentStatus) {
    const parent = resources.find((item) => item.identity === entry.parentPolicy && !String(item.kind).endsWith('Rule'));
    if (!parent) return 'its policy was not read, so its lock is unknown';
    if (isLocked(parent)) return 'its policy reports a preservation lock';
  }
  return null;
}

/** The parameters naming an object to its Set- cmdlet (writeDeclarations.mjs `identity`). */
function identityOf(write, entry) {
  if (write.identity === 'guid') return { Identity: entry.identity };
  if (write.identity === 'object-name') return { Identity: entry.fields.Name };
  if (write.identity === 'fixed') return { Identity: write.fixedIdentity };
  return { Identity: entry.fields.Identity };
}

/**
 * Runs a capture. `collector` and `restorer` are the runCmdlet options for each
 * identity's tenant config; `configs` what each config names: { tenantId, organization }.
 * Exchange and Purview sessions connect by `organization`, so for them both sessions
 * must answer as one organization, and one that reports a tenant id must report the
 * managed tenant's, before anything is written. Returns
 * the unsigned record and the capture log, with tenant ids pseudonymized; it never
 * signs and never writes files.
 */
export async function captureWorkloadWrites({
  workload, collector, restorer, read = WORKLOAD_READERS[workload], directoryTenantId, configs = {}, tenantRef, build,
  credentials, grants, moduleVersion, includeCreates = true, allowTenantWide = false, testTenantRefs, now = () => new Date(), sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
  readBackAttempts = 5, readBackDelayMs = 2000, suffix = () => randomBytes(4).toString('hex'),
}) {
  knownWorkload(workload);
  const { module } = WRITTEN_WORKLOADS[workload];
  const problems = [];
  if (typeof directoryTenantId !== 'string' || !GUID_RE.test(directoryTenantId)) problems.push('--directory-tenant-id must be the managed tenant id (a GUID)');
  if (typeof moduleVersion !== 'string' || !MODULE_VERSION_RE.test(moduleVersion)) problems.push(`--module-version must be the ${module} version in the container (x.y.z)`);
  if (!tenantRef || !build) problems.push('a capture needs --tenant-ref and a build');
  if (!credentials?.collector || !credentials?.restorer || credentials.collector === credentials.restorer) {
    problems.push('a capture needs two separate credential references (collector, restorer)');
  }
  if (!grants?.restorer || !Array.isArray(grants.restorer.permissions) || !Array.isArray(grants.restorer.roles)) problems.push('--grants must name the restorer\'s permissions and roles');
  if (allowTenantWide && tenantRef && !onTestTenant(tenantRef, testTenantRefs)) problems.push(`${TENANT_WIDE_OPTION} is allowed on the test tenant only; nothing was sent`);
  if (problems.length) throw new Error(problems.join('; '));
  const tenant = directoryTenantId.toLowerCase();
  for (const role of ['collector', 'restorer']) {
    const named = configs[role]?.tenantId;
    if (typeof named !== 'string' || named.toLowerCase() !== tenant) throw new Error(`the ${role} config does not name the managed tenant; nothing was sent`);
  }
  const exchangeSession = module === 'ExchangeOnlineManagement';
  if (exchangeSession) {
    const [a, b] = ['collector', 'restorer'].map((role) => configs[role]?.organization);
    if (typeof a !== 'string' || !a || typeof b !== 'string' || a.toLowerCase() !== b.toLowerCase()) {
      throw new Error('the collector and restorer configs must name the same Exchange organization; nothing was sent');
    }
  }

  const requests = [];
  const log = { requests, values: {} };
  const families = Object.entries(writeFamilies(workload));
  const readFamilies = async (names) => {
    const entry = { credential: 'collector', read: workload, families: names, outcome: 'ok', at: now().toISOString() };
    try {
      const result = await read({ powershell: collector, families: names });
      requests.push(entry);
      return result;
    } catch (error) {
      requests.push({ ...entry, outcome: 'failed', error: error.message });
      throw error;
    }
  };
  const writeCmdlet = async (cmdlet, parameters) => {
    const entry = { credential: 'restorer', cmdlet, parameters: { ...parameters }, outcome: 'ok', at: now().toISOString() };
    try {
      const result = await workloadWriteCmdlet({ cmdlet, parameters }, restorer);
      requests.push(entry);
      return result;
    } catch (error) {
      if (error instanceof CmdletError) {
        const failed = structuredFailure(error);
        requests.push({ ...entry, outcome: failed.status, error: { code: failed.error.code, errorId: failed.error.errorId ?? null } });
      }
      throw error;
    }
  };

  // 0. Offline refusals: a delete and an undeclared parameter never leave this process.
  const sentBefore = requests.length;
  const [firstFamily, firstOps] = families[0];
  const probe = WKLD_WRITE_OPERATIONS[firstOps.update];
  const refusals = {
    remove: { cmdlet: probe.method.replace(/^Set-/, 'Remove-'), refused: false, sent: false },
    undeclaredParameter: { cmdlet: probe.method, parameter: 'Force', refused: false, sent: false },
  };
  for (const [key, parameters] of [['remove', { Identity: `${CAPTURE_CREATE_PREFIX}refusal-probe` }], ['undeclaredParameter', { Identity: `${CAPTURE_CREATE_PREFIX}refusal-probe`, Force: true }]]) {
    try {
      await writeCmdlet(refusals[key].cmdlet, parameters);
    } catch (error) {
      refusals[key].refused = !(error instanceof CmdletError);
      refusals[key].reason = error.message;
    }
    refusals[key].sent = requests.length !== sentBefore;
  }
  log.values.refusalFamily = firstFamily;

  // Exchange and Purview connect by organization, not tenant id: prove both sessions are one organization.
  const organization = exchangeSession ? { collector: null, restorer: null } : null;
  if (exchangeSession) {
    for (const [role, powershell] of [['collector', collector], ['restorer', restorer]]) {
      try {
        const { output } = await exchangeCmdlet({ cmdlet: 'Get-OrganizationConfig' }, powershell);
        const body = output.length === 1 ? output[0] : null;
        const id = typeof body?.ExternalDirectoryOrganizationId === 'string' && body.ExternalDirectoryOrganizationId ? body.ExternalDirectoryOrganizationId.toLowerCase() : null;
        const name = typeof body?.Name === 'string' && body.Name ? body.Name : null;
        organization[role] = { tenantId: id, name };
      } catch (error) {
        organization[role] = { tenantId: null, name: null, error: error.message };
      }
    }
  }
  // Some tenants (the test tenant among them) report no ExternalDirectoryOrganizationId. A
  // reported id must be the managed tenant's; with none, the binding is the tenant config's
  // organization, which both sessions must then answer as (tenantIdSource 'config').
  const configOrganization = exchangeSession ? configs.collector.organization.toLowerCase() : null;
  const organizationProblem = !exchangeSession ? null
    : Object.values(organization).some((item) => !item.name) ? 'an Exchange session did not answer Get-OrganizationConfig'
      : Object.values(organization).some((item) => item.name.toLowerCase() !== configOrganization) ? `an Exchange session is not the organization the tenant configs name (${configs.collector.organization})`
        : Object.values(organization).some((item) => item.tenantId && item.tenantId !== tenant) ? 'an Exchange session belongs to another tenant'
          : null;
  if (exchangeSession) organization.tenantIdSource = Object.values(organization).every((item) => item.tenantId === tenant) ? 'organization' : 'config';

  // 1. Every written family, once.
  const timing = { sleep, attempts: readBackAttempts, delayMs: readBackDelayMs };
  const stamp = now().toISOString();
  const marker = `KEEL capture ${stamp}`;
  const writes = [];
  const skipped = [];
  const created = [];
  let refusal = null;
  let live = null;
  if (organizationProblem) refusal = `${organizationProblem}; nothing was written`;
  else {
    try {
      live = await readFamilies(families.map(([family]) => family));
    } catch (error) {
      refusal = `the first read failed (${error.message}); nothing was written`;
    }
  }
  if (!refusal && !Object.values(refusals).every((item) => item.refused && !item.sent)) refusal = 'the write transport did not refuse a delete or an undeclared parameter; nothing was written';

  const base = (id) => ({
    operationId: id, kind: id.endsWith('.add') ? 'add' : 'update', method: WKLD_WRITE_OPERATIONS[id].method, version: moduleVersion, synthetic: false,
    scope: 'fixture', fixture: null, identity: null, field: null, type: null, before: null, target: null, final: null, contentEffects: [],
    ok: false, readBackVerified: false, restoredToOriginal: false, capturedAt: null, error: null,
  });
  const familyRead = (family) => async () => {
    const result = await readFamilies([family]);
    const gap = [...(result.failures ?? []), ...(result.unavailable ?? [])].find((item) => item.family === family);
    if (gap) throw new Error(`the ${family} read was ${gap.status}`);
    return result.resources.filter((item) => item.kind === family);
  };
  const named = (name) => (entries) => entries.find((item) => String(fixtureNameOf(item) ?? '').toLowerCase() === name.toLowerCase()) ?? null;

  for (const [family, ops] of refusal ? [] : families) {
    const gap = [...(live.failures ?? []), ...(live.unavailable ?? [])].find((item) => item.family === family);
    if (gap) {
      for (const id of [ops.add, ops.update].filter(Boolean)) skipped.push({ family, operationId: id, reason: `the ${family} read was ${gap.status}` });
      continue;
    }
    const readFamily = familyRead(family);

    // 2. Re-create: a new KEEL-RT-capture-* policy, read back. It is never deleted.
    if (ops.add && !includeCreates) skipped.push({ family, operationId: ops.add, reason: '--no-create' });
    if (ops.add && includeCreates) {
      const add = WKLD_WRITE_OPERATIONS[ops.add];
      const capture = base(ops.add);
      const name = `${CAPTURE_CREATE_PREFIX}${suffix()}`;
      Object.assign(capture, { fixture: name, identity: name, field: 'Description', type: 'text', target: marker });
      try {
        await writeCmdlet(add.method, { Identity: name, Description: marker });
        capture.ok = true;
        created.push({ family, name });
      } catch (error) {
        if (error instanceof CmdletError && error.detail.code === 'CMDLET_ERROR') capture.error = `${add.method} failed: ${error.message}`;
        else { capture.error = `${add.method} had no answer (${error.message}); it may have applied`; created.push({ family, name, unknown: true }); }
      }
      if (capture.ok || created.some((item) => item.name === name)) {
        try {
          const seen = await readUntil(async () => named(name)(await readFamily()), (entry) => sameValue(entry?.fields?.Description, marker), timing);
          capture.readBackVerified = seen.matched;
          capture.final = seen.found?.fields?.Description ?? null;
        } catch (error) {
          capture.error ??= `read back failed: ${error.message}`;
        }
      }
      capture.capturedAt = now().toISOString();
      writes.push(capture);
    }

    // 3. Update: one harmless field on the first KEEL-RT- object with no lock, then put back.
    const write = WKLD_WRITE_OPERATIONS[ops.update];
    const fixturesIn = (resources) => resources.filter((item) => item.kind === family && isFixtureName(fixtureNameOf(item)))
      .sort((a, b) => String(fixtureNameOf(a)).localeCompare(String(fixtureNameOf(b))));
    let resources = live.resources ?? [];
    // With no fixture of its own, a family uses the policy its add capture just created.
    if (!fixturesIn(resources).length && created.some((item) => item.family === family)) {
      try { resources = [...resources, ...await readFamily()]; } catch { /* still none */ }
    }
    // A fixed identity names the one tenant-wide object, so it is never a fixture write.
    let candidates = write.identity === 'fixed' ? [] : fixturesIn(resources);
    let scope = 'fixture';
    // A tenant-wide setting has no KEEL-RT- name: written only when allowed, and only when it is the one object.
    if (!candidates.length && allowTenantWide && TENANT_WIDE_WRITES.includes(ops.update)) {
      const all = resources.filter((item) => item.kind === family);
      if (all.length !== 1 || !workloadTarget(write, family, all[0]).tenantWide) {
        skipped.push({ family, operationId: ops.update, reason: `a tenant-wide setting, but the read returned ${all.length} objects, not the one tenant-wide object` });
        continue;
      }
      candidates = all;
      scope = 'tenant-wide';
    }
    const usable = candidates.map((entry) => ({ entry, lock: lockProblem(entry, resources) }));
    const pick = usable.find((item) => !item.lock);
    if (!pick) {
      skipped.push({ family, operationId: ops.update, reason: candidates.length ? `every KEEL-RT- object of this kind is unusable: ${usable[0].lock}` : 'no KEEL-RT- object of this kind in the tenant' });
      continue;
    }
    const name = fixtureNameOf(pick.entry) ?? (scope === 'tenant-wide' ? pick.entry.fields?.Identity ?? null : null);
    const change = chooseCaptureChange(write, pick.entry, { marker, tenantWide: scope === 'tenant-wide' });
    if (change.reason) {
      skipped.push({ family, operationId: ops.update, fixture: name, reason: change.reason });
      continue;
    }
    const capture = base(ops.update);
    Object.assign(capture, { scope, fixture: name, identity: identityOf(write, pick.entry).Identity ?? null, field: change.field, type: change.type });
    writes.push(capture);
    await captureUpdate({ write, capture, change, key: pick.entry.resourceKey, readFamily, writeCmdlet, log, timing });
    capture.capturedAt = now().toISOString();
  }
  if (refusal) for (const [family, ops] of families) for (const id of [ops.add, ops.update].filter(Boolean)) skipped.push({ family, operationId: id, reason: refusal });

  const captureLog = `${JSON.stringify(log, null, 2)}\n`;
  const record = {
    contractVersion: QUALIFICATION_CONTRACT_VERSION,
    gate: WORKLOAD_WRITES_LIVE_GATE,
    tenantRef,
    build,
    operation: WORKLOAD_WRITES_LIVE_OPERATION,
    credentialMode: WORKLOAD_WRITES_CREDENTIAL_MODE,
    observedAt: now().toISOString(),
    evidenceLevel: 'live-qualified',
    synthetic: false,
    subject: {
      workload,
      directoryTenantId: tenant,
      organization,
      tenantWide: allowTenantWide,
      execution: { transport: WORKLOAD_WRITES_TRANSPORT, module, moduleVersion },
      credentials: { collector: credentials.collector, restorer: credentials.restorer },
      grants,
      refusals,
      writes,
      skipped,
      created,
      requests: requests.map(({ at, ...request }) => request),
      captureLogSha256: sha256Hex(captureLog),
    },
  };
  const needsManualRevert = writes.filter((capture) => capture.kind === 'update' && log.values[capture.operationId]?.written && capture.restoredToOriginal !== true);
  return { ...pseudonymizeCapture({ record, log }), needsManualRevert };
}

async function captureUpdate({ write, capture, change, key, readFamily, writeCmdlet, log, timing }) {
  const readEntry = async () => (await readFamily()).find((item) => item.resourceKey === key) ?? null;
  const state = (log.values[capture.operationId] = { written: false });
  let identity = null;
  let putBack = null;
  try {
    // Re-read just before writing: the original is what the object holds now.
    const now = await readEntry();
    if (!now) { capture.error = 'the fixture is gone; nothing was written'; return; }
    if (now.fieldCoverage?.[change.field]?.status !== 'observed') { capture.error = `${change.field} was not observed; nothing was written`; return; }
    const original = now.fields[change.field] ?? null;
    if (!sameValue(original, change.before)) { capture.error = `${change.field} changed since the first read; nothing was written`; return; }
    capture.before = original;
    capture.target = change.after;
    identity = identityOf(write, now);
    if (identity.Identity !== capture.identity || !identityNamesFixture(write, capture)) { capture.error = 'the fixture\'s identity changed since the first read; nothing was written'; return; }
    putBack = original ?? (change.type === 'text' ? '' : original);
    try {
      await writeCmdlet(write.method, { ...identity, [change.field]: change.after });
    } catch (error) {
      // A cmdlet error is a definite answer; anything else may have applied.
      if (error instanceof CmdletError && error.detail.code === 'CMDLET_ERROR') { capture.error = `${write.method} failed: ${error.message}`; return; }
      capture.error = `${write.method} had no answer (${error.message}); it may have applied`;
    }
    state.written = true;
    const seen = await readUntil(readEntry, (entry) => sameValue(entry?.fields?.[change.field], change.after), timing);
    capture.readBackVerified = seen.matched;
  } catch (error) {
    capture.error ??= error.message;
  }
  if (!state.written) return;
  // Always put the original back once a write may have applied, whatever the read-back said.
  let revertError = null;
  try {
    await writeCmdlet(write.method, { ...identity, [change.field]: putBack });
  } catch (error) {
    revertError = error;
  }
  const restored = await readUntil(readEntry, (entry) => sameValue(entry?.fields?.[change.field], capture.before), timing);
  capture.restoredToOriginal = restored.matched;
  capture.final = restored.found?.fields?.[change.field] ?? null;
  capture.ok = capture.error === null && revertError === null;
  if (!restored.matched) {
    const why = revertError?.message ?? restored.error?.message ?? null;
    capture.error = `PUTTING THE SETTING BACK FAILED${why ? ` (${why})` : ''}: set ${change.field} on ${capture.fixture} to ${JSON.stringify(capture.before)} by hand`;
  }
}

/**
 * Writes the record and its capture log side by side, binding the log's digest as
 * the artifact proof, and signs the record when a runner key is given.
 */
export function writeWorkloadWritesFiles({ record, captureLog, outPath, hmacKey = null }) {
  const logPath = outPath.replace(/\.json$/, '') + '.capture.json';
  writeFileSync(logPath, captureLog);
  let evidence = { ...record, proof: { artifact: { path: basename(logPath), sha256: sha256Hex(captureLog) } } };
  if (hmacKey) evidence = signEvidence(evidence, hmacKey, 'keel-release-runner');
  writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`);
  return { evidence, logPath };
}

/**
 * The import seam: a record that passes the gate with --require-live becomes one live
 * write capture per proven write (for workloadWriteQualification), the restorer's
 * grants, and the module version the captures are bound to. Anything else yields none.
 * Reads come from their own proof, never from here.
 */
export function ledgerEvidenceFromWorkloadWritesAcceptance(evidence, options = {}) {
  const result = verifyEvidence(evidence, { ...options, gate: WORKLOAD_WRITES_LIVE_GATE, requireLive: true });
  if (!result.ok) return { ok: false, failures: result.failures, reads: [], writes: [], grants: null, restorerGrants: null, runtime: null };
  const { subject, tenantRef } = evidence;
  const proofRef = `${WORKLOAD_WRITES_LIVE_GATE}/${subject.workload}@${subject.captureLogSha256}`;
  return {
    ok: true,
    failures: [],
    reads: [],
    writes: provenWrites(subject).map((item) => ({
      operationId: item.operationId, kind: 'live-write-capture', synthetic: false, tenantRef, capturedAt: item.capturedAt,
      version: item.version, ok: true, readBackVerified: true, proofRef,
    })),
    grants: null,
    restorerGrants: { permissions: [...subject.grants.restorer.permissions], roles: [...subject.grants.restorer.roles] },
    runtime: { modules: { [subject.execution.module]: subject.execution.moduleVersion } },
  };
}

function parseArgs(argv) {
  const [command = 'plan', ...rest] = argv;
  const options = { command, confirm: false, includeCreates: true, allowTenantWide: false };
  const names = {
    '--workload': 'workload', '--tenant-ref': 'tenantRef', '--directory-tenant-id': 'directoryTenantId',
    '--collector-ref': 'collectorRef', '--restorer-ref': 'restorerRef', '--collector-config': 'collectorConfig', '--restorer-config': 'restorerConfig',
    '--module-version': 'moduleVersion', '--grants': 'grants', '--out': 'out', '--build': 'build', '--powershell-image': 'image',
  };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === '--confirm-live-tenant-write') options.confirm = true;
    else if (arg === '--no-create') options.includeCreates = false;
    else if (arg === TENANT_WIDE_OPTION) options.allowTenantWide = true;
    else if (names[arg]) options[names[arg]] = rest[++index];
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

const powershellFor = (tenantConfigPath, image) => ({ tenantConfigPath, ...(image ? { image } : {}) });

const POWERSHELL_DOCKERFILE = new URL('../../ops/powershell/Dockerfile', import.meta.url);

/** The module versions the PowerShell image pins: { [module]: 'x.y.z' } from each `Install-Module -RequiredVersion`. */
export function pinnedModuleVersions(dockerfile) {
  const pins = {};
  for (const [, name, version] of dockerfile.matchAll(/Install-Module\s+-Name\s+([\w.]+)\s+-RequiredVersion\s+(\d+(?:\.\d+){2,3})\b/g)) pins[name] = version;
  return pins;
}

export async function main(argv = process.argv.slice(2), {
  out = console.log, env = process.env, readFile = (path) => readFileSync(path, 'utf8'), capture = captureWorkloadWrites,
  powershell = powershellFor, pins = () => pinnedModuleVersions(readFileSync(POWERSHELL_DOCKERFILE, 'utf8')),
} = {}) {
  const options = parseArgs(argv);
  if (options.command === 'plan') {
    out(JSON.stringify(workloadWritesCapturePlan(options), null, 2));
    return 0;
  }
  if (options.command !== 'capture') throw new Error('usage: workloadWritesLive.mjs plan|capture --workload <workload> ...');
  if (!options.confirm) {
    out(JSON.stringify(workloadWritesCapturePlan(options), null, 2));
    out('refused: a capture writes KEEL-RT- fixtures in the tenant and puts each setting back; rerun with --confirm-live-tenant-write');
    return 2;
  }
  for (const [flag, key] of [
    ['--workload', 'workload'], ['--tenant-ref', 'tenantRef'], ['--directory-tenant-id', 'directoryTenantId'], ['--collector-ref', 'collectorRef'],
    ['--restorer-ref', 'restorerRef'], ['--collector-config', 'collectorConfig'], ['--restorer-config', 'restorerConfig'],
    ['--grants', 'grants'], ['--out', 'out'],
  ]) {
    if (!options[key]) throw new Error(`capture needs ${flag}`);
  }
  knownWorkload(options.workload);
  if (options.collectorConfig === options.restorerConfig) throw new Error('the collector and restorer must use separate tenant config files');
  if (basename(options.out) !== workloadWritesRecordFile(options.workload)) {
    throw new Error(`--out must be named ${workloadWritesRecordFile(options.workload)}, where the import looks for it`);
  }
  const build = options.build ?? env.KEEL_QUALIFICATION_BUILD;
  if (!build) throw new Error('capture needs --build (or KEEL_QUALIFICATION_BUILD): the build this capture qualifies');
  const configOf = (path) => {
    const { tenantId, organization } = JSON.parse(readFile(path));
    return { tenantId, organization };
  };
  const configs = { collector: configOf(options.collectorConfig), restorer: configOf(options.restorerConfig) };
  if (typeof configs.collector.tenantId !== 'string' || options.tenantRef !== tenantRefFor(configs.collector.tenantId)) {
    throw new Error('--tenant-ref is not the tenant the collector config names; nothing was sent');
  }
  // Each workload records its own module's version: the one the image pins, never one typed for another module.
  const { module } = WRITTEN_WORKLOADS[options.workload];
  const moduleVersion = pins()[module];
  if (!moduleVersion) throw new Error(`ops/powershell/Dockerfile pins no ${module} version; nothing was sent`);
  if (options.moduleVersion && options.moduleVersion !== moduleVersion) {
    throw new Error(`--module-version ${options.moduleVersion} is not the ${module} version the image pins (${moduleVersion}); nothing was sent`);
  }
  const outPath = resolve(options.out);
  const { record, captureLog, needsManualRevert } = await capture({
    workload: options.workload,
    collector: powershell(options.collectorConfig, options.image),
    restorer: powershell(options.restorerConfig, options.image),
    directoryTenantId: options.directoryTenantId,
    configs,
    tenantRef: options.tenantRef,
    build,
    moduleVersion,
    credentials: { collector: options.collectorRef, restorer: options.restorerRef },
    grants: JSON.parse(readFile(options.grants)),
    includeCreates: options.includeCreates,
    allowTenantWide: options.allowTenantWide,
  });
  const { evidence, logPath } = writeWorkloadWritesFiles({ record, captureLog, outPath, hmacKey: env.KEEL_QUALIFICATION_HMAC_KEY ?? null });
  const result = verifyEvidence(evidence, { gate: WORKLOAD_WRITES_LIVE_GATE, tenantRef: options.tenantRef, build, requireLive: true, evidenceDir: dirname(outPath) });
  const proven = provenWrites(evidence.subject).map((item) => item.operationId);
  out(JSON.stringify({
    evidence: outPath, captureLog: logPath, proven, skipped: evidence.subject.skipped, created: evidence.subject.created,
    notProven: evidence.subject.writes.filter((item) => !proven.includes(item.operationId)).map(({ operationId, error }) => ({ operationId, error })),
    needsManualRevert: needsManualRevert.map(({ operationId, fixture, field, before, error }) => ({ operationId, fixture, field, before, error })),
    verify: result,
  }, null, 2));
  // 3: a fixture may not be back where it started; the output says what to fix by hand.
  if (needsManualRevert.length) return 3;
  return result.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then((code) => { process.exitCode = code; }, (error) => { console.error(error.message); process.exitCode = 2; });
}
