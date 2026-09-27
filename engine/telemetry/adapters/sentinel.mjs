// engine/telemetry/adapters/sentinel.mjs
//
// Roadmap task-80 (WS12): Azure Monitor Logs Ingestion API / Microsoft Sentinel
// delivery adapter for the task-79 durable SIEM outbox. Delivers one task-77 event
// envelope per call to a configured Data Collection Rule (DCR) stream.
//
// API contract implemented (checked against current official documentation during
// implementation — Global Constraint 8):
//   Source:         https://learn.microsoft.com/en-us/azure/azure-monitor/logs/logs-ingestion-api-overview
//   Retrieved:      2026-09-26
//   API version:    2023-01-01
//   URI:            {Endpoint}/dataCollectionRules/{DCR Immutable ID}/streams/{Stream Name}?api-version=2023-01-01
//   Auth:           Bearer token, client-credentials flow, audience
//                   https://monitor.azure.com (public cloud; .cn / .us for sovereign
//                   clouds). The GRAPH audience (graph.microsoft.com) is NEVER valid
//                   for ingestion and is never requested here.
//   Body:           UTF-8 JSON array whose items match the DCR stream declaration.
//   x-ms-client-request-id: optional GUID, diagnostic/troubleshooting only. It is
//                   NOT an idempotency or dedup guarantee: deduplication is the
//                   receiver's job on (TenantRef, DestinationId, KeelEventId), per
//                   the task-79 RECEIVER_DEDUP_CONTRACT (at-least-once delivery).
//   Limits:         https://learn.microsoft.com/en-us/azure/azure-monitor/fundamentals/service-limits
//
// Non-negotiable rules:
//
// 1. NO IMPLICIT PROVISIONING. The workspace, custom table, DCE, DCR, app
//    registration and the Monitoring Metrics Publisher role assignment must all
//    exist already. This adapter never creates Azure resources; missing pieces are
//    reported as named pending setup prerequisites and the event stays pending.
// 2. A throttled (429) or otherwise transiently failed batch is NEVER acknowledged.
//    429 maps to a retry honouring the Retry-After header; timeouts and lost
//    responses map to 'uncertain' so the outbox redelivers under the SAME event id.
// 3. The event identity carried into the table is the KEEL event id
//    (KeelEventId column) plus the tenant-specific source identity; the per-request
//    x-ms-client-request-id is diagnostic only.
// 4. Secrets never enter logs, errors, the outbox or evidence: the token is used
//    only in the Authorization header, and every error string this module produces
//    carries HTTP status and the service's x-ms-request-id diagnostic — never
//    headers, bodies or token material.
// 5. The sender credential is a dedicated Entra app registration referenced by the
//    destination config (credentialRef). It is NOT the collector or restorer
//    credential; the read/write separation is untouched.
import { createHash, createSign, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { canonicalJson } from '../events.mjs';

export const SENTINEL_DESTINATION_KIND = 'azure-monitor-sentinel';
export const LOGS_INGESTION_API_VERSION = '2023-01-01';
export const LOGS_INGESTION_DOC_SOURCE = Object.freeze({
  url: 'https://learn.microsoft.com/en-us/azure/azure-monitor/logs/logs-ingestion-api-overview',
  retrievedAt: '2026-09-26',
  apiVersion: LOGS_INGESTION_API_VERSION,
  credentialMode: 'entra-app-client-credentials',
  tokenAudience: 'https://monitor.azure.com',
  limits: 'https://learn.microsoft.com/en-us/azure/azure-monitor/fundamentals/service-limits',
});

// Per-cloud token audiences for the Logs Ingestion API. The audience is DERIVED
// from the small fixed cloud map — it is never a free-text configuration value, so
// a Graph (or any foreign) audience cannot be configured or mutated in.
export const LOGS_INGESTION_TOKEN_AUDIENCE = Object.freeze({
  public: 'https://monitor.azure.com',
  china: 'https://monitor.azure.cn',
  usgov: 'https://monitor.azure.us',
});

export const SENTINEL_TABLE_NAME = 'KeelEvents_CL';
export const SENTINEL_STREAM_NAME = 'Custom-KeelEvents';
export const DEFAULT_SENTINEL_TIMEOUT_MS = 10 * 1000;

// The canonical record schema the adapter emits. ops/sentinel-schema.json declares
// the same columns for the custom table / DCR stream; the boundary tests assert the
// two agree. Column names obey the documented rules (start with a letter, <=45
// alphanumeric/underscore characters) and avoid the reserved names (_ResourceId,
// id, _SubscriptionId, TenantId, Type, UniqueId, Title) — TenantRef and EventType
// are used instead of the reserved TenantId / Type.
export const SENTINEL_COLUMNS = Object.freeze([
  Object.freeze({ name: 'TimeGenerated', type: 'datetime' }),
  Object.freeze({ name: 'KeelEventId', type: 'string' }),
  Object.freeze({ name: 'TenantRef', type: 'string' }),
  Object.freeze({ name: 'SourceIdentity', type: 'string' }),
  Object.freeze({ name: 'DestinationId', type: 'string' }),
  Object.freeze({ name: 'EventType', type: 'string' }),
  Object.freeze({ name: 'CorrelationId', type: 'string' }),
  Object.freeze({ name: 'CausationId', type: 'string' }),
  Object.freeze({ name: 'SourceComponent', type: 'string' }),
  Object.freeze({ name: 'SourceInstanceId', type: 'string' }),
  Object.freeze({ name: 'SourceSequence', type: 'long' }),
  Object.freeze({ name: 'ObservedAt', type: 'datetime' }),
  Object.freeze({ name: 'EmittedAt', type: 'datetime' }),
  Object.freeze({ name: 'EnvelopeVersion', type: 'long' }),
  Object.freeze({ name: 'PayloadJson', type: 'string' }),
  Object.freeze({ name: 'PayloadBytes', type: 'long' }),
  Object.freeze({ name: 'RedactedFields', type: 'long' }),
  Object.freeze({ name: 'Truncated', type: 'boolean' }),
]);

// Reserved per the documentation; a fixture asserts none of our columns collide.
const RESERVED_COLUMNS = new Set(['_ResourceId', 'id', '_SubscriptionId', 'TenantId', 'Type', 'UniqueId', 'Title']);
for (const column of SENTINEL_COLUMNS) {
  if (RESERVED_COLUMNS.has(column.name)) {
    throw new Error(`sentinel column collides with a reserved name: ${column.name}`);
  }
  if (!/^[A-Za-z][A-Za-z0-9_]{0,44}$/.test(column.name)) {
    throw new Error(`sentinel column name violates the documented rules: ${column.name}`);
  }
}

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

/** Token audience for a configured cloud; unknown clouds fail closed. */
export function tokenAudienceForCloud(cloud = 'public') {
  const audience = LOGS_INGESTION_TOKEN_AUDIENCE[cloud];
  if (!audience) {
    throw new Error(`unknown cloud '${cloud}': expected one of ${Object.keys(LOGS_INGESTION_TOKEN_AUDIENCE).join(', ')}`);
  }
  return audience;
}

/**
 * The ingestion URI for a configured endpoint + DCR + stream. The endpoint must be
 * an https URL (a DCE endpoint or the DCR logs ingestion endpoint); path segments
 * are encoded so a malformed config cannot redirect the request path.
 */
export function logsIngestionUrl({ endpoint, dcrImmutableId, streamName = SENTINEL_STREAM_NAME }) {
  requireNonEmptyString(endpoint, 'config.endpoint');
  requireNonEmptyString(dcrImmutableId, 'config.dcrImmutableId');
  requireNonEmptyString(streamName, 'config.streamName');
  let base;
  try {
    base = new URL(endpoint);
  } catch {
    throw new TypeError('config.endpoint must be a valid URL');
  }
  if (base.protocol !== 'https:') {
    throw new TypeError('config.endpoint must be an https URL');
  }
  const root = base.origin + base.pathname.replace(/\/+$/, '');
  return `${root}/dataCollectionRules/${encodeURIComponent(dcrImmutableId)}`
    + `/streams/${encodeURIComponent(streamName)}?api-version=${LOGS_INGESTION_API_VERSION}`;
}

/**
 * Named pending setup prerequisites for a destination config. This adapter never
 * provisions Azure resources, so anything missing here is an operator action.
 * Returns [] when the config is complete.
 */
export function sentinelSetupPrerequisites(config = {}) {
  const pending = [];
  if (typeof config.endpoint !== 'string' || config.endpoint.length === 0) {
    pending.push({
      name: 'data-collection-endpoint',
      detail: 'configure config.endpoint with the DCE endpoint or DCR logs ingestion endpoint (https URL)',
    });
  } else {
    try {
      if (new URL(config.endpoint).protocol !== 'https:') throw new Error('not https');
    } catch {
      pending.push({
        name: 'data-collection-endpoint',
        detail: 'config.endpoint must be a valid https URL',
      });
    }
  }
  if (typeof config.dcrImmutableId !== 'string' || config.dcrImmutableId.length === 0) {
    pending.push({
      name: 'data-collection-rule-immutable-id',
      detail: 'create the DCR for stream Custom-KeelEvents (see ops/sentinel-schema.json) and configure config.dcrImmutableId with its immutableId',
    });
  }
  if (typeof config.credentialRef !== 'string' || config.credentialRef.length === 0) {
    pending.push({
      name: 'entra-app-credential-reference',
      detail: 'configure config.credentialRef naming the dedicated sender app registration credential; the app needs the Monitoring Metrics Publisher role on the DCR',
    });
  }
  if (config.cloud !== undefined && !LOGS_INGESTION_TOKEN_AUDIENCE[config.cloud]) {
    pending.push({
      name: 'supported-cloud',
      detail: `config.cloud must be one of ${Object.keys(LOGS_INGESTION_TOKEN_AUDIENCE).join(', ')}`,
    });
  }
  if (config.streamName !== undefined
      && (typeof config.streamName !== 'string' || config.streamName.length === 0)) {
    pending.push({
      name: 'stream-name',
      detail: 'config.streamName must be a non-empty string when set',
    });
  }
  return pending;
}

/**
 * Map a task-77 envelope to one stream record. Carries the KEEL event id and a
 * tenant-specific source identity — the receiver-side dedup key is
 * (TenantRef, DestinationId, KeelEventId); see ops/sentinel-dedup.kql.
 */
export function recordForEnvelope({ envelope, destinationId, eventId }) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new TypeError('envelope must be a task-77 event envelope object');
  }
  requireNonEmptyString(envelope.eventId, 'envelope.eventId');
  requireNonEmptyString(envelope.tenantRef, 'envelope.tenantRef');
  requireNonEmptyString(envelope.eventType, 'envelope.eventType');
  requireNonEmptyString(envelope.observedAt, 'envelope.observedAt');
  const keelEventId = eventId ?? envelope.eventId;
  if (keelEventId !== envelope.eventId) {
    throw new TypeError('outbox event id does not match the envelope event id');
  }
  const capture = envelope.capture && typeof envelope.capture === 'object' ? envelope.capture : {};
  return {
    TimeGenerated: envelope.observedAt,
    KeelEventId: envelope.eventId,
    TenantRef: envelope.tenantRef,
    SourceIdentity: `keel:${envelope.tenantRef}`,
    DestinationId: requireNonEmptyString(String(destinationId ?? ''), 'destinationId'),
    EventType: envelope.eventType,
    CorrelationId: requireNonEmptyString(envelope.correlationId, 'envelope.correlationId'),
    CausationId: typeof envelope.causationId === 'string' ? envelope.causationId : '',
    SourceComponent: requireNonEmptyString(envelope.source?.component, 'envelope.source.component'),
    SourceInstanceId: typeof envelope.source?.instanceId === 'string' ? envelope.source.instanceId : '',
    SourceSequence: Number.isSafeInteger(envelope.sourceSequence) ? envelope.sourceSequence : -1,
    ObservedAt: envelope.observedAt,
    EmittedAt: requireNonEmptyString(envelope.emittedAt, 'envelope.emittedAt'),
    EnvelopeVersion: Number.isSafeInteger(envelope.envelopeVersion) ? envelope.envelopeVersion : 0,
    PayloadJson: canonicalJson(envelope.payload ?? {}),
    PayloadBytes: Number.isSafeInteger(capture.payloadBytes) ? capture.payloadBytes : 0,
    RedactedFields: Number.isSafeInteger(capture.redactedFields) ? capture.redactedFields : 0,
    Truncated: capture.truncated === true,
  };
}

// --- Default sender credential: dedicated Entra app registration, certificate ---
// client-credentials flow against the cloud's token endpoint, scoped to the LOGS
// INGESTION audience. Adapted from the probe's hand-rolled flow
// (tools/tenant-probe/auth.mjs) so no SDK hides retries. The credential REFERENCE
// lives in destination config (`credentialRef: 'env:<VAR>'`); the referenced env
// var names a JSON file holding { tenantId, clientId, certificatePath,
// privateKeyPath }. The file path and its contents never enter logs or evidence.

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function certThumbprint(pemPath) {
  const pem = readFileSync(pemPath, 'utf8');
  const body = pem
    .replace(/-----BEGIN CERTIFICATE-----/, '')
    .replace(/-----END CERTIFICATE-----/, '')
    .replace(/\s+/g, '');
  return createHash('sha1').update(Buffer.from(body, 'base64')).digest();
}

const tokenCache = new Map();

async function acquireCertificateToken({ credentialRef, scope, fetchImpl }) {
  const cached = tokenCache.get(credentialRef);
  if (cached && cached.scope === scope && cached.expiresAt > Date.now() + 60 * 1000) {
    return cached.accessToken;
  }
  if (!credentialRef.startsWith('env:')) {
    throw new Error('unsupported credential reference form (expected env:<VAR>)');
  }
  const credentialPath = process.env[credentialRef.slice(4)];
  if (typeof credentialPath !== 'string' || credentialPath.length === 0) {
    throw new Error('credential reference environment variable is not set');
  }
  const credential = JSON.parse(readFileSync(credentialPath, 'utf8'));
  const { tenantId, clientId, certificatePath, privateKeyPath } = credential;
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT', x5t: b64url(certThumbprint(certificatePath)) };
  const assertionPayload = {
    aud: `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    iss: clientId,
    sub: clientId,
    jti: randomUUID(),
    nbf: now - 60,
    exp: now + 540,
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(assertionPayload))}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  const clientAssertion = `${signingInput}.${b64url(signer.sign(readFileSync(privateKeyPath, 'utf8')))}`;
  const response = await fetchImpl(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      scope,
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: clientAssertion,
      grant_type: 'client_credentials',
    }),
  });
  if (!response.ok) {
    // Status only — the token endpoint's error body can echo request material.
    throw new Error(`token request failed (HTTP ${response.status})`);
  }
  const json = await response.json();
  const accessToken = requireNonEmptyString(json.access_token, 'access token');
  tokenCache.set(credentialRef, {
    scope,
    accessToken,
    expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000,
  });
  return accessToken;
}

/**
 * Create the outbox adapter for SENTINEL_DESTINATION_KIND destinations.
 *
 * Options (fixtures inject all of these; production uses the defaults):
 *   fetchImpl      — fetch-compatible function for BOTH token and ingestion calls
 *   tokenProvider  — async ({ destination, scope }) => access token string;
 *                    defaults to the credentialRef-resolving certificate flow above
 *   uuid           — diagnostic request-id generator (x-ms-client-request-id)
 *   timeoutMs      — per-request timeout
 *
 * deliver() outcomes follow the task-79 adapter contract:
 *   'accepted'            2xx from the ingestion endpoint
 *   { outcome:'retry' }   408/429/5xx, 401/403 (role propagation is eventually
 *                         consistent), missing setup prerequisites or an
 *                         unavailable credential — the event stays pending and is
 *                         NEVER acknowledged; 429 honours Retry-After
 *   { outcome:'uncertain' } timeout / network error: the request may have been
 *                         accepted remotely, so the outbox redelivers the SAME id
 *   { outcome:'poison' }  400 (stream schema rejected), other 4xx, or an envelope
 *                         that cannot be mapped — durable quarantine with a reason
 */
export function createSentinelAdapter({
  fetchImpl = globalThis.fetch?.bind(globalThis),
  tokenProvider = null,
  uuid = randomUUID,
  timeoutMs = DEFAULT_SENTINEL_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('createSentinelAdapter requires a fetch implementation');
  }
  if (tokenProvider !== null && typeof tokenProvider !== 'function') {
    throw new TypeError('tokenProvider must be a function');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError('timeoutMs must be a positive integer');
  }
  const acquireToken = tokenProvider
    ?? (({ destination, scope }) => acquireCertificateToken({
      credentialRef: destination.config.credentialRef, scope, fetchImpl,
    }));

  return Object.freeze({
    kind: SENTINEL_DESTINATION_KIND,
    docSource: LOGS_INGESTION_DOC_SOURCE,

    async deliver({ destination, envelope, eventId }) {
      if (!destination || typeof destination !== 'object') {
        throw new TypeError('deliver requires a destination row');
      }
      const config = destination.config && typeof destination.config === 'object'
        ? destination.config
        : {};
      // Missing workspace/DCR/credential configuration is a NAMED pending setup,
      // never a silent failure and never a fake acknowledgement.
      const pending = sentinelSetupPrerequisites(config);
      if (pending.length > 0) {
        return {
          outcome: 'retry',
          error: `sentinel destination has pending setup prerequisites: ${pending.map((p) => p.name).join(', ')}`,
          pendingPrerequisites: pending,
        };
      }
      if (envelope?.tenantRef !== destination.tenant_ref) {
        return { outcome: 'poison', reason: 'envelope tenant does not match the destination tenant' };
      }
      let record;
      try {
        record = recordForEnvelope({ envelope, destinationId: destination.id, eventId });
      } catch (cause) {
        return {
          outcome: 'poison',
          reason: `envelope cannot be mapped to the stream schema: ${cause instanceof Error ? cause.message : String(cause)}`,
        };
      }

      // The audience is derived from the fixed cloud map — the Graph audience is
      // structurally impossible here, not just discouraged.
      const scope = `${tokenAudienceForCloud(config.cloud ?? 'public')}/.default`;
      let token;
      try {
        token = requireNonEmptyString(await acquireToken({ destination, scope }), 'access token');
      } catch {
        return {
          outcome: 'retry',
          error: 'sentinel token credential unavailable (pending setup prerequisite: entra-app-credential-reference)',
          pendingPrerequisites: [{
            name: 'entra-app-credential-reference',
            detail: 'the configured credential reference could not produce a token for the Logs Ingestion audience',
          }],
        };
      }

      // Diagnostic only: troubleshooting correlation with the service. Never a
      // dedup/idempotency key — the KEEL event id in the record is the identity.
      const clientRequestId = uuid();
      let response;
      try {
        response = await fetchImpl(logsIngestionUrl({
          endpoint: config.endpoint,
          dcrImmutableId: config.dcrImmutableId,
          streamName: config.streamName ?? SENTINEL_STREAM_NAME,
        }), {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json; charset=utf-8',
            'x-ms-client-request-id': clientRequestId,
          },
          body: JSON.stringify([record]),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        // Timeout or lost response: the service may have accepted the batch. The
        // outbox redelivers under the same event id; the receiver dedups.
        return { outcome: 'uncertain', error: 'ingestion request outcome unknown (timeout or lost response)' };
      }

      const serviceRequestId = typeof response.headers?.get === 'function'
        ? response.headers.get('x-ms-request-id')
        : null;
      const diagnostic = serviceRequestId ? ` (x-ms-request-id ${serviceRequestId})` : '';
      const { status } = response;
      if (status >= 200 && status < 300) {
        return { outcome: 'accepted', clientRequestId, serviceRequestId };
      }
      if (status === 429) {
        const retryAfterSeconds = Number(response.headers?.get?.('retry-after'));
        return {
          outcome: 'retry',
          retryAfterMs: Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0
            ? retryAfterSeconds * 1000
            : undefined,
          error: `throttled by the ingestion endpoint (HTTP 429)${diagnostic}`,
        };
      }
      if (status === 400) {
        return {
          outcome: 'poison',
          reason: `stream schema rejected by the DCR (HTTP 400); check ops/sentinel-schema.json against the deployed stream declaration${diagnostic}`,
        };
      }
      if (status === 401 || status === 403) {
        return {
          outcome: 'retry',
          error: `ingestion authorization failed (HTTP ${status}); verify the Monitoring Metrics Publisher role assignment on the DCR — role propagation is eventually consistent${diagnostic}`,
        };
      }
      if (status === 408 || status >= 500) {
        return { outcome: 'retry', error: `transient ingestion failure (HTTP ${status})${diagnostic}` };
      }
      return {
        outcome: 'poison',
        reason: `logs ingestion rejected the event (HTTP ${status})${diagnostic}`,
      };
    },
  });
}
