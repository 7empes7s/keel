/**
 * Gap P2: the committed live records, checked for one tenant at one moment.
 *
 * Reads the signed records under docs/release/qualifications (the Entra write
 * captures in entra-live/ and the workload acceptance records beside them) and
 * runs each through the code that already verifies it:
 *  - an Entra write capture through entraLive.mjs verifyRecord (runner
 *    signature, test tenant, read-back, capture digest, then the capability's
 *    own live gate: tenant, freshness, projection contract);
 *  - a workload record through the release ledger's classifyLiveRecord
 *    (verifyEvidence with --require-live semantics).
 *
 * Nothing here promotes a claim or writes a file. A record that does not verify
 * (no key, bad signature, another tenant, older than 30 days) is reported as not
 * live, with the checker's own failures and one plain-English reason.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { LIVE_EVIDENCE_MAX_AGE_MS } from '../../engine/coverage/capabilities.mjs';
import { classifyLiveRecord } from '../release/acceptanceLedger.mjs';
import { DEFAULT_MAX_AGE_HOURS } from '../release/qualification.mjs';
import { verifyRecord } from './entraLive.mjs';
import { EXCHANGE_LIVE_GATE } from './exchangeAcceptance.mjs';
import { ONEDRIVE_PURVIEW_LIVE_GATE } from './onedrivePurviewAcceptance.mjs';
import { SHAREPOINT_LIVE_GATE } from './sharepointAcceptance.mjs';
import { TEAMS_LIVE_GATE } from './teamsAcceptance.mjs';

export const ENTRA_LIVE_SUBDIR = 'entra-live';

/** The workload acceptance gates and the collection workloads each one proves. */
export const WORKLOAD_LIVE_GATES = Object.freeze([
  { gate: SHAREPOINT_LIVE_GATE, label: 'SharePoint site settings', workloads: ['sharepoint-site-settings'] },
  { gate: TEAMS_LIVE_GATE, label: 'Teams settings', workloads: ['teams-settings'] },
  { gate: EXCHANGE_LIVE_GATE, label: 'Exchange mailbox settings', workloads: ['exchange-mailbox-settings'] },
  { gate: ONEDRIVE_PURVIEW_LIVE_GATE, label: 'OneDrive and Purview settings', workloads: ['onedrive-site-settings', 'purview-labels'] },
].map((entry) => Object.freeze({ ...entry, workloads: Object.freeze(entry.workloads) })));

export const NO_KEY_REASON = 'the key that checks live records is not set up on this server';

/** One plain sentence for why a record does not count; the raw failures stay in `failures`. */
export function plainReason(failures, { missingKeyReason = NO_KEY_REASON } = {}) {
  const text = failures.join(' | ');
  if (/verification key/.test(text)) return missingKeyReason;
  if (/pending/.test(text)) return 'the live run has not been captured yet';
  if (/signature|runner/.test(text)) return 'its signature does not match, so it may have been changed';
  if (/cross-tenant|not the test tenant/.test(text)) return 'it was recorded on a different tenant';
  if (/stale/.test(text)) return 'it is more than 30 days old';
  if (/in the future/.test(text)) return 'its date is in the future';
  if (/capture|artifact/.test(text)) return 'its capture file does not match the record';
  if (/synthetic|fixture/.test(text)) return 'it comes from a test run, not a live one';
  if (/read-back/.test(text)) return 'the write did not read back as intended in the live run';
  if (/not a registered write/.test(text)) return 'KEEL no longer offers this write';
  return 'it did not pass its checks';
}

function expiry(observedAt, maxAgeMs) {
  const at = Date.parse(observedAt ?? '');
  return Number.isNaN(at) ? null : new Date(at + maxAgeMs).toISOString();
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function entraRecords(dir, { hmacKey, tenantRef, now, missingKeyReason }) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json') && !name.endsWith('.capture.json') && !name.endsWith('.demotion.json'))
    .sort()
    .map((file) => {
      const record = readJson(join(dir, file));
      const capturePath = join(dir, file.replace(/\.json$/, '.capture.json'));
      const captureLog = existsSync(capturePath) ? readFileSync(capturePath, 'utf8') : '';
      const result = record
        ? verifyRecord(record, { hmacKey, captureLog, now, tenantRef })
        : { ok: false, failures: ['the record is not readable JSON'] };
      return Object.freeze({
        file,
        resourceType: record?.resourceType ?? null,
        operation: record?.operation ?? null,
        proofRef: record?.proofRef ?? null,
        observedAt: record?.observedAt ?? null,
        expiresAt: expiry(record?.observedAt, LIVE_EVIDENCE_MAX_AGE_MS),
        live: result.ok,
        reason: result.ok ? null : plainReason(result.failures, { missingKeyReason }),
        failures: Object.freeze([...result.failures]),
      });
    });
}

function workloadRecords(dir, { hmacKey, tenantRef, now, missingKeyReason }) {
  return WORKLOAD_LIVE_GATES.flatMap((spec) => {
    const path = join(dir, `${spec.gate}.json`);
    if (!existsSync(path)) return [];
    const record = readJson(path);
    // The record's own build: the capture is bound to the build it ran on, and the
    // gate's validator still checks its prerequisites against the code running now.
    const result = classifyLiveRecord(spec, record ?? { unreadable: 'not readable JSON' }, {
      hmacKey, tenantRef, build: record?.build ?? null, evidenceDir: dir, now,
    });
    const live = result.status === 'live-qualified';
    return [Object.freeze({
      gate: spec.gate,
      label: spec.label,
      workloads: spec.workloads,
      observedAt: record?.observedAt ?? null,
      expiresAt: expiry(record?.observedAt, DEFAULT_MAX_AGE_HOURS * 60 * 60 * 1000),
      live,
      reason: live ? null : plainReason(result.failures, { missingKeyReason }),
      failures: Object.freeze([...result.failures]),
    })];
  });
}

/**
 * Every committed live record under `dir`, verified for `tenantRef` at `now`.
 * `hmacKey` null means no record can verify; `missingKeyReason` says why (for
 * example a key file with loose permissions).
 *
 * @param {{ dir: string, hmacKey?: string | null, tenantRef?: string | null, now?: Date, missingKeyReason?: string }} options
 */
export function loadLiveRecords({ dir, hmacKey = null, tenantRef = null, now = new Date(), missingKeyReason = NO_KEY_REASON }) {
  const options = { hmacKey, tenantRef, now, missingKeyReason };
  return Object.freeze({
    checkedAt: now.toISOString(),
    keyConfigured: Boolean(hmacKey),
    operations: Object.freeze(entraRecords(join(dir, ENTRA_LIVE_SUBDIR), options)),
    workloads: Object.freeze(existsSync(dir) ? workloadRecords(dir, options) : []),
  });
}
