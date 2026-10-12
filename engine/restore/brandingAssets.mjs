/**
 * Gap register M6: restore of the company branding files.
 *
 * The snapshot holds each file (background image, banner logo, square logo
 * and its dark variant, favicon, custom stylesheet) of the default branding
 * (locale '0') and of each language, by content hash
 * (engine/store/brandingAssets.mjs). A restore compares each backed-up file
 * with the live one by SHA-256 and uploads only the ones that differ, with PUT
 * on the file's own route and the file's own Content-Type (text/css for the
 * stylesheet). Each upload is journaled first and read back afterwards; it
 * counts only when the live file then has the backed-up hash.
 *
 * What is never done: a language that does not exist live is not created (a
 * refusal); a file the backup did not hold (not set, too large or unreadable)
 * is never removed from or written to the tenant (a note); stored bytes whose
 * hash does not match their record are never sent (a refusal).
 */
import {
  BRANDING_ASSETS, DEFAULT_BRANDING_LOCALE, MAX_BRANDING_ASSET_BYTES, brandingAssetPath, readBrandingAsset, sha256Hex,
} from '../collect/brandingAssets.mjs';
import { BRANDING_FILE_CAPABILITY, capabilityFor, isSupportedClaim } from '../coverage/capabilities.mjs';
import { retryThrottledGraphOperation } from './applyEngine.mjs';
import { classifyWriteOutcome, recordPriorState, recordWriteOutcome } from './rollbackJournal.mjs';

export const BRANDING_RESOURCE_TYPES = Object.freeze(['organizationalBranding', 'organizationalBrandingLocalization']);

const FILE_LABEL = Object.freeze({
  backgroundImage: 'background image',
  bannerLogo: 'banner logo',
  squareLogo: 'square logo',
  squareLogoDark: 'dark square logo',
  favicon: 'favicon',
  customCSS: 'custom stylesheet',
});

/** The locale a branding resource's files live under, or null for another type. */
export function brandingLocaleFor(resource) {
  if (resource?.resourceType === 'organizationalBranding') return DEFAULT_BRANDING_LOCALE;
  if (resource?.resourceType !== 'organizationalBrandingLocalization') return null;
  const id = resource.payload?.id ?? String(resource.naturalKey ?? '').split(':').slice(1).join(':');
  return typeof id === 'string' && id.length > 0 ? id : null;
}

export function brandingFileKey(locale, asset) {
  return `${BRANDING_FILE_CAPABILITY}:${locale}/${asset}`;
}

function languageLabel(locale) {
  return locale === DEFAULT_BRANDING_LOCALE ? 'the default branding' : `language ${locale}`;
}

function capabilitySupported() {
  return isSupportedClaim(capabilityFor(BRANDING_FILE_CAPABILITY, 'update').claim);
}

/**
 * Reads the live file of every backed-up locale and file. `locales` are the
 * locales to read; returns a Map `${locale}|${asset}` -> observation (bytes
 * dropped: only the hash is kept).
 */
export async function readLiveBrandingAssets(reader, { organizationId, locales, maxBytes = MAX_BRANDING_ASSET_BYTES }) {
  const live = new Map();
  for (const locale of locales) {
    for (const asset of BRANDING_ASSETS) {
      const { bytes, ...observation } = await readBrandingAsset(reader, { organizationId, locale, asset, maxBytes });
      live.set(`${locale}|${asset}`, observation);
    }
  }
  return live;
}

/**
 * The uploads a restore needs. `desired` is the snapshot's file rows
 * (loadSnapshotBrandingAssets), `live` the Map from readLiveBrandingAssets,
 * `liveLocales` the locales whose branding exists in the target.
 *
 * Returns { uploads, unchanged, refusals, notes }. An upload carries its bytes
 * but `digestInput` (locale, file, hash, size, type) is what binds a dry run.
 */
export function planBrandingAssetUploads({ desired, live, liveLocales }) {
  const uploads = [];
  const unchanged = [];
  const refusals = [];
  const notes = [];
  const supported = capabilitySupported();
  for (const row of desired ?? []) {
    const naturalKey = brandingFileKey(row.locale, row.asset);
    const label = `the ${FILE_LABEL[row.asset] ?? row.asset} of ${languageLabel(row.locale)}`;
    if (row.outcome !== 'present') {
      const current = live.get(`${row.locale}|${row.asset}`);
      if (row.outcome === 'absent') {
        if (current?.outcome === 'present') notes.push({ naturalKey, note: `the backup had no ${FILE_LABEL[row.asset] ?? row.asset} for ${languageLabel(row.locale)}; the live one is kept (removing it is by hand)` });
      } else {
        notes.push({ naturalKey, note: `${label} was not backed up (${row.outcome === 'too-large' ? 'too large' : 'the read failed'}), so it is not restored` });
      }
      continue;
    }
    if (!supported) {
      refusals.push({ naturalKey, reason: `unsupported operation: ${BRANDING_FILE_CAPABILITY} update is not a registered write capability` });
      continue;
    }
    if (!Buffer.isBuffer(row.bytes) || sha256Hex(row.bytes) !== row.sha256 || row.bytes.length !== row.size) {
      refusals.push({ naturalKey, reason: `integrity: the stored copy of ${label} does not match its recorded hash, so it is not uploaded` });
      continue;
    }
    if (typeof row.contentType !== 'string' || row.contentType.length === 0) {
      refusals.push({ naturalKey, reason: `${label} has no known file type, so it is not uploaded` });
      continue;
    }
    if (!liveLocales.has(row.locale)) {
      refusals.push({ naturalKey, reason: `dependency: ${languageLabel(row.locale)} does not exist in the tenant; add it by hand first` });
      continue;
    }
    const current = live.get(`${row.locale}|${row.asset}`);
    if (!current || (current.outcome !== 'present' && current.outcome !== 'absent')) {
      refusals.push({ naturalKey, reason: `blocked-read: the live ${FILE_LABEL[row.asset] ?? row.asset} of ${languageLabel(row.locale)} could not be read${current?.httpStatus ? ` (HTTP ${current.httpStatus})` : ''}, so it is not replaced` });
      continue;
    }
    if (current.outcome === 'present' && current.sha256 === row.sha256) {
      unchanged.push({ naturalKey, locale: row.locale, asset: row.asset, sha256: row.sha256 });
      continue;
    }
    uploads.push({
      naturalKey,
      locale: row.locale,
      asset: row.asset,
      sha256: row.sha256,
      size: row.size,
      contentType: row.contentType,
      liveSha256: current.outcome === 'present' ? current.sha256 : null,
      bytes: row.bytes,
    });
  }
  return { uploads, unchanged, refusals, notes };
}

/** What of an upload plan is bound into a dry run's digest: never the bytes. */
export function brandingUploadDigestInput(uploads) {
  return (uploads ?? []).map(({ locale, asset, sha256, size, contentType, liveSha256 }) => ({
    locale, asset, sha256, size, contentType, liveSha256,
  }));
}

async function journal(rollbackClient, { runId, restoreRef, upload }) {
  if (!rollbackClient) return { ok: true, entryId: null };
  try {
    const priorState = { kind: 'branding-file', locale: upload.locale, asset: upload.asset, sha256: upload.liveSha256 };
    const entryId = await recordPriorState(rollbackClient, restoreRef
      ? {
        runId, naturalKey: upload.naturalKey, priorState, restoreRef, resourceType: BRANDING_FILE_CAPABILITY,
        operation: 'update', targetId: null, blastRadius: 'cosmetic',
        intendedState: { kind: 'branding-file', locale: upload.locale, asset: upload.asset, sha256: upload.sha256, size: upload.size, contentType: upload.contentType },
      }
      : { runId, naturalKey: upload.naturalKey, priorState });
    return { ok: true, entryId: restoreRef ? entryId : null };
  } catch {
    return { ok: false, entryId: null };
  }
}

async function note(rollbackClient, entry, outcome, extras = {}) {
  if (!rollbackClient || !entry?.entryId) return;
  try {
    await recordWriteOutcome(rollbackClient, { entryId: entry.entryId, outcome, ...extras });
  } catch {
    // left pending; compensation treats it as uncertain
  }
}

/**
 * Uploads each planned file and reads it back. Dry run: nothing is read or
 * written. Returns { applied, failed } in the restore's result shape.
 */
export async function applyBrandingAssetUploads(writer, uploads, {
  reader, mode, targetTenant, rollbackClient = null, runId = null, restoreRef = null,
  governor = null, maxBytes = MAX_BRANDING_ASSET_BYTES,
} = {}) {
  // A throttled upload (429/503) waits and is retried through the shared governor.
  const retryOperation = governor
    ? (operation) => retryThrottledGraphOperation(operation, { governor, targetTenant })
    : (operation) => operation();
  const applied = [];
  const failed = [];
  for (const upload of uploads ?? []) {
    const { naturalKey } = upload;
    if (!capabilitySupported()) {
      failed.push({ naturalKey, error: `unsupported operation: ${BRANDING_FILE_CAPABILITY} update is not a registered write capability` });
      continue;
    }
    if (mode === 'dry-run') {
      applied.push({ naturalKey, brandingFile: { locale: upload.locale, asset: upload.asset, sha256: upload.sha256 } });
      continue;
    }
    if (!Buffer.isBuffer(upload.bytes) || sha256Hex(upload.bytes) !== upload.sha256) {
      failed.push({ naturalKey, error: 'integrity: the file to upload does not match its recorded hash' });
      continue;
    }
    let path;
    try {
      path = brandingAssetPath(targetTenant, upload.locale, upload.asset);
    } catch (error) {
      failed.push({ naturalKey, error: error.message });
      continue;
    }
    const entry = await journal(rollbackClient, { runId, restoreRef, upload });
    if (!entry.ok) {
      failed.push({ naturalKey, error: 'refusing to upload: rollback journal write failed' });
      continue;
    }
    const result = await retryOperation(() => writer.putStream('v1.0', path, { body: upload.bytes, contentType: upload.contentType }));
    if (result?.ok !== true) {
      await note(rollbackClient, entry, classifyWriteOutcome(result), { detail: `status ${result?.status ?? 'none'}` });
      failed.push({ naturalKey, error: `upload failed${result?.status ? ` (HTTP ${result.status})` : ''}` });
      continue;
    }
    const after = await readBrandingAsset(reader, { organizationId: targetTenant, locale: upload.locale, asset: upload.asset, maxBytes });
    const postState = { kind: 'branding-file', locale: upload.locale, asset: upload.asset, sha256: after.sha256 ?? null, outcome: after.outcome };
    if (after.outcome !== 'present' || after.sha256 !== upload.sha256) {
      await note(rollbackClient, entry, 'uncertain', { postState, detail: 'branding file did not read back as uploaded' });
      failed.push({ naturalKey, error: 'post-state: the uploaded file did not read back as written' });
      continue;
    }
    await note(rollbackClient, entry, 'succeeded', { postState });
    applied.push({ naturalKey, brandingFile: { locale: upload.locale, asset: upload.asset, sha256: upload.sha256 } });
  }
  return { applied, failed };
}
