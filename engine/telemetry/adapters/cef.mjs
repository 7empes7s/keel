// engine/telemetry/adapters/cef.mjs
//
// Roadmap task-81 (WS12): the bounded, escaped CEF (Common Event Format) sink for the
// task-79 SIEM outbox. One task-77 envelope becomes ONE single-line CEF record; the
// record carries the envelope's identity (event id, tenant, correlation, source
// sequence, payload digest) so the receiver can dedup on the stable event id under the
// at-least-once RECEIVER_DEDUP_CONTRACT.
//
// Non-negotiable rules:
//
// 1. INJECTION SAFETY. CEF header fields escape `\` and `|`; extension values escape
//    `\`, `=`, CR and LF; and the finished record is asserted single-line. Untrusted
//    event content can never smuggle a second CEF record or a forged key=value pair.
// 2. BOUNDED. The raw payload is never embedded — the extension carries its sha256
//    digest and byte size (the envelope is the source of truth in the outbox). A record
//    larger than maxBytes (default CEF_MAX_MESSAGE_BYTES) cannot be sent; that event is
//    poison for THIS sink and is quarantined with the reason, never truncated into a
//    misleading record.
// 3. ACKNOWLEDGEMENT HONESTY. The destination config DECLARES the transport's delivery
//    guarantee: acknowledgement: 'none' (e.g. UDP syslog) means a successful send says
//    nothing about remote acceptance, so the outcome is 'uncertain' — never
//    'accepted' — and the event is redelivered under its original id. Only
//    acknowledgement: 'http-response' over the https transport turns a 2xx into
//    'accepted'. A udp destination declaring http-response acknowledgement is a
//    contradiction and fails visibly instead of silently upgrading the guarantee.
// 4. PUBLIC ADDRESSES ONLY (security audit finding 6). The worker that sends these
//    records runs as root on the deploy host, so neither transport may reach loopback,
//    private, link-local (cloud metadata) or reserved addresses. https goes through the
//    shared guarded transport, which checks the address the socket connects to and every
//    redirect hop. For udp, the host is resolved once, every resolved address is
//    checked, and the datagram is sent to the checked address itself, so a name cannot
//    pass the check and then resolve somewhere else.
import { createHash } from 'node:crypto';
import dgram from 'node:dgram';
import { lookup as dnsLookup } from 'node:dns';
import { isIP } from 'node:net';

import {
  BlockedDestinationError, addressProblem, assertDestinationAllowed, guardedRequest,
} from '../../safety/outboundDestination.mjs';

import { canonicalJson } from '../events.mjs';

export const CEF_DESTINATION_KIND = 'cef';
export const CEF_MAX_MESSAGE_BYTES = 4096;
export const CEF_MIN_MESSAGE_BYTES = 256;
export const CEF_TIMEOUT_MS = 10 * 1000;
export const CEF_MAX_RETRY_AFTER_MS = 15 * 60 * 1000;
export const CEF_EVENT_ID_HEADER = 'x-keel-event-id';
export const CEF_DEDUP_KEY_HEADER = 'x-keel-dedup-key';

export const CEF_ACKNOWLEDGEMENT_MODES = Object.freeze(['none', 'http-response']);

export class CefMessageTooLargeError extends Error {
  constructor(bytes, maxBytes) {
    super(`cef record is ${bytes} bytes, exceeding the ${maxBytes}-byte bound`);
    this.name = 'CefMessageTooLargeError';
  }
}

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

// CEF header fields are pipe-delimited: `\` and `|` must be escaped, and CR/LF are
// escaped as well so a header field can never break the one-record-per-line framing.
export function escapeCefHeaderField(value) {
  return String(value)
    .replaceAll('\\', '\\\\')
    .replaceAll('|', '\\|')
    .replaceAll('\r', '\\r')
    .replaceAll('\n', '\\n');
}

// Extension values: `\` and `=` are structural (key=value pairs), and CR/LF are escaped
// so a value can never inject a second record.
export function escapeCefExtensionValue(value) {
  return String(value)
    .replaceAll('\\', '\\\\')
    .replaceAll('=', '\\=')
    .replaceAll('\r', '\\r')
    .replaceAll('\n', '\\n');
}

const SEVERITY_BY_NAME = Object.freeze({ critical: 10, warning: 6, notice: 3 });

// CEF severity is 0-10. A named severity in the (already redacted) payload wins;
// anything else maps to a neutral 5 rather than inventing urgency.
export function cefSeverity(envelope) {
  const named = envelope?.payload?.severity;
  if (typeof named === 'string' && named in SEVERITY_BY_NAME) {
    return SEVERITY_BY_NAME[named];
  }
  return 5;
}

/**
 * Format one envelope as one bounded single-line CEF record:
 *
 *   CEF:0|KEEL|keel|<envelopeVersion>|<eventType>|<eventType>|<severity>|<extension>
 *
 * The extension keys are stable and documented: rt (observed instant, epoch ms),
 * keelEventId / keelTenantRef / keelCorrelationId (the receiver's dedup identity),
 * keelCausationId, keelSourceComponent, keelSourceSequence (omitted when absent), and
 * keelPayloadSha256 / keelPayloadBytes (the payload by digest, never inline).
 */
export function formatCefEvent(envelope, { maxBytes = CEF_MAX_MESSAGE_BYTES } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < CEF_MIN_MESSAGE_BYTES) {
    throw new TypeError(`maxBytes must be an integer of at least ${CEF_MIN_MESSAGE_BYTES}`);
  }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new TypeError('cef formatting requires a task-77 event envelope');
  }
  const eventType = requireNonEmptyString(envelope.eventType, 'envelope.eventType');
  const observedMs = Date.parse(requireNonEmptyString(envelope.observedAt, 'envelope.observedAt'));
  if (Number.isNaN(observedMs)) throw new TypeError('envelope.observedAt must be a valid instant');

  const payloadCanonical = canonicalJson(envelope.payload ?? {});
  const extension = [
    ['rt', String(observedMs)],
    ['keelEventId', requireNonEmptyString(envelope.eventId, 'envelope.eventId')],
    ['keelTenantRef', requireNonEmptyString(envelope.tenantRef, 'envelope.tenantRef')],
    ['keelCorrelationId', requireNonEmptyString(envelope.correlationId, 'envelope.correlationId')],
    envelope.causationId ? ['keelCausationId', envelope.causationId] : null,
    ['keelSourceComponent', envelope.source?.component ?? 'unknown'],
    Number.isSafeInteger(envelope.sourceSequence)
      ? ['keelSourceSequence', String(envelope.sourceSequence)]
      : null,
    ['keelPayloadSha256', createHash('sha256').update(payloadCanonical).digest('hex')],
    ['keelPayloadBytes', String(Buffer.byteLength(payloadCanonical, 'utf8'))],
  ]
    .filter((pair) => pair !== null)
    .map(([key, value]) => `${key}=${escapeCefExtensionValue(value)}`)
    .join(' ');

  const message = `CEF:0|${
    ['KEEL', 'keel', String(envelope.envelopeVersion ?? 1), eventType, eventType, String(cefSeverity(envelope))]
      .map(escapeCefHeaderField)
      .join('|')
  }|${extension}`;

  // The framing invariant: one record is exactly one line. Escaping above is what makes
  // this hold; the assert is the backstop that turns any regression into a refusal.
  if (/[\r\n]/.test(message)) {
    throw new Error('cef record must be a single line');
  }
  const bytes = Buffer.byteLength(message, 'utf8');
  if (bytes > maxBytes) throw new CefMessageTooLargeError(bytes, maxBytes);
  return message;
}

async function defaultSendUdp({ host, port, message, family }) {
  const socket = dgram.createSocket(family === 6 || isIP(host) === 6 ? 'udp6' : 'udp4');
  try {
    await new Promise((resolve, reject) => {
      socket.send(Buffer.from(message, 'utf8'), port, host, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  } finally {
    socket.close();
  }
}

function maxBytesFromConfig(config) {
  const value = config?.maxMessageBytes;
  return Number.isSafeInteger(value) ? value : CEF_MAX_MESSAGE_BYTES;
}

function isTimeout(cause) {
  return cause?.name === 'TimeoutError' || cause?.name === 'AbortError';
}

function retryAfterMs(response) {
  const header = response?.headers?.get?.('retry-after');
  if (typeof header !== 'string' || header.trim() === '') return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, CEF_MAX_RETRY_AFTER_MS);
  }
  return undefined;
}

// The configured URL is the only routing input for https. It must be https to a public
// address. `allowLoopback` is for tests only: it also allows plain http, and both
// schemes may then reach 127.0.0.1 or ::1 so a local fixture can listen.
export function cefHttpsUrl(config, { allowLoopback = false } = {}) {
  const raw = config?.url;
  requireNonEmptyString(raw, 'cef destination config.url');
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('cef destination config.url is not a valid address');
  }
  if (allowLoopback && url.protocol === 'http:') return assertDestinationAllowed(url, { allowLoopback, protocols: ['http:'] });
  if (url.protocol !== 'https:') throw new Error('cef destination config.url must use https');
  return assertDestinationAllowed(url, { allowLoopback, protocols: ['https:'] });
}

function udpPort(config) {
  const port = Number(config?.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new TypeError('cef destination config.port must be an integer between 1 and 65535');
  }
  return port;
}

function isLocalName(host) {
  return host === 'localhost' || host === 'localhost.' || host.endsWith('.localhost');
}

/**
 * The address a udp record is sent to: an IP literal is checked as written; a name is
 * resolved and refused when ANY of its addresses is not public. Throws
 * BlockedDestinationError for a refused address.
 */
export async function resolveCefUdpTarget(host, { allowLoopback = false, resolve = dnsLookup } = {}) {
  requireNonEmptyString(host, 'cef destination config.host');
  const bare = host.replace(/^\[|\]$/g, '').toLowerCase();
  const literal = isIP(bare);
  if (literal) {
    const problem = addressProblem(bare, { allowLoopback });
    if (problem) throw new BlockedDestinationError(problem);
    return { address: bare, family: literal };
  }
  if (isLocalName(bare) && !allowLoopback) {
    throw new BlockedDestinationError(`${bare} is a local address; Keel only sends to public addresses`);
  }
  const addresses = await new Promise((done, fail) => {
    resolve(bare, { all: true }, (error, list) => (error ? fail(error) : done(list)));
  });
  const list = Array.isArray(addresses) ? addresses : [];
  if (list.length === 0) throw new Error(`${bare} did not resolve to any address`);
  for (const { address } of list) {
    const problem = addressProblem(address, { allowLoopback });
    if (problem) throw new BlockedDestinationError(`${bare} resolves to ${problem}`);
  }
  // Prefer IPv4, as the udp4 socket that sent to the name did; every address was checked.
  const chosen = list.find(({ address }) => isIP(address) === 4) ?? list[0];
  return { address: chosen.address, family: isIP(chosen.address) === 6 ? 6 : 4 };
}

// Spellings such as 2130706433, 0x7f.0.0.1 or "127.0.0.1." are an IPv4 address in URL
// and resolver terms; normalise them so registration refuses them too.
function numericHost(host) {
  if (isIP(host)) return host;
  try {
    const normalised = new URL(`https://${host}/`).hostname;
    return isIP(normalised) ? normalised : host;
  } catch {
    return host;
  }
}

/** Problems with a CEF destination config, checked when it is registered. */
export function cefDestinationProblems(config) {
  const problems = [];
  if (config?.transport === 'https') {
    try {
      cefHttpsUrl(config);
    } catch (cause) {
      problems.push(cause instanceof Error ? cause.message : String(cause));
    }
  } else if (config?.transport === 'udp') {
    const host = config?.host;
    if (typeof host !== 'string' || host.length === 0) {
      problems.push('cef destination config.host must be a non-empty string');
    } else {
      // A name is checked again, after DNS, on every send.
      const bare = numericHost(host.replace(/^\[|\]$/g, '').toLowerCase());
      const problem = isIP(bare) ? addressProblem(bare)
        : (isLocalName(bare) ? `${bare} is a local address; Keel only sends to public addresses` : null);
      if (problem) problems.push(problem);
    }
    try {
      udpPort(config);
    } catch (cause) {
      problems.push(cause.message);
    }
  } else {
    problems.push(`unsupported cef transport: ${String(config?.transport)}`);
  }
  return problems;
}

/** The default https transport: a POST that only reaches public addresses, on every redirect. */
function guardedFetch(allowLoopback, resolve) {
  return (url, init) => guardedRequest(url, {
    ...init,
    allowLoopback,
    resolve,
    protocols: allowLoopback ? ['http:', 'https:'] : ['https:'],
  });
}

/**
 * Build the CEF sink adapter. `sendUdp` and `fetchImpl` are injectable transports so the
 * boundary tests drive the production adapter without a network; production wiring uses
 * the defaults (node:dgram, and the guarded https transport). `allowLoopback` and
 * `resolve` are for tests only.
 */
export function createCefAdapter({
  sendUdp = defaultSendUdp, fetchImpl, timeoutMs = CEF_TIMEOUT_MS, allowLoopback = false, resolve,
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError('timeoutMs must be a positive integer');
  }
  return Object.freeze({
    kind: CEF_DESTINATION_KIND,
    async deliver({ destination, envelope, eventId, dedupKey }) {
      if (destination?.kind !== CEF_DESTINATION_KIND) {
        return {
          outcome: 'retry',
          error: `cef adapter cannot deliver destination kind: ${String(destination?.kind)}`,
        };
      }
      requireNonEmptyString(eventId, 'eventId');
      requireNonEmptyString(dedupKey, 'dedupKey');
      const config = destination.config ?? {};

      let message;
      try {
        message = formatCefEvent(envelope, { maxBytes: maxBytesFromConfig(config) });
      } catch (cause) {
        if (cause instanceof CefMessageTooLargeError) {
          // This event can never fit this sink: poison it, visibly, with the reason.
          return { outcome: 'poison', reason: cause.message };
        }
        return {
          outcome: 'retry',
          error: `cef formatting failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        };
      }

      const acknowledgement = config.acknowledgement ?? 'none';
      if (!CEF_ACKNOWLEDGEMENT_MODES.includes(acknowledgement)) {
        return {
          outcome: 'retry',
          error: `unsupported cef acknowledgement declaration: ${String(acknowledgement)}`,
        };
      }

      if (config.transport === 'udp') {
        if (acknowledgement !== 'none') {
          return {
            outcome: 'retry',
            error: 'cef udp transport cannot honour an http-response acknowledgement declaration',
          };
        }
        let target;
        let port;
        try {
          port = udpPort(config);
          target = await resolveCefUdpTarget(config.host, { allowLoopback, resolve });
        } catch (cause) {
          return {
            outcome: 'retry',
            error: `cef destination unusable: ${cause instanceof Error ? cause.message : String(cause)}`,
          };
        }
        try {
          // The checked address, never the name: DNS is not asked a second time.
          await sendUdp({ host: target.address, family: target.family, port, message });
        } catch (cause) {
          return {
            outcome: 'retry',
            error: `cef udp send failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          };
        }
        // The datagram was handed to the transport, but UDP syslog has no delivery
        // acknowledgement: remote acceptance is UNKNOWN. The event stays pending under
        // its original id and is redelivered; the receiver dedups on keelEventId.
        return {
          outcome: 'uncertain',
          error: 'cef udp syslog transport provides no delivery acknowledgement',
        };
      }

      if (config.transport === 'https') {
        let url;
        try {
          url = cefHttpsUrl(config, { allowLoopback });
        } catch (cause) {
          return {
            outcome: 'retry',
            error: `cef destination unusable: ${cause instanceof Error ? cause.message : String(cause)}`,
          };
        }
        const fetchCall = fetchImpl ?? guardedFetch(allowLoopback, resolve);
        let response;
        try {
          response = await fetchCall(url, {
            method: 'POST',
            headers: {
              'content-type': 'text/plain; charset=utf-8',
              [CEF_EVENT_ID_HEADER]: eventId,
              [CEF_DEDUP_KEY_HEADER]: dedupKey,
            },
            body: message,
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch (cause) {
          if (cause instanceof BlockedDestinationError) {
            return { outcome: 'retry', error: `cef destination unusable: ${cause.message}` };
          }
          if (isTimeout(cause)) {
            return {
              outcome: 'uncertain',
              error: `cef acknowledgement lost after the request was sent: ${cause.message}`,
            };
          }
          return {
            outcome: 'retry',
            error: `cef https delivery failed before any response: ${cause instanceof Error ? cause.message : String(cause)}`,
          };
        }
        if (response.status >= 200 && response.status < 300) {
          // A 2xx is remote acceptance ONLY when the deployment declared that the HTTP
          // response acknowledges delivery. Declared 'none' means the response is just
          // the transport handshake and the event remains honestly uncertain.
          return acknowledgement === 'http-response'
            ? 'accepted'
            : { outcome: 'uncertain', error: 'cef destination declares no delivery acknowledgement' };
        }
        if (response.status === 408 || response.status === 429 || response.status >= 500) {
          return {
            outcome: 'retry',
            error: `cef endpoint returned HTTP ${response.status}`,
            retryAfterMs: retryAfterMs(response),
          };
        }
        return { outcome: 'poison', reason: `cef endpoint rejected the event: HTTP ${response.status}` };
      }

      return {
        outcome: 'retry',
        error: `unsupported cef transport: ${String(config.transport)}`,
      };
    },
  });
}
