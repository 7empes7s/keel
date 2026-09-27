/** Microsoft Secure Score is an external measurement, never a KEEL verdict.
 * Inject a collector-only read adapter; this module acquires no credentials. */
import { can } from '../authz/can.mjs';
import { assertTenantRef, tenantRefFor } from '../store/tenantRef.mjs';

const PATH = '/v1.0/security/secureScores?$top=1';
const MAX_AGE_MS = 48 * 60 * 60 * 1000;
async function authorize({ client, principal, tenantRef }) {
  assertTenantRef(tenantRef);
  if (!await can(client, principal, 'read')) throw new Error('forbidden');
}

export async function importSecureScore({ reader, now = new Date(), ...context }) {
  await authorize(context);
  if (reader?.credentialMode !== 'collector' || typeof reader?.get !== 'function'
    || typeof reader?.credentialRef !== 'string' || !reader.credentialRef.trim()) {
    throw new TypeError('Secure Score requires a collector read adapter and credential reference');
  }
  if (reader.tenantRef !== context.tenantRef) throw new Error('reader tenant mismatch');
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError('invalid read timestamp');
  const provenance = Object.freeze({ source: 'microsoft-graph', apiVersion: 'v1.0', path: PATH,
    credentialMode: 'collector', credentialRef: reader.credentialRef, importedAt: now.toISOString() });
  const base = { contractVersion: 1, tenantRef: context.tenantRef, provenance };
  const unknown = reason => Object.freeze({ ...base, status: 'unknown', reason,
    currentScore: null, maxScore: null, scoredAt: null });
  let response;
  try { response = await reader.get(PATH); } catch {
    await authorize(context);
    return unknown('read-failed'); // Never expose provider errors that might contain tokens.
  }
  await authorize(context); // A role can be revoked while the external read is in flight.
  if (!Array.isArray(response?.value)) return unknown('malformed-response');
  if (!response.value.length) return unknown('empty-read');
  if (response.value.length !== 1) return unknown('ambiguous-provider-response');
  const record = response.value[0];
  if (typeof record?.azureTenantId !== 'string' || !record.azureTenantId.trim()) {
    return unknown('missing-invalid-or-stale-data');
  }
  if (tenantRefFor(record.azureTenantId) !== context.tenantRef) {
    throw new Error('Secure Score tenant mismatch');
  }
  const timestamp = typeof record?.createdDateTime === 'string' ? Date.parse(record.createdDateTime) : NaN;
  if (!record?.azureTenantId || typeof record.id !== 'string' || !record.id
    || !Number.isFinite(timestamp) || timestamp > now.getTime() || now.getTime() - timestamp > MAX_AGE_MS
    || !Number.isFinite(record.currentScore) || !Number.isFinite(record.maxScore)
    || record.currentScore < 0 || record.maxScore <= 0 || record.currentScore > record.maxScore) {
    return unknown('missing-invalid-or-stale-data');
  }
  return Object.freeze({ ...base, status: 'available', sourceId: record.id,
    currentScore: record.currentScore, maxScore: record.maxScore,
    scoredAt: new Date(timestamp).toISOString() });
}

/** Plain-text presentation for authorized consumers, including legacy/missing reads.
 * No pass/risk/certification inference and no invented control points. */
export function presentSecureScore(result) {
  if (result?.contractVersion !== 1 || result.status !== 'available'
    || !Number.isFinite(result.currentScore) || !Number.isFinite(result.maxScore)
    || result.currentScore < 0 || result.maxScore <= 0 || result.currentScore > result.maxScore
    || !Number.isFinite(Date.parse(result.scoredAt)) || result.provenance?.source !== 'microsoft-graph') {
    return 'Microsoft Secure Score: unknown';
  }
  return `Microsoft Secure Score: ${result.currentScore} / ${result.maxScore} (external; ${result.scoredAt})`;
}
