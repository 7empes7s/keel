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
import { createHash } from 'node:crypto';
import dgram from 'node:dgram';

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

async function defaultSendUdp({ host, port, message }) {
  const socket = dgram.createSocket('udp4');
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

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function httpsUrl(config) {
  const raw = config?.url;
  requireNonEmptyString(raw, 'cef destination config.url');
  const url = new URL(raw);
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)) return url;
  throw new Error('cef destination config.url must use https (http is loopback-only)');
}

/**
 * Build the CEF sink adapter. `sendUdp` and `fetchImpl` are injectable transports so the
 * boundary tests drive the production adapter without a network; production wiring uses
 * the defaults (node:dgram, global fetch).
 */
export function createCefAdapter({ sendUdp = defaultSendUdp, fetchImpl, timeoutMs = CEF_TIMEOUT_MS } = {}) {
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
        const host = config.host;
        const port = Number(config.port);
        try {
          requireNonEmptyString(host, 'cef destination config.host');
          if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
            throw new TypeError('cef destination config.port must be an integer between 1 and 65535');
          }
          await sendUdp({ host, port, message });
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
          url = httpsUrl(config);
        } catch (cause) {
          return {
            outcome: 'retry',
            error: `cef destination unusable: ${cause instanceof Error ? cause.message : String(cause)}`,
          };
        }
        const fetchCall = fetchImpl ?? globalThis.fetch?.bind(globalThis);
        if (typeof fetchCall !== 'function') {
          return { outcome: 'retry', error: 'cef https delivery has no fetch implementation' };
        }
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
