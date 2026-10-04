#!/usr/bin/env node
/**
 * Roadmap task-122: capture and import Exchange configuration live-acceptance
 * evidence. The operator runs this; builders and CI never point it at a tenant.
 *
 *   node tools/qualification/exchangeLive.mjs plan --fixture-mailbox keel-rt-...@<domain>
 *     Offline (the default). Prints every request and cmdlet a capture would send. No network.
 *
 *   KEEL_EXCHANGE_COLLECTOR_TOKEN=... KEEL_EXCHANGE_RESTORER_TOKEN=... [KEEL_QUALIFICATION_HMAC_KEY=...] \
 *   node tools/qualification/exchangeLive.mjs capture --confirm-live-tenant-write \
 *        --tenant-ref sha256:... --directory-tenant-id <guid> --fixture-mailbox keel-rt-...@<domain> \
 *        --collector-ref app:<collector app id> --restorer-ref app:<restorer app id> \
 *        --collector-config /etc/keel/exchange-collector.json --restorer-config /etc/keel/exchange-restorer.json \
 *        --exchange-module-version <x.y.z> --grants grants.json --docs docs.json \
 *        --teams-evidence docs/release/qualifications/teams-live-acceptance.json \
 *        --out docs/release/qualifications/exchange-live-acceptance.json [--build <sha>] [--powershell-image <tag>]
 *
 * Before anything is sent, the task-121 Teams record must verify with --require-live
 * for the same tenant and build, and sit beside --out (with the task-120 SharePoint
 * record it names): Exchange is qualified only after Teams, and neither Teams nor
 * SharePoint proof is ever Exchange proof.
 *
 * What a capture does, in order (and nothing else):
 *  0. offline: asks KEEL to write a held field (Set-Mailbox -LitigationHoldDuration)
 *     and to read a content path (/messages). Both must be refused before sending;
 *  1. collector: GET /users/{fixture}/mailboxSettings; Get-OrganizationConfig;
 *     Get-Mailbox and Get-CASMailbox -Identity {fixture};
 *  2. collector: Get-Mailbox -Identity of an absent keel-rt-* identity, to capture a
 *     platform error as it comes back (it must not exist);
 *  3. restorer: read mailboxSettings; PATCH timeZone to another zone; read back;
 *     PATCH the original timeZone back; read back;
 *  4. restorer: Get-CASMailbox; Set-CASMailbox -PopEnabled to the other value; read
 *     back; Set-CASMailbox -PopEnabled back; read back;
 *  5. restorer: Get-Mailbox; Set-Mailbox -RetainDeletedItemsFor one day LONGER (at
 *     most 30 days); read back. Retention is never put back: that would shorten it.
 * Only the fixture mailbox is addressed. No message, folder, rule, calendar, contact
 * or file is read; no hold is released or changed; no retention is shortened; the
 * mailbox is never deleted. Set-OrganizationConfig is never sent: it changes the
 * whole tenant and is an open operator decision.
 *
 * Cmdlets run through the bounded task-105 job transport (engine/powershell/jobQueue.mjs):
 * parameters are JSON data, never script source. Graph tokens come from the
 * environment and are never written; cmdlet credentials stay in the tenant config
 * files the container reads. The record carries references only. With
 * KEEL_QUALIFICATION_HMAC_KEY set the record is signed as `keel-release-runner`;
 * without it the record cannot verify.
 *
 * ledgerEvidenceFromExchangeAcceptance() is the import seam: a record that passes
 * `verify --require-live` becomes task-101 read evidence for the four Exchange reads
 * and one live write capture per qualified Exchange write. Anything less becomes nothing.
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { readGraphConfiguration } from '../../engine/collect/workloadContract.mjs';
import {
  CLIENT_ACCESS_FIELDS, COMPLIANCE_HOLD_FIELDS, EXCHANGE_MODULE, MAILBOX_SETTING_FIELDS, ORGANIZATION_FIELDS, RETENTION_FIELDS,
  assertExchangeCmdlet, assertExchangeRequest, exchangeCmdlet, structuredFailure,
} from '../../engine/collect/workloads/exchange.mjs';
import { QUALIFICATION_CONTRACT_VERSION, signEvidence, verifyEvidence } from '../release/qualification.mjs';
import {
  EXCHANGE_CAS_TOGGLE, EXCHANGE_FIXTURE_PREFIX, EXCHANGE_HOLD_WRITE_FIELDS, EXCHANGE_LIVE_CAS_WRITE, EXCHANGE_LIVE_CREDENTIAL_MODE,
  EXCHANGE_LIVE_GATE, EXCHANGE_LIVE_OPERATION, EXCHANGE_LIVE_PREREQUISITES, EXCHANGE_LIVE_RETENTION_WRITE, EXCHANGE_LIVE_SETTINGS_WRITE,
  EXCHANGE_MAX_RETENTION_MS, EXCHANGE_REFUSAL_PROBE, EXCHANGE_RETENTION_PROPERTY, EXCHANGE_SETTINGS_TOGGLE, EXCHANGE_TRANSPORT,
  exchangeDurationMs, exchangeDurationText, exchangeGroupFingerprint, exchangeIsFixtureIdentity, exchangeOperationVersion, exchangeReadDescriptor,
} from './exchangeAcceptance.mjs';
import { TEAMS_LIVE_GATE } from './teamsAcceptance.mjs';
import { teamsBearerTransport } from './teamsLive.mjs';

const GRAPH = 'https://graph.microsoft.com';
const VERSION = 'v1.0';
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODULE_VERSION_RE = /^\d+\.\d+\.\d+(\.\d+)?$/;
const WRITE_THROTTLE_MAX_ATTEMPTS = 3;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
// Two zones Exchange and Graph both accept; the capture moves to whichever is not set.
export const EXCHANGE_TIME_ZONES = Object.freeze(['UTC', 'Greenwich Standard Time']);
// Identity facts a capture keeps from Get-Mailbox and Get-OrganizationConfig, beyond the observed fields.
const MAILBOX_IDENTITY_FIELDS = Object.freeze(['UserPrincipalName', 'ExternalDirectoryObjectId', 'RecipientTypeDetails']);

const sha256Hex = (text) => createHash('sha256').update(text).digest('hex');
const ok = (response) => response.status >= 200 && response.status < 300;

/** Refuses anything but a keel-rt-* mailbox named by its UPN. */
export function exchangeFixtureProblems({ fixtureMailbox }) {
  if (!exchangeIsFixtureIdentity(fixtureMailbox)) {
    return [`--fixture-mailbox must be a disposable ${EXCHANGE_FIXTURE_PREFIX}* mailbox named by its UPN`];
  }
  return [];
}

/** An identity under the fixture's domain that must not exist, for the platform-error probe. */
export function exchangeProbeIdentity(fixtureMailbox, suffix = randomBytes(6).toString('hex')) {
  return `${EXCHANGE_FIXTURE_PREFIX}absent-${suffix}@${fixtureMailbox.split('@')[1]}`;
}

/** Offline: the requests and cmdlets a capture would send, in order. */
export function exchangeCapturePlan({ fixtureMailbox }) {
  const problems = exchangeFixtureProblems({ fixtureMailbox });
  if (problems.length) throw new Error(problems.join('; '));
  const settings = `/v1.0/users/${encodeURIComponent(fixtureMailbox)}/mailboxSettings`;
  const id = { Identity: fixtureMailbox };
  return [
    { step: 0, credential: 'none', refused: `${EXCHANGE_REFUSAL_PROBE.cmdlet} -${EXCHANGE_REFUSAL_PROBE.parameter} (held field; refused before sending)` },
    { step: 0, credential: 'none', refused: `GET /v1.0/users/${encodeURIComponent(fixtureMailbox)}/messages (content; refused before sending)` },
    { step: 1, credential: 'collector', method: 'GET', path: settings, operationId: 'exchange.mailbox-settings' },
    { step: 1, credential: 'collector', cmdlet: 'Get-OrganizationConfig', parameters: {}, operationId: 'exchange.organization-config' },
    { step: 1, credential: 'collector', cmdlet: 'Get-Mailbox', parameters: id, operationId: 'exchange.mailbox-hold' },
    { step: 1, credential: 'collector', cmdlet: 'Get-CASMailbox', parameters: id, operationId: 'exchange.client-access' },
    { step: 2, credential: 'collector', cmdlet: 'Get-Mailbox', parameters: { Identity: `${EXCHANGE_FIXTURE_PREFIX}absent-<random>@<fixture domain>` }, expect: 'a structured platform error' },
    { step: 3, credential: 'restorer', method: 'GET', path: settings, operationId: EXCHANGE_LIVE_SETTINGS_WRITE },
    { step: 3, credential: 'restorer', method: 'PATCH', path: `${settings} { ${EXCHANGE_SETTINGS_TOGGLE}: <the other of ${EXCHANGE_TIME_ZONES.join(' / ')}> }`, operationId: EXCHANGE_LIVE_SETTINGS_WRITE },
    { step: 3, credential: 'restorer', method: 'GET', path: `${settings} (read back)`, operationId: EXCHANGE_LIVE_SETTINGS_WRITE },
    { step: 3, credential: 'restorer', method: 'PATCH', path: `${settings} { ${EXCHANGE_SETTINGS_TOGGLE}: <original> }`, operationId: EXCHANGE_LIVE_SETTINGS_WRITE },
    { step: 3, credential: 'restorer', method: 'GET', path: `${settings} (read back)`, operationId: EXCHANGE_LIVE_SETTINGS_WRITE },
    { step: 4, credential: 'restorer', cmdlet: 'Get-CASMailbox', parameters: id, operationId: EXCHANGE_LIVE_CAS_WRITE },
    { step: 4, credential: 'restorer', cmdlet: 'Set-CASMailbox', parameters: { ...id, [EXCHANGE_CAS_TOGGLE]: '<the other value>' }, operationId: EXCHANGE_LIVE_CAS_WRITE },
    { step: 4, credential: 'restorer', cmdlet: 'Get-CASMailbox', parameters: id, operationId: EXCHANGE_LIVE_CAS_WRITE, note: 'read back' },
    { step: 4, credential: 'restorer', cmdlet: 'Set-CASMailbox', parameters: { ...id, [EXCHANGE_CAS_TOGGLE]: '<original>' }, operationId: EXCHANGE_LIVE_CAS_WRITE },
    { step: 4, credential: 'restorer', cmdlet: 'Get-CASMailbox', parameters: id, operationId: EXCHANGE_LIVE_CAS_WRITE, note: 'read back' },
    { step: 5, credential: 'restorer', cmdlet: 'Get-Mailbox', parameters: id, operationId: EXCHANGE_LIVE_RETENTION_WRITE },
    { step: 5, credential: 'restorer', cmdlet: 'Set-Mailbox', parameters: { ...id, [EXCHANGE_RETENTION_PROPERTY]: '<current + 1 day, at most 30.00:00:00>' }, operationId: EXCHANGE_LIVE_RETENTION_WRITE, note: 'extend only; never put back' },
    { step: 5, credential: 'restorer', cmdlet: 'Get-Mailbox', parameters: id, operationId: EXCHANGE_LIVE_RETENTION_WRITE, note: 'read back' },
  ];
}

async function exchangeReadUntil(readOnce, matches, { sleep, attempts, delayMs }) {
  let body = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt) await sleep(delayMs);
    body = await readOnce();
    if (matches(body)) return { body, matched: true };
  }
  return { body, matched: false };
}

/** Sends one Graph write; a throttled (429/503) write was not applied and is resent after Retry-After. */
async function exchangeSendGraphWrite(transport, url, init, sleep) {
  for (let attempt = 1; ; attempt += 1) {
    const response = await transport(url, init);
    if ((response.status !== 429 && response.status !== 503) || attempt >= WRITE_THROTTLE_MAX_ATTEMPTS) return response;
    const seconds = Number(response.headers?.['retry-after']);
    await sleep(Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 2 ** attempt * 1000);
  }
}

/** The one object a cmdlet answered for one identity, or an error naming why not. */
function exchangeSingle(cmdlet, output) {
  if (output.length !== 1) throw new Error(`${cmdlet}: ${output.length} objects answered; exactly one is expected`);
  return output[0];
}

const pick = (body, fields) => Object.fromEntries(fields.map((field) => [field, body?.[field] ?? null]));
const present = (body, fields) => (body && typeof body === 'object' ? fields.filter((field) => Object.hasOwn(body, field)) : []);

/**
 * Runs a capture. `collector` and `restorer` are each `{ transport, powershell }`:
 * a Graph transport `(url, init?) => { status, headers, body }` and the runCmdlet
 * options for that identity's tenant config. Returns the unsigned record and the
 * raw capture log; it never signs and never writes files.
 */
export async function captureExchangeAcceptance({
  collector, restorer, directoryTenantId, fixtureMailbox, probeIdentity = null, tenantRef, build, credentials, grants, moduleVersion,
  teamsQualification, documentation = [], now = () => new Date(), sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
  readBackAttempts = 5, readBackDelayMs = 2000,
}) {
  const problems = exchangeFixtureProblems({ fixtureMailbox });
  if (typeof directoryTenantId !== 'string' || !GUID_RE.test(directoryTenantId)) problems.push('--directory-tenant-id must be the managed tenant id (a GUID)');
  if (typeof moduleVersion !== 'string' || !MODULE_VERSION_RE.test(moduleVersion)) problems.push(`--exchange-module-version must be the ${EXCHANGE_MODULE} version in the container (x.y.z)`);
  if (problems.length) throw new Error(problems.join('; '));
  if (!tenantRef || !build) throw new Error('a capture needs --tenant-ref and a build');
  if (!credentials?.collector || !credentials?.restorer || credentials.collector === credentials.restorer) {
    throw new Error('a capture needs two separate credential references (collector, restorer)');
  }
  if (teamsQualification?.gate !== TEAMS_LIVE_GATE || !teamsQualification.captureLogSha256) {
    throw new Error('a capture needs the verified task-121 Teams record: Exchange is qualified only after Teams');
  }
  const tenant = directoryTenantId.toLowerCase();
  const identity = fixtureMailbox;
  const probe = probeIdentity ?? exchangeProbeIdentity(identity);
  if (!exchangeIsFixtureIdentity(probe) || probe.toLowerCase() === identity.toLowerCase()) throw new Error('the platform-error probe must be another keel-rt-* identity');

  const requests = [];
  const log = { requests, values: {} };
  let retryAfterResponses = 0;
  const graphAs = (credential, transport) => async (url, init) => {
    const method = init?.method ?? 'GET';
    assertExchangeRequest(url, method);
    const parsed = new URL(url);
    const [, version, ...rest] = parsed.pathname.split('/');
    const response = await transport(url, init);
    if (response.status === 429 || response.status === 503) retryAfterResponses += 1;
    requests.push({ credential, transport: 'graph', method, version, path: `/${rest.join('/')}${parsed.search}`, status: response.status, at: now().toISOString() });
    return response;
  };
  // Cmdlets: the allowlist is checked before the job is written; a refused call is never sent or logged.
  const cmdletAs = (credential, powershell) => async (cmdlet, parameters = {}) => {
    assertExchangeCmdlet({ cmdlet, parameters });
    const entry = { credential, transport: EXCHANGE_TRANSPORT, cmdlet, parameters: { ...parameters }, outcome: 'ok', at: now().toISOString() };
    try {
      const { output } = await exchangeCmdlet({ cmdlet, parameters }, powershell);
      requests.push(entry);
      return output;
    } catch (error) {
      const failed = structuredFailure(error);
      requests.push({ ...entry, outcome: failed.status, error: { code: failed.error.code, errorId: failed.error.errorId ?? null } });
      throw error;
    }
  };
  const collect = { graph: graphAs('collector', collector.transport), cmdlet: cmdletAs('collector', collector.powershell ?? {}) };
  const restore = { graph: graphAs('restorer', restorer.transport), cmdlet: cmdletAs('restorer', restorer.powershell ?? {}) };

  // 0. Offline refusals: a held field and a content path never leave this process.
  const sentBefore = requests.length;
  const refusals = { heldField: { ...EXCHANGE_REFUSAL_PROBE, refused: false, sent: false }, contentPath: { path: '/users/{fixture}/messages', refused: false, sent: false } };
  try {
    await restore.cmdlet(EXCHANGE_REFUSAL_PROBE.cmdlet, { Identity: identity, [EXCHANGE_REFUSAL_PROBE.parameter]: 'Unlimited' });
  } catch (error) {
    refusals.heldField.refused = true;
    refusals.heldField.reason = error.message;
  }
  try {
    await collect.graph(`${GRAPH}/${VERSION}/users/${encodeURIComponent(identity)}/messages`);
  } catch (error) {
    refusals.contentPath.refused = true;
    refusals.contentPath.reason = error.message;
  }
  refusals.heldField.sent = requests.length !== sentBefore;
  refusals.contentPath.sent = requests.length !== sentBefore;

  // 1. Reads, by the collector.
  const reads = [];
  const supportedFields = {};
  const readCapture = async (id, run) => {
    const capture = { operationId: id, version: exchangeOperationVersion(id, moduleVersion), capturedAt: null, ok: false, synthetic: false };
    try {
      const body = await run();
      capture.ok = true;
      return body;
    } catch (error) {
      capture.error = error.message;
      return null;
    } finally {
      capture.capturedAt = now().toISOString();
      reads.push(capture);
    }
  };
  const readSettings = async (graph) => {
    const { items: [body = null] } = await readGraphConfiguration(exchangeReadDescriptor('exchange.mailbox-settings'), {
      transport: graph, sleep, substitute: { 'user-id': identity },
    });
    return body;
  };
  const settingsBody = await readCapture('exchange.mailbox-settings', () => readSettings(collect.graph));
  supportedFields.mailboxSettings = present(settingsBody, MAILBOX_SETTING_FIELDS);
  const organizationBody = await readCapture('exchange.organization-config', async () => exchangeSingle('Get-OrganizationConfig', await collect.cmdlet('Get-OrganizationConfig')));
  supportedFields.organization = present(organizationBody, ORGANIZATION_FIELDS);
  const mailboxBody = await readCapture('exchange.mailbox-hold', async () => exchangeSingle('Get-Mailbox', await collect.cmdlet('Get-Mailbox', { Identity: identity })));
  supportedFields.retention = present(mailboxBody, RETENTION_FIELDS);
  const casBody = await readCapture('exchange.client-access', async () => exchangeSingle('Get-CASMailbox', await collect.cmdlet('Get-CASMailbox', { Identity: identity })));
  supportedFields.clientAccess = present(casBody, CLIENT_ACCESS_FIELDS);

  const organization = { externalDirectoryOrganizationId: organizationBody?.ExternalDirectoryOrganizationId ?? null };
  const mailboxFacts = pick(mailboxBody, MAILBOX_IDENTITY_FIELDS);
  const fixture = {
    identity, userPrincipalName: mailboxFacts.UserPrincipalName, objectId: mailboxFacts.ExternalDirectoryObjectId,
    recipientTypeDetails: mailboxFacts.RecipientTypeDetails,
  };

  // 2. A platform error, as it comes back: the absent probe identity.
  const platformError = { identity: probe, status: 'ok', error: null };
  try {
    await collect.cmdlet('Get-Mailbox', { Identity: probe });
  } catch (error) {
    const failed = structuredFailure(error);
    platformError.status = failed.status;
    platformError.error = { code: failed.error.code, errorId: failed.error.errorId ?? null, category: failed.error.category ?? null, message: failed.error.message ?? null };
  }

  let refusal = null;
  if (!reads.every((item) => item.ok)) refusal = 'a read failed; nothing was written';
  else if (String(organization.externalDirectoryOrganizationId ?? '').toLowerCase() !== tenant) refusal = 'the Exchange organization belongs to another tenant (or did not report its tenant id); nothing was written';
  else if (String(fixture.userPrincipalName ?? '').toLowerCase() !== identity.toLowerCase()) refusal = 'the fixture mailbox did not answer as the identity named; nothing was written';
  else if (fixture.recipientTypeDetails !== 'UserMailbox') refusal = 'the fixture is not a user mailbox; nothing was written';
  else if (platformError.status === 'ok') refusal = 'the platform-error probe identity exists; it must not; nothing was written';

  const timing = { sleep, attempts: readBackAttempts, delayMs: readBackDelayMs };
  const writes = {
    mailboxSettings: { operationId: EXCHANGE_LIVE_SETTINGS_WRITE, version: exchangeOperationVersion(EXCHANGE_LIVE_SETTINGS_WRITE, moduleVersion), synthetic: false, writeMode: 'reversible-change', property: EXCHANGE_SETTINGS_TOGGLE, ok: false, readBackVerified: false, restoredToOriginal: false, preFingerprint: null, finalFingerprint: null },
    clientAccess: { operationId: EXCHANGE_LIVE_CAS_WRITE, version: exchangeOperationVersion(EXCHANGE_LIVE_CAS_WRITE, moduleVersion), synthetic: false, writeMode: 'reversible-change', property: EXCHANGE_CAS_TOGGLE, ok: false, readBackVerified: false, restoredToOriginal: false, preFingerprint: null, finalFingerprint: null },
    retention: { operationId: EXCHANGE_LIVE_RETENTION_WRITE, version: exchangeOperationVersion(EXCHANGE_LIVE_RETENTION_WRITE, moduleVersion), synthetic: false, writeMode: 'extend-only', property: EXCHANGE_RETENTION_PROPERTY, ok: false, readBackVerified: false, before: null, after: null, complianceHoldsFingerprint: null, finalComplianceHoldsFingerprint: null },
  };
  if (refusal) {
    for (const capture of Object.values(writes)) { capture.error = refusal; capture.capturedAt = now().toISOString(); }
  } else {
    await exchangeSettingsRoundTrip({ graph: restore.graph, identity, capture: writes.mailboxSettings, log, timing, readSettings });
    writes.mailboxSettings.capturedAt = now().toISOString();
    await exchangeClientAccessRoundTrip({ cmdlet: restore.cmdlet, identity, capture: writes.clientAccess, log, timing });
    writes.clientAccess.capturedAt = now().toISOString();
    await exchangeRetentionExtend({ cmdlet: restore.cmdlet, identity, capture: writes.retention, log, timing });
    writes.retention.capturedAt = now().toISOString();
  }

  const captureLog = `${JSON.stringify(log, null, 2)}\n`;
  const record = {
    contractVersion: QUALIFICATION_CONTRACT_VERSION,
    gate: EXCHANGE_LIVE_GATE,
    tenantRef,
    build,
    operation: EXCHANGE_LIVE_OPERATION,
    credentialMode: EXCHANGE_LIVE_CREDENTIAL_MODE,
    observedAt: now().toISOString(),
    evidenceLevel: 'live-qualified',
    synthetic: false,
    subject: {
      prerequisites: [...EXCHANGE_LIVE_PREREQUISITES],
      teamsQualification: { gate: TEAMS_LIVE_GATE, evidence: teamsQualification.evidence, captureLogSha256: teamsQualification.captureLogSha256 },
      directoryTenantId: tenant,
      organization,
      fixtureMailbox: fixture,
      execution: { transport: EXCHANGE_TRANSPORT, module: EXCHANGE_MODULE, moduleVersion },
      credentials: { collector: credentials.collector, restorer: credentials.restorer },
      grants,
      reads,
      supportedFields,
      writes,
      refusals,
      platformError,
      requests: requests.map(({ at, ...request }) => request),
      throttle: { retryAfterResponses },
      documentation,
      captureLogSha256: sha256Hex(captureLog),
    },
  };
  const needsManualRevert = (log.values.settingsWritten === true && writes.mailboxSettings.restoredToOriginal !== true)
    || (log.values.clientAccessWritten === true && writes.clientAccess.restoredToOriginal !== true);
  return { record, captureLog, needsManualRevert };
}

async function exchangeSettingsRoundTrip({ graph, identity, capture, log, timing, readSettings }) {
  const url = `${GRAPH}/${VERSION}/users/${encodeURIComponent(identity)}/mailboxSettings`;
  const read = () => readSettings(graph);
  try {
    const before = await read();
    capture.preFingerprint = exchangeGroupFingerprint(before, MAILBOX_SETTING_FIELDS);
    const original = before?.[EXCHANGE_SETTINGS_TOGGLE];
    log.values.originalTimeZone = original ?? null;
    if (typeof original !== 'string' || !original) { capture.error = `${EXCHANGE_SETTINGS_TOGGLE} was not read; nothing was written`; return; }
    const target = EXCHANGE_TIME_ZONES.find((zone) => zone !== original);
    const changed = await exchangeSendGraphWrite(graph, url, { method: 'PATCH', body: { [EXCHANGE_SETTINGS_TOGGLE]: target } }, timing.sleep);
    if (!ok(changed)) { capture.error = `the write failed (HTTP ${changed.status})`; return; }
    log.values.settingsWritten = true;
    const seen = await exchangeReadUntil(read, (body) => body?.[EXCHANGE_SETTINGS_TOGGLE] === target, timing);
    capture.readBackVerified = seen.matched;
    // Always put the setting back once a write was accepted, whatever the read-back said.
    const reverted = await exchangeSendGraphWrite(graph, url, { method: 'PATCH', body: { [EXCHANGE_SETTINGS_TOGGLE]: original } }, timing.sleep);
    const restored = ok(reverted)
      ? await exchangeReadUntil(read, (body) => body?.[EXCHANGE_SETTINGS_TOGGLE] === original, timing)
      : { body: await read(), matched: false };
    capture.restoredToOriginal = ok(reverted) && restored.matched;
    capture.finalFingerprint = exchangeGroupFingerprint(restored.body, MAILBOX_SETTING_FIELDS);
    capture.ok = ok(reverted);
    if (!ok(reverted)) capture.error = `PUTTING THE SETTING BACK FAILED (HTTP ${reverted.status}): set ${EXCHANGE_SETTINGS_TOGGLE} to ${original} on ${identity} by hand`;
  } catch (error) {
    capture.error = error.message;
  }
}

async function exchangeClientAccessRoundTrip({ cmdlet, identity, capture, log, timing }) {
  const read = async () => exchangeSingle('Get-CASMailbox', await cmdlet('Get-CASMailbox', { Identity: identity }));
  try {
    const before = await read();
    capture.preFingerprint = exchangeGroupFingerprint(before, CLIENT_ACCESS_FIELDS);
    const original = before?.[EXCHANGE_CAS_TOGGLE];
    log.values.originalClientAccess = original ?? null;
    if (typeof original !== 'boolean') { capture.error = `${EXCHANGE_CAS_TOGGLE} is not a boolean; nothing was written`; return; }
    try {
      await cmdlet('Set-CASMailbox', { Identity: identity, [EXCHANGE_CAS_TOGGLE]: !original });
    } catch (error) {
      // A cmdlet error is a definite answer; anything else may have applied.
      if (error?.detail?.code === 'CMDLET_ERROR') { capture.error = `Set-CASMailbox failed: ${error.message}`; return; }
      log.values.clientAccessWritten = true;
      throw error;
    }
    log.values.clientAccessWritten = true;
    const seen = await exchangeReadUntil(read, (body) => body?.[EXCHANGE_CAS_TOGGLE] === !original, timing);
    capture.readBackVerified = seen.matched;
    let revertError = null;
    try {
      await cmdlet('Set-CASMailbox', { Identity: identity, [EXCHANGE_CAS_TOGGLE]: original });
    } catch (error) {
      revertError = error;
    }
    const restored = await exchangeReadUntil(read, (body) => body?.[EXCHANGE_CAS_TOGGLE] === original, timing);
    capture.restoredToOriginal = restored.matched;
    capture.finalFingerprint = exchangeGroupFingerprint(restored.body, CLIENT_ACCESS_FIELDS);
    capture.ok = revertError === null;
    if (!restored.matched) capture.error = `PUTTING THE SETTING BACK FAILED${revertError ? ` (${revertError.message})` : ''}: set ${EXCHANGE_CAS_TOGGLE} to ${original} on ${identity} by hand`;
  } catch (error) {
    capture.error ??= error.message;
    if (log.values.clientAccessWritten === true && capture.restoredToOriginal !== true) {
      capture.error = `THE ${EXCHANGE_CAS_TOGGLE} SWITCH MAY NOT BE BACK (${error.message}): check it on ${identity} by hand`;
    }
  }
}

async function exchangeRetentionExtend({ cmdlet, identity, capture, timing }) {
  const read = async () => exchangeSingle('Get-Mailbox', await cmdlet('Get-Mailbox', { Identity: identity }));
  try {
    const before = await read();
    capture.before = pick(before, [...EXCHANGE_HOLD_WRITE_FIELDS, EXCHANGE_RETENTION_PROPERTY]);
    capture.complianceHoldsFingerprint = exchangeGroupFingerprint(before, COMPLIANCE_HOLD_FIELDS);
    const from = exchangeDurationMs(before?.[EXCHANGE_RETENTION_PROPERTY]);
    if (from === null) { capture.error = `${EXCHANGE_RETENTION_PROPERTY} was not readable; nothing was written`; return; }
    if (from + ONE_DAY_MS > EXCHANGE_MAX_RETENTION_MS) {
      capture.error = `${EXCHANGE_RETENTION_PROPERTY} is already ${before[EXCHANGE_RETENTION_PROPERTY]}; it cannot be extended by a day, and a capture never shortens it; nothing was written`;
      return;
    }
    const target = exchangeDurationText(from + ONE_DAY_MS);
    await cmdlet('Set-Mailbox', { Identity: identity, [EXCHANGE_RETENTION_PROPERTY]: target });
    capture.ok = true;
    const seen = await exchangeReadUntil(read, (body) => exchangeDurationMs(body?.[EXCHANGE_RETENTION_PROPERTY]) === from + ONE_DAY_MS, timing);
    capture.readBackVerified = seen.matched;
    capture.after = pick(seen.body, [...EXCHANGE_HOLD_WRITE_FIELDS, EXCHANGE_RETENTION_PROPERTY]);
    capture.finalComplianceHoldsFingerprint = exchangeGroupFingerprint(seen.body, COMPLIANCE_HOLD_FIELDS);
  } catch (error) {
    capture.error = error.message;
  }
}

/**
 * Writes the record and its capture log side by side, binding the log's digest as
 * the artifact proof, and signs the record when a runner key is given.
 */
export function writeExchangeAcceptanceFiles({ record, captureLog, outPath, hmacKey = null }) {
  const logPath = outPath.replace(/\.json$/, '') + '.capture.json';
  writeFileSync(logPath, captureLog);
  let evidence = { ...record, proof: { artifact: { path: basename(logPath), sha256: sha256Hex(captureLog) } } };
  if (hmacKey) evidence = signEvidence(evidence, hmacKey, 'keel-release-runner');
  writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`);
  return { evidence, logPath };
}

/**
 * The import seam: a record that passes the gate with --require-live becomes
 * task-101 read evidence for the four Exchange reads, one live write capture per
 * qualified Exchange write (for workloadWriteQualification), the collector's and
 * the restorer's grants, and the module version the captures are bound to.
 * Anything else yields none. Teams and SharePoint evidence come only from their own seams.
 */
export function ledgerEvidenceFromExchangeAcceptance(evidence, options = {}) {
  const result = verifyEvidence(evidence, { ...options, gate: EXCHANGE_LIVE_GATE, requireLive: true });
  if (!result.ok) return { ok: false, failures: result.failures, reads: [], writes: [], grants: null, restorerGrants: null, runtime: null };
  const { subject, tenantRef } = evidence;
  const proofRef = `${EXCHANGE_LIVE_GATE}@${subject.captureLogSha256}`;
  const write = (item) => ({
    operationId: item.operationId, kind: 'live-write-capture', synthetic: false, tenantRef, capturedAt: item.capturedAt,
    version: item.version, ok: item.ok === true, readBackVerified: item.readBackVerified === true, proofRef,
  });
  return {
    ok: true,
    failures: [],
    reads: subject.reads.map((item) => ({
      operationId: item.operationId, kind: 'live-capture', synthetic: false, tenantRef, capturedAt: item.capturedAt,
      version: item.version, ok: item.ok === true, error: null, observed: {}, proofRef,
    })),
    writes: [subject.writes.mailboxSettings, subject.writes.clientAccess, subject.writes.retention].map(write),
    grants: { permissions: [...subject.grants.collector.permissions], roles: [...subject.grants.collector.roles] },
    restorerGrants: { permissions: [...subject.grants.restorer.permissions], roles: [...subject.grants.restorer.roles] },
    runtime: { modules: { [EXCHANGE_MODULE]: subject.execution.moduleVersion } },
  };
}

function parseExchangeArgs(argv) {
  const [command = 'plan', ...rest] = argv;
  const options = { command, confirm: false };
  const names = {
    '--tenant-ref': 'tenantRef', '--directory-tenant-id': 'directoryTenantId', '--fixture-mailbox': 'fixtureMailbox',
    '--collector-ref': 'collectorRef', '--restorer-ref': 'restorerRef', '--collector-config': 'collectorConfig', '--restorer-config': 'restorerConfig',
    '--exchange-module-version': 'moduleVersion', '--grants': 'grants', '--docs': 'docs', '--out': 'out', '--build': 'build',
    '--teams-evidence': 'teamsEvidence', '--powershell-image': 'image',
  };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === '--confirm-live-tenant-write') options.confirm = true;
    else if (names[arg]) options[names[arg]] = rest[++index];
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

const exchangePowershellFor = (tenantConfigPath, image) => ({ tenantConfigPath, ...(image ? { image } : {}) });

export async function main(argv = process.argv.slice(2), {
  out = console.log, env = process.env, transportFor = teamsBearerTransport, powershellFor = exchangePowershellFor,
  readFile = (path) => readFileSync(path, 'utf8'),
} = {}) {
  const options = parseExchangeArgs(argv);
  if (options.command === 'plan') {
    out(JSON.stringify(exchangeCapturePlan(options), null, 2));
    return 0;
  }
  if (options.command !== 'capture') throw new Error('usage: exchangeLive.mjs plan|capture ...');
  if (!options.confirm) {
    out(JSON.stringify(exchangeCapturePlan(options), null, 2));
    out('refused: a capture writes the fixture mailbox\'s settings, client access and retention; rerun with --confirm-live-tenant-write');
    return 2;
  }
  for (const [flag, key] of [
    ['--tenant-ref', 'tenantRef'], ['--directory-tenant-id', 'directoryTenantId'], ['--collector-ref', 'collectorRef'], ['--restorer-ref', 'restorerRef'],
    ['--collector-config', 'collectorConfig'], ['--restorer-config', 'restorerConfig'], ['--exchange-module-version', 'moduleVersion'],
    ['--grants', 'grants'], ['--docs', 'docs'], ['--teams-evidence', 'teamsEvidence'], ['--out', 'out'],
  ]) {
    if (!options[key]) throw new Error(`capture needs ${flag}`);
  }
  if (options.collectorConfig === options.restorerConfig) throw new Error('the collector and restorer must use separate tenant config files');
  if (!env.KEEL_EXCHANGE_COLLECTOR_TOKEN || !env.KEEL_EXCHANGE_RESTORER_TOKEN) {
    throw new Error('capture needs KEEL_EXCHANGE_COLLECTOR_TOKEN and KEEL_EXCHANGE_RESTORER_TOKEN in the environment');
  }
  const build = options.build ?? env.KEEL_QUALIFICATION_BUILD;
  if (!build) throw new Error('capture needs --build (or KEEL_QUALIFICATION_BUILD): the build this capture qualifies');
  const outPath = resolve(options.out);
  const teamsPath = resolve(options.teamsEvidence);
  if (dirname(teamsPath) !== dirname(outPath)) throw new Error('the Teams record must sit beside --out, where the verifier reads it');
  // Exchange follows Teams: refuse before any request unless the task-121 record verifies.
  const teams = JSON.parse(readFile(teamsPath));
  const teamsResult = verifyEvidence(teams, {
    gate: TEAMS_LIVE_GATE, tenantRef: options.tenantRef, build, requireLive: true, evidenceDir: dirname(teamsPath),
  });
  if (!teamsResult.ok) {
    out(JSON.stringify({ refused: 'the task-121 Teams record does not verify; Exchange is qualified only after Teams', failures: teamsResult.failures }, null, 2));
    return 2;
  }
  const { record, captureLog, needsManualRevert } = await captureExchangeAcceptance({
    collector: { transport: transportFor(env.KEEL_EXCHANGE_COLLECTOR_TOKEN), powershell: powershellFor(options.collectorConfig, options.image) },
    restorer: { transport: transportFor(env.KEEL_EXCHANGE_RESTORER_TOKEN), powershell: powershellFor(options.restorerConfig, options.image) },
    directoryTenantId: options.directoryTenantId,
    fixtureMailbox: options.fixtureMailbox,
    tenantRef: options.tenantRef,
    build,
    moduleVersion: options.moduleVersion,
    credentials: { collector: options.collectorRef, restorer: options.restorerRef },
    grants: JSON.parse(readFile(options.grants)),
    documentation: JSON.parse(readFile(options.docs)),
    teamsQualification: { gate: TEAMS_LIVE_GATE, evidence: basename(teamsPath), captureLogSha256: teams.subject.captureLogSha256 },
  });
  const { evidence, logPath } = writeExchangeAcceptanceFiles({ record, captureLog, outPath, hmacKey: env.KEEL_QUALIFICATION_HMAC_KEY ?? null });
  const result = verifyEvidence(evidence, { gate: EXCHANGE_LIVE_GATE, tenantRef: options.tenantRef, build, requireLive: true, evidenceDir: dirname(outPath) });
  out(JSON.stringify({ evidence: outPath, captureLog: logPath, writes: record.subject.writes, verify: result }, null, 2));
  // 3: the fixture mailbox may not be back where it started; the output says what to fix by hand.
  if (needsManualRevert) return 3;
  return result.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then((code) => { process.exitCode = code; }, (error) => { console.error(error.message); process.exitCode = 2; });
}
