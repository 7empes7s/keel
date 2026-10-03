// engine/notify/adapters.mjs
//
// Roadmap task-84: provider adapters for Microsoft Teams and Slack incoming webhooks,
// the PagerDuty Events API v2 and SMS (Twilio only), behind the task-20 delivery model.
//
// Each provider module in ./channels/ is a pure contract:
//   validateConfig(config)                  -> problems found in the stored channel config
//   prepare({ config, event, delivery, secret }) -> the request, or an `unconfigured` reason
//   interpret({ status, headers, body })    -> outcome + provider receipt
// This file owns everything the providers share, so the rules hold for all of them:
//
//  - Secrets are credential references (env:NAME by default). A webhook address is a
//    secret (its path is the credential), so Teams and Slack store `endpointRef`, never
//    the URL. Raw secret-shaped values are refused when the channel is created.
//  - Every resolved secret value is redacted from anything that is recorded: the
//    delivery's last_error, its provider_receipt and the notify job's error.
//  - Outcomes are explicit: delivered, retry (throttled, provider down, network), rejected
//    (the provider refused this request; resending identical bytes will not help) and
//    unconfigured (missing credential, unsupported endpoint or provider: nothing is sent).
//  - Retry-After is normalized to milliseconds (delta-seconds or HTTP date) and capped.
//  - Payloads are capped per provider before they are sent.
import { isCredentialReference } from './channels/common.mjs';
import * as teams from './channels/teams.mjs';
import * as slack from './channels/slack.mjs';
import * as pagerduty from './channels/pagerduty.mjs';
import * as sms from './channels/sms.mjs';

export const ADAPTER_OUTCOMES = Object.freeze(['delivered', 'retry', 'rejected', 'unconfigured']);
export const ADAPTER_TIMEOUT_MS = 10 * 1000;
export const MAX_RETRY_AFTER_MS = 60 * 60 * 1000;
const RESPONSE_BODY_LIMIT = 2048;
const REDACTED = '[redacted]';

export { boundedKey, capText, eventSummary, isCredentialReference } from './channels/common.mjs';

export const CHANNEL_ADAPTERS = Object.freeze({ teams, slack, pagerduty, sms });
export const ADAPTER_KINDS = Object.freeze(Object.keys(CHANNEL_ADAPTERS));

export class ChannelConfigError extends Error {
  constructor(message) { super(message); this.name = 'ChannelConfigError'; }
}

/** A send that did not end in `delivered`. `receipt` is already redacted. */
export class NotificationSendError extends Error {
  constructor({ outcome, detail, retryAfterMs = null, receipt = null }) {
    super(detail);
    this.name = 'NotificationSendError';
    this.outcome = outcome;
    this.retryAfterMs = retryAfterMs;
    this.receipt = receipt;
  }
}

export function defaultResolveSecret(reference) {
  if (!isCredentialReference(reference)) throw new Error('not a credential reference');
  const value = process.env[reference.slice('env:'.length)];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Problems with a channel config for an adapter kind; empty when it is usable. */
export function channelConfigProblems(kind, config) {
  const adapter = CHANNEL_ADAPTERS[kind];
  if (!adapter) return [`${kind} is not a supported channel kind`];
  if (!config || typeof config !== 'object' || Array.isArray(config)) return ['config must be an object'];
  return adapter.validateConfig(config);
}

export function validateChannelConfig(kind, config) {
  const problems = channelConfigProblems(kind, config);
  if (problems.length) throw new ChannelConfigError(problems.join('; '));
  return config;
}

/**
 * Retry-After as milliseconds from `now`, capped at MAX_RETRY_AFTER_MS. Accepts
 * delta-seconds or an HTTP date; anything else (or absent) is null so the caller falls
 * back to its own backoff.
 */
export function parseRetryAfter(value, now = new Date()) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  let ms;
  if (/^\d+(\.\d+)?$/.test(text)) ms = Math.round(Number(text) * 1000);
  else {
    const at = Date.parse(text);
    if (Number.isNaN(at)) return null;
    ms = at - now.getTime();
  }
  return Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS);
}

export function redactSecrets(value, secrets) {
  const needles = [...new Set(secrets.filter((secret) => typeof secret === 'string' && secret.length >= 4))]
    .sort((a, b) => b.length - a.length);
  const scrub = (text) => needles.reduce((out, needle) => out.split(needle).join(REDACTED), text);
  if (typeof value === 'string') return scrub(value);
  if (value === null || value === undefined) return value;
  return JSON.parse(scrub(JSON.stringify(value)));
}




async function readBody(response) {
  try {
    const text = await response.text();
    return text.length > RESPONSE_BODY_LIMIT ? text.slice(0, RESPONSE_BODY_LIMIT) : text;
  } catch {
    return '';
  }
}

/**
 * The transport for one adapter kind, shaped like the task-20 transports:
 * `({ channel, event, delivery }) => { receipt }`, throwing NotificationSendError for
 * anything that was not delivered. `fetchImpl` and `resolveSecret` are injectable so
 * tests use fixtures and never reach a real provider.
 */
export function createAdapterTransport(kind, {
  fetchImpl = globalThis.fetch, resolveSecret = defaultResolveSecret, now = () => new Date(),
  timeoutMs = ADAPTER_TIMEOUT_MS,
} = {}) {
  const adapter = CHANNEL_ADAPTERS[kind];
  if (!adapter) throw new Error(`no adapter for channel kind: ${kind}`);
  return async function send({ channel, event, delivery }) {
    const base = { channel: kind, provider: adapter.PROVIDER, semantics: adapter.SEMANTICS };
    const problems = channelConfigProblems(kind, channel.config);
    if (problems.length) {
      throw new NotificationSendError({
        outcome: 'unconfigured',
        detail: `${adapter.LABEL} channel is not set up: ${problems.join('; ')}`,
        receipt: { ...base, outcome: 'unconfigured' },
      });
    }
    const secrets = [];
    const secret = async (reference) => {
      const value = await resolveSecret(reference);
      if (typeof value === 'string' && value) secrets.push(value);
      return value || null;
    };
    const prepared = await adapter.prepare({ config: channel.config, event, delivery, secret });
    if (prepared.unconfigured) {
      const detail = redactSecrets(`${adapter.LABEL} channel is not set up: ${prepared.unconfigured}`, secrets);
      throw new NotificationSendError({ outcome: 'unconfigured', detail, receipt: { ...base, outcome: 'unconfigured' } });
    }
    for (const value of prepared.secrets ?? []) secrets.push(value);
    const evidence = { ...base, endpointHost: prepared.endpointHost, ...(prepared.receipt ?? {}) };

    let response;
    try {
      response = await fetchImpl(prepared.url, { ...prepared.init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (cause) {
      // The request may or may not have reached the provider. Retrying is safe where
      // the provider dedups (PagerDuty's dedup_key); elsewhere it can duplicate a post.
      const detail = redactSecrets(`${adapter.LABEL} request did not complete: ${cause?.message ?? cause}`, secrets);
      throw new NotificationSendError({
        outcome: 'retry', detail, receipt: redactSecrets({ ...evidence, outcome: 'retry', httpStatus: null }, secrets),
      });
    }
    const body = await readBody(response);
    const verdict = adapter.interpret({ status: response.status, headers: response.headers, body });
    const retryAfterMs = verdict.outcome === 'retry'
      ? parseRetryAfter(response.headers?.get?.('retry-after'), now())
      : null;
    const receipt = redactSecrets({
      ...evidence,
      ...(verdict.receipt ?? {}),
      outcome: verdict.outcome,
      httpStatus: response.status,
      ...(retryAfterMs !== null ? { retryAfterMs } : {}),
    }, secrets);
    if (verdict.outcome === 'delivered') return { receipt };
    throw new NotificationSendError({
      outcome: verdict.outcome,
      detail: redactSecrets(`${adapter.LABEL} ${verdict.detail}`, secrets),
      retryAfterMs,
      receipt,
    });
  };
}

export function createAdapterTransports(options = {}) {
  return Object.fromEntries(ADAPTER_KINDS.map((kind) => [kind, createAdapterTransport(kind, options)]));
}
