/**
 * Deferred hybrid topology contract (roadmap task-111).
 *
 * KEEL manages one cloud tenant. A future on-premises adapter (for example an
 * Active Directory agent) would reach KEEL only by polling outbound; KEEL never
 * opens a connection into a customer network. This module fixes the versioned
 * message schema for that future conversation and the cloud-side refusal
 * rules, and nothing else:
 *
 *   THE HYBRID AGENT RUNTIME IS DEFERRED. There is no agent executable, no
 *   polling service, no on-premises connection and no persisted command
 *   ledger. HYBRID_RUNTIME says so, every validated command reads
 *   dispatchable: false, and hybridRuntimeInventory() proves that no shipped
 *   entrypoint (CLI, ops unit, package bin) loads this contract.
 *
 * Messages (schemaVersion 1):
 *   poll    adapter -> cloud. Adapter identity, tenant pin, capability evidence.
 *   command cloud -> adapter, carried in a poll response. Operation intents,
 *           each naming the object's source authority and execution site.
 *   result  adapter -> cloud. Outcome of one intent, with result provenance
 *           bound to the command's identity by an intent digest.
 *
 * Refusal rules, enforced by validateTopologyMessage():
 * 1. The message tenantRef must equal the pinned tenant, and so must every
 *    capability evidence record. Cross-tenant input is refused, never mapped.
 * 2. Only intents in HYBRID_INTENT_MATRIX are a supported topology. An object
 *    whose source of authority is on-premises or hybrid can never be the
 *    target of a cloud-side write (engine/safety/syncedObjectGuard.mjs decides
 *    the authority, so restore and topology share one rule).
 * 3. Command identity is single-use. A replayed messageId or commandId is
 *    refused, and a result qualifies only the one intent whose digest it
 *    carries, once. A result replayed against a new command cannot qualify it.
 * 4. Credentials never travel in a message: secret-named keys and
 *    credential-shaped strings are refused. Adapters name a credentialRef.
 * 5. Adapter capability evidence can never read above 'declared' while the
 *    runtime is deferred: nothing exists that could have qualified it.
 */

import { sha256Hex } from '../export/manifest.mjs';
import { CLAIM_LEVELS } from '../coverage/capabilities.mjs';
import { refuseIfSynced, sourceAuthorityOf, SOURCE_AUTHORITIES } from '../safety/syncedObjectGuard.mjs';
import { assertNoEmbeddedCredential } from '../storage/adapter.mjs';

export const HYBRID_TOPOLOGY_CONTRACT_VERSION = 1;

export const HYBRID_RUNTIME = Object.freeze({
  status: 'deferred',
  available: false,
  entrypoints: Object.freeze([]),
  explanation: 'The on-premises agent runtime is not built. KEEL validates the message contract and refuses '
    + 'every hybrid dispatch; it does not poll, connect to or execute anything on-premises.',
});

export const MESSAGE_KINDS = Object.freeze(['poll', 'command', 'result']);
export const ADAPTER_KINDS = Object.freeze(['active-directory']);
export const EXECUTION_SITES = Object.freeze(['on-premises', 'cloud']);
export const RESULT_OUTCOMES = Object.freeze(['succeeded', 'failed', 'refused', 'uncertain']);

// The only intents a future adapter could ever be asked to carry out. Each is
// on-premises execution against an on-premises-authoritative object. Cloud
// execution never appears: a cloud write is KEEL's own restore path, which
// refuses on-premises and hybrid authority.
export const HYBRID_INTENT_MATRIX = Object.freeze({
  'active-directory': Object.freeze([
    Object.freeze({ resourceType: 'user', operation: 'update', sourceAuthority: 'on-premises', executionSite: 'on-premises' }),
    Object.freeze({ resourceType: 'group', operation: 'update', sourceAuthority: 'on-premises', executionSite: 'on-premises' }),
  ]),
});

const COMMAND_MAX_LIFETIME_MS = 15 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const SECRET_KEY = /(secret|password|passwd|private.?key|token|credential(?!ref)|certificate|apikey|api_key)/i;

export class HybridRuntimeDeferredError extends Error {
  constructor() {
    super(HYBRID_RUNTIME.explanation);
    this.name = 'HybridRuntimeDeferredError';
  }
}

/** One in-memory ledger per validation context. Persisting it is runtime work and is deferred with it. */
export function createCommandLedger() {
  return { messageIds: new Set(), commands: new Map(), consumed: new Set() };
}

const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0;

function timestamp(value) {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isNaN(parsed) ? null : parsed;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Binds a result to exactly one (tenant, adapter, command, intent, object,
 * operation). Reusing a result under another command changes the digest.
 */
export function intentDigest({ tenantRef, adapterId, commandId, intent }) {
  return `sha256:${sha256Hex(canonical({
    contract: HYBRID_TOPOLOGY_CONTRACT_VERSION,
    tenantRef,
    adapterId,
    commandId,
    intentId: intent?.intentId,
    resourceType: intent?.resourceType,
    naturalKey: intent?.naturalKey,
    operation: intent?.operation,
    executionSite: intent?.executionSite,
  }))}`;
}

function secretProblems(value, path, out) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => secretProblems(item, `${path}[${index}]`, out));
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (SECRET_KEY.test(key)) out.push(`${path}.${key}: a message never carries credentials; name a credentialRef instead`);
      else secretProblems(child, `${path}.${key}`, out);
    }
  } else if (typeof value === 'string') {
    try {
      assertNoEmbeddedCredential(value, path);
    } catch {
      out.push(`${path}: a credential-shaped value is refused`);
    }
  }
}

function envelopeProblems(message, tenantRef) {
  const failures = [];
  if (!isNonEmptyString(tenantRef)) failures.push('validation requires the pinned tenantRef');
  if (message.schemaVersion !== HYBRID_TOPOLOGY_CONTRACT_VERSION) {
    failures.push(`unknown schemaVersion ${JSON.stringify(message.schemaVersion)}; only v${HYBRID_TOPOLOGY_CONTRACT_VERSION} is read`);
  }
  if (!MESSAGE_KINDS.includes(message.kind)) failures.push(`unknown message kind ${JSON.stringify(message.kind)}`);
  if (!isNonEmptyString(message.messageId)) failures.push('messageId is required');
  if (message.tenantRef !== tenantRef) {
    failures.push(`cross-tenant message refused: message is pinned to '${message.tenantRef}', required '${tenantRef}'`);
  }
  const adapter = message.adapter;
  if (!adapter || typeof adapter !== 'object') {
    failures.push('adapter identity is required');
  } else {
    if (!isNonEmptyString(adapter.adapterId)) failures.push('adapter.adapterId is required');
    if (!ADAPTER_KINDS.includes(adapter.adapterKind)) failures.push(`unsupported adapter kind ${JSON.stringify(adapter.adapterKind)}`);
    if (!isNonEmptyString(adapter.credentialRef)) failures.push('adapter.credentialRef is required (a reference, never the credential)');
  }
  if (timestamp(message.sentAt) === null) failures.push('sentAt is not a valid timestamp');
  secretProblems(message, 'message', failures);
  return failures;
}

function pollProblems(message, tenantRef) {
  const failures = [];
  const evidence = message.capabilityEvidence;
  if (!Array.isArray(evidence)) return ['poll.capabilityEvidence must be an array'];
  evidence.forEach((record, index) => {
    const at = `capabilityEvidence[${index}]`;
    if (record?.tenantRef !== tenantRef) failures.push(`${at}: cross-tenant evidence refused ('${record?.tenantRef}')`);
    if (!CLAIM_LEVELS.includes(record?.claim)) failures.push(`${at}: unknown claim ${JSON.stringify(record?.claim)}`);
    else if (record.claim !== 'declared' && !HYBRID_RUNTIME.available) {
      failures.push(`${at}: claim '${record.claim}' refused — the hybrid runtime is deferred, so adapter evidence reads 'declared' at most`);
    }
    if (!isNonEmptyString(record?.resourceType) || !isNonEmptyString(record?.operation)) {
      failures.push(`${at}: resourceType and operation are required`);
    }
  });
  return failures;
}

/** Why one intent is not a supported topology, or [] when it is. */
export function intentProblems(adapterKind, intent) {
  const failures = [];
  const at = `intent ${intent?.intentId ?? '?'}`;
  if (!isNonEmptyString(intent?.intentId)) failures.push('intent.intentId is required');
  if (!isNonEmptyString(intent?.naturalKey)) failures.push(`${at}: naturalKey is required`);
  if (!SOURCE_AUTHORITIES.includes(intent?.sourceAuthority)) {
    failures.push(`${at}: unknown source authority ${JSON.stringify(intent?.sourceAuthority)}`);
  }
  if (!EXECUTION_SITES.includes(intent?.executionSite)) {
    failures.push(`${at}: unknown execution site ${JSON.stringify(intent?.executionSite)}`);
  }
  if (intent?.executionSite === 'cloud') {
    const guard = refuseIfSynced({ sourceAuthority: intent.sourceAuthority, payload: intent.observed ?? {} });
    if (guard.refused) failures.push(`${at}: ${guard.reason}`);
  }
  // The intent's own observation decides authority too: an object observed as
  // synced cannot be declared cloud-authoritative by the message.
  if (intent?.observed && sourceAuthorityOf({ payload: intent.observed }) === 'on-premises' && intent.sourceAuthority !== 'on-premises') {
    failures.push(`${at}: the observed object is synced from on-premises, but the intent declares '${intent.sourceAuthority}'`);
  }
  const supported = (HYBRID_INTENT_MATRIX[adapterKind] ?? []).some((entry) => entry.resourceType === intent?.resourceType
    && entry.operation === intent?.operation
    && entry.sourceAuthority === intent?.sourceAuthority
    && entry.executionSite === intent?.executionSite);
  if (!supported) {
    failures.push(`${at}: unsupported topology intent ${intent?.resourceType}/${intent?.operation} `
      + `(${intent?.sourceAuthority} authority, ${intent?.executionSite} execution) for adapter kind ${adapterKind}`);
  }
  return failures;
}

function commandProblems(message, ledger) {
  const failures = [];
  if (!isNonEmptyString(message.commandId)) failures.push('command.commandId is required');
  else if (ledger.commands.has(message.commandId)) failures.push(`replayed command identity ${message.commandId} refused`);
  const issuedAt = timestamp(message.issuedAt);
  const expiresAt = timestamp(message.expiresAt);
  if (issuedAt === null || expiresAt === null) failures.push('command.issuedAt and command.expiresAt are required timestamps');
  else if (expiresAt <= issuedAt || expiresAt - issuedAt > COMMAND_MAX_LIFETIME_MS) {
    failures.push('command lifetime must be positive and at most 15 minutes');
  }
  if (!Array.isArray(message.intents) || message.intents.length === 0) {
    failures.push('command.intents must be a non-empty array');
    return failures;
  }
  const seen = new Set();
  for (const intent of message.intents) {
    if (seen.has(intent?.intentId)) failures.push(`duplicate intentId ${intent?.intentId}`);
    seen.add(intent?.intentId);
    failures.push(...intentProblems(message.adapter?.adapterKind, intent));
  }
  return failures;
}

function resultProblems(message, ledger, now) {
  const failures = [];
  const command = ledger.commands.get(message.commandId);
  if (!command) return [`result names command ${JSON.stringify(message.commandId)}, which this ledger never issued`];
  if (command.tenantRef !== message.tenantRef) failures.push('result tenant differs from the command tenant');
  if (command.adapterId !== message.adapter?.adapterId) failures.push('result adapter differs from the adapter the command was issued to');
  const intent = command.intents.find((candidate) => candidate.intentId === message.intentId);
  if (!intent) return [...failures, `result names intent ${JSON.stringify(message.intentId)}, which command ${message.commandId} does not carry`];
  if (ledger.consumed.has(`${message.commandId}\u0000${message.intentId}`)) {
    failures.push(`intent ${message.intentId} of command ${message.commandId} already has a result; a replay cannot qualify it again`);
  }
  if (!RESULT_OUTCOMES.includes(message.outcome)) failures.push(`unknown outcome ${JSON.stringify(message.outcome)}`);
  const provenance = message.provenance;
  if (!provenance || typeof provenance !== 'object') return [...failures, 'result.provenance is required'];
  const expected = intentDigest({ tenantRef: command.tenantRef, adapterId: command.adapterId, commandId: command.commandId, intent });
  if (provenance.intentDigest !== expected) failures.push('result provenance digest does not bind this command and intent');
  if (!isNonEmptyString(provenance.adapterBuild)) failures.push('result provenance is missing adapterBuild');
  if (provenance.synthetic !== false) failures.push('a synthetic result is never accepted as an outcome');
  const observedAt = timestamp(provenance.observedAt);
  if (observedAt === null) failures.push('result provenance observedAt is not a valid timestamp');
  else {
    if (observedAt < command.issuedAt) failures.push('result was observed before its command was issued');
    if (observedAt > command.expiresAt) failures.push('result was observed after its command expired');
    if (observedAt > now.getTime() + CLOCK_SKEW_MS) failures.push('result observedAt is in the future');
  }
  return failures;
}

/**
 * Validates one topology message against the pinned tenant and a command
 * ledger. A valid command is recorded in the ledger (so its identity cannot be
 * reused) and a valid result consumes its intent. Neither ever makes anything
 * dispatchable while HYBRID_RUNTIME is deferred.
 */
export function validateTopologyMessage(message, { tenantRef, ledger = createCommandLedger(), now = new Date() } = {}) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return { ok: false, kind: null, failures: ['message must be an object'], dispatchable: false, runtime: HYBRID_RUNTIME.status };
  }
  const failures = envelopeProblems(message, tenantRef);
  if (isNonEmptyString(message.messageId) && ledger.messageIds.has(message.messageId)) {
    failures.push(`replayed messageId ${message.messageId} refused`);
  }
  if (failures.length === 0) {
    if (message.kind === 'poll') failures.push(...pollProblems(message, tenantRef));
    if (message.kind === 'command') failures.push(...commandProblems(message, ledger));
    if (message.kind === 'result') failures.push(...resultProblems(message, ledger, now));
  }
  const ok = failures.length === 0;
  const verdict = { ok, kind: message.kind ?? null, failures, dispatchable: false, runtime: HYBRID_RUNTIME.status };
  if (!ok) return verdict;

  ledger.messageIds.add(message.messageId);
  if (message.kind === 'command') {
    ledger.commands.set(message.commandId, Object.freeze({
      commandId: message.commandId,
      tenantRef: message.tenantRef,
      adapterId: message.adapter.adapterId,
      issuedAt: timestamp(message.issuedAt),
      expiresAt: timestamp(message.expiresAt),
      intents: Object.freeze(message.intents.map((intent) => Object.freeze({ ...intent }))),
    }));
    verdict.dispatchable = HYBRID_RUNTIME.available;
    if (!verdict.dispatchable) verdict.refusal = 'hybrid-runtime-deferred';
  }
  if (message.kind === 'result') {
    ledger.consumed.add(`${message.commandId}\u0000${message.intentId}`);
    verdict.qualifies = Object.freeze({ commandId: message.commandId, intentId: message.intentId, outcome: message.outcome });
  }
  return verdict;
}

/** The cloud-side dispatch gate. Always refuses until the runtime exists. */
export function dispatchHybridCommand() {
  if (!HYBRID_RUNTIME.available) throw new HybridRuntimeDeferredError();
  throw new Error('hybrid dispatch is declared available but no runtime entrypoint exists');
}

// --- Artifact inventory -----------------------------------------------------
// A runtime entrypoint is any shipped executable surface: a cli/*.mjs file, an
// ops/ systemd unit's ExecStart target, or a package.json "bin". It counts as
// a hybrid runtime entrypoint when its name says agent/poll/hybrid/on-prem, or
// when its source loads this contract. The scan reads the real tree.

const RUNTIME_NAME = /(agent|poll|hybrid|on-?prem|topology)/i;
const LOADS_CONTRACT = /contracts\/topology\.mjs/;

/**
 * Lists every hybrid runtime entrypoint in the repository tree at `root`.
 * `fs` is node:fs (injected so the scan is testable on a synthetic tree).
 */
export function hybridRuntimeInventory({ root, fs, path }) {
  const found = [];
  const read = (file) => {
    try { return fs.readFileSync(path.join(root, file), 'utf8'); } catch { return null; }
  };
  const list = (dir) => {
    try { return fs.readdirSync(path.join(root, dir)); } catch { return []; }
  };
  const consider = (file, via) => {
    const source = read(file);
    if (RUNTIME_NAME.test(path.basename(file)) || (source !== null && LOADS_CONTRACT.test(source))) {
      found.push({ entrypoint: file, via });
    }
  };

  for (const name of list('cli')) {
    if (name.endsWith('.mjs') && !name.endsWith('.test.mjs')) consider(path.join('cli', name), 'cli');
  }
  for (const name of list('ops')) {
    if (!/\.(service|timer)$/.test(name)) continue;
    const unit = read(path.join('ops', name)) ?? '';
    if (RUNTIME_NAME.test(name)) found.push({ entrypoint: path.join('ops', name), via: 'systemd' });
    for (const match of unit.matchAll(/^ExecStart=.*?(\S+\.(?:mjs|js|sh))/gm)) {
      const target = match[1].replace(/^\/opt\/keel(?:-live)?\//, '');
      if (RUNTIME_NAME.test(path.basename(target)) || LOADS_CONTRACT.test(read(target) ?? '')) {
        found.push({ entrypoint: target, via: `systemd:${name}` });
      }
    }
  }
  for (const pkg of ['package.json', 'engine/package.json', 'portal/package.json']) {
    let bin;
    try { bin = JSON.parse(read(pkg) ?? '{}').bin; } catch { bin = null; }
    const targets = typeof bin === 'string' ? [bin] : Object.values(bin ?? {});
    for (const target of targets) consider(path.join(path.dirname(pkg), target), `bin:${pkg}`);
  }
  return found.sort((a, b) => a.entrypoint.localeCompare(b.entrypoint));
}

/**
 * The declared runtime status must agree with the shipped artifacts: deferred
 * means no entrypoint exists, and "available" can only be true when the
 * declared entrypoints are exactly the ones found.
 */
export function runtimeDeclarationProblems(inventory, runtime = HYBRID_RUNTIME) {
  const found = inventory.map((entry) => entry.entrypoint);
  if (!runtime.available) {
    return found.length === 0 ? [] : found.map((file) => `${file} is a hybrid runtime entrypoint but the runtime is declared deferred`);
  }
  if (runtime.entrypoints.length === 0) return ['hybrid runtime is declared available but names no entrypoint'];
  const missing = runtime.entrypoints.filter((file) => !found.includes(file));
  return missing.map((file) => `declared hybrid runtime entrypoint ${file} does not exist in the artifact inventory`);
}
