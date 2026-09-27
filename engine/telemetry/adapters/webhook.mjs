// engine/telemetry/adapters/webhook.mjs
//
// Roadmap task-81 (WS12): the generic authenticated webhook sink for the task-79 SIEM
// outbox. This is the REFERENCE generic transport: it delivers one task-77 envelope per
// POST to the destination's configured URL and reports one of the four task-79 adapter
// outcomes ('accepted' / retry / uncertain / poison).
//
// Non-negotiable rules:
//
// 1. The destination comes ONLY from the registered siem_destination row's config —
//    never from the event payload. An event is untrusted content; it cannot choose
//    where it is sent (or under which credential it is authenticated).
// 2. Authentication uses credential REFERENCES resolved through an injected resolver
//    (default: env:NAME references only). Secret values never live in destination
//    config (task-79 refuses secret-shaped config at registration), never enter the
//    request body, and never appear in an error message.
// 3. The stable task-77 event id and the (tenantRef, destinationId, eventId) dedup key
//    travel as explicit headers on every delivery and every retry, so the receiver can
//    honour the at-least-once RECEIVER_DEDUP_CONTRACT. Retries never mint a new id.
// 4. Outcome honesty: 2xx is 'accepted'; 408/429/5xx is a bounded retry (Retry-After
//    honoured, capped); any other 4xx is poison (the receiver rejected THIS event and a
//    redelivery of identical bytes will not change that); a timeout/abort AFTER the
//    request was sent is 'uncertain' — the receiver may have accepted, so the event is
//    redelivered under the SAME id rather than reported delivered.
import { createHmac } from 'node:crypto';

export const WEBHOOK_DESTINATION_KIND = 'webhook';
export const WEBHOOK_TIMEOUT_MS = 10 * 1000;
export const WEBHOOK_MAX_RETRY_AFTER_MS = 15 * 60 * 1000;
export const WEBHOOK_EVENT_ID_HEADER = 'x-keel-event-id';
export const WEBHOOK_DEDUP_KEY_HEADER = 'x-keel-dedup-key';
export const WEBHOOK_SIGNATURE_HEADER = 'x-keel-signature';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

// The configured URL is the only routing input. https is required; plain http is
// accepted for loopback only, so bounded local fixtures remain possible without
// opening a plaintext path to a remote sink.
export function webhookDestinationUrl(destination) {
  const raw = destination?.config?.url;
  requireNonEmptyString(raw, 'webhook destination config.url');
  const url = new URL(raw);
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)) return url;
  throw new Error('webhook destination config.url must use https (http is loopback-only)');
}

// The default resolver understands env:NAME references only. It never invents a
// credential: an unresolvable reference is a visible delivery error, not a fallback.
export function defaultResolveSecret(reference) {
  requireNonEmptyString(reference, 'credential reference');
  if (reference.startsWith('env:')) {
    const value = process.env[reference.slice('env:'.length)];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  throw new Error(`unresolved credential reference: ${reference}`);
}

async function authHeaders({ config, body, resolveSecret }) {
  const auth = config.auth;
  if (auth === undefined || auth === null) return {};
  if (typeof auth !== 'object' || Array.isArray(auth)) {
    throw new TypeError('webhook destination config.auth must be an object');
  }
  if (auth.type === 'bearer') {
    const token = await resolveSecret(requireNonEmptyString(auth.tokenRef, 'auth.tokenRef'));
    return { authorization: `Bearer ${token}` };
  }
  if (auth.type === 'hmac-sha256') {
    const secret = await resolveSecret(requireNonEmptyString(auth.secretRef, 'auth.secretRef'));
    const signature = createHmac('sha256', secret).update(body).digest('hex');
    return { [WEBHOOK_SIGNATURE_HEADER]: `sha256=${signature}` };
  }
  throw new Error(`unsupported webhook auth type: ${String(auth.type)}`);
}

function retryAfterMs(response) {
  const header = response?.headers?.get?.('retry-after');
  if (typeof header !== 'string' || header.trim() === '') return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, WEBHOOK_MAX_RETRY_AFTER_MS);
  }
  const at = Date.parse(header);
  if (!Number.isNaN(at)) {
    return Math.min(Math.max(0, at - Date.now()), WEBHOOK_MAX_RETRY_AFTER_MS);
  }
  return undefined;
}

function isTimeout(cause) {
  return cause?.name === 'TimeoutError' || cause?.name === 'AbortError';
}

/**
 * Build the webhook sink adapter. `fetchImpl` and `resolveSecret` are injectable so the
 * boundary tests drive the production adapter against fake transports and fake
 * credential stores; production wiring uses the defaults (global fetch, env references).
 */
export function createWebhookAdapter({
  fetchImpl,
  resolveSecret = defaultResolveSecret,
  timeoutMs = WEBHOOK_TIMEOUT_MS,
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError('timeoutMs must be a positive integer');
  }
  return Object.freeze({
    kind: WEBHOOK_DESTINATION_KIND,
    async deliver({ destination, envelope, eventId, dedupKey }) {
      if (destination?.kind !== WEBHOOK_DESTINATION_KIND) {
        return {
          outcome: 'retry',
          error: `webhook adapter cannot deliver destination kind: ${String(destination?.kind)}`,
        };
      }
      requireNonEmptyString(eventId, 'eventId');
      requireNonEmptyString(dedupKey, 'dedupKey');

      let url;
      let body;
      let headers;
      try {
        // Routing and authentication are functions of the registered destination
        // configuration ONLY. The envelope is the payload; nothing in it may steer
        // the request line or the credential.
        url = webhookDestinationUrl(destination);
        body = JSON.stringify(envelope);
        headers = {
          'content-type': 'application/json',
          [WEBHOOK_EVENT_ID_HEADER]: eventId,
          [WEBHOOK_DEDUP_KEY_HEADER]: dedupKey,
          ...(await authHeaders({ config: destination.config ?? {}, body, resolveSecret })),
        };
      } catch (cause) {
        // A broken destination configuration can never be fixed by redelivering the
        // same event unchanged, but the event itself is fine — keep it retrying
        // (visibly backing off towards quarantine) rather than dropping it.
        return {
          outcome: 'retry',
          error: `webhook destination unusable: ${cause instanceof Error ? cause.message : String(cause)}`,
        };
      }

      const fetchCall = fetchImpl ?? globalThis.fetch?.bind(globalThis);
      if (typeof fetchCall !== 'function') {
        return { outcome: 'retry', error: 'webhook delivery has no fetch implementation' };
      }

      let response;
      try {
        response = await fetchCall(url, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (cause) {
        if (isTimeout(cause)) {
          return {
            outcome: 'uncertain',
            error: `webhook acknowledgement lost after the request was sent: ${cause.message}`,
          };
        }
        return {
          outcome: 'retry',
          error: `webhook delivery failed before any response: ${cause instanceof Error ? cause.message : String(cause)}`,
        };
      }

      if (response.status >= 200 && response.status < 300) return 'accepted';
      if (response.status === 408 || response.status === 429 || response.status >= 500) {
        return {
          outcome: 'retry',
          error: `webhook returned HTTP ${response.status}`,
          retryAfterMs: retryAfterMs(response),
        };
      }
      return {
        outcome: 'poison',
        reason: `webhook rejected the event: HTTP ${response.status}`,
      };
    },
  });
}
