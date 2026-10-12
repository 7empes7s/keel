/**
 * Gap register M6: the company branding files.
 *
 * The branding objects (organizationalBranding, organizationalBrandingLocalization)
 * carry only the paths of their images and stylesheet. The files themselves are
 * streams on their own Graph routes, so they are read here, one GET per locale
 * and file, beside the snapshot, and stored by content hash
 * (engine/store/brandingAssets.mjs). The default branding is locale '0'.
 *
 * Every read is bounded: a file larger than MAX_BRANDING_ASSET_BYTES is
 * recorded 'too-large' and never buffered or stored. A file that is not set
 * (Graph 404, or an empty answer) is recorded 'absent', which is a valid
 * observation, not a failure.
 *
 * Documentation note: learn.microsoft.com is not reachable from the build
 * container. The routes below (GET and PUT
 * /organization/{id}/branding/localizations/{locale}/{file}, with locale 0 for
 * the default branding) are declarations to confirm before live qualification.
 */
import { createHash } from 'node:crypto';

/** The files backed up, and whether each is an image or the stylesheet. */
export const BRANDING_ASSET_KINDS = Object.freeze({
  backgroundImage: Object.freeze({ kind: 'image' }),
  bannerLogo: Object.freeze({ kind: 'image' }),
  squareLogo: Object.freeze({ kind: 'image' }),
  squareLogoDark: Object.freeze({ kind: 'image' }),
  favicon: Object.freeze({ kind: 'image' }),
  customCSS: Object.freeze({ kind: 'stylesheet' }),
});

export const BRANDING_ASSETS = Object.freeze(Object.keys(BRANDING_ASSET_KINDS));

/** Microsoft's own limits are far smaller (tens to hundreds of KB); this only stops a runaway read. */
export const MAX_BRANDING_ASSET_BYTES = 1024 * 1024;

export const DEFAULT_BRANDING_LOCALE = '0';

const DIRECTORY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCALE = /^(0|[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*)$/;

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The stream route of one file of one locale. */
export function brandingAssetPath(organizationId, locale, asset) {
  if (!BRANDING_ASSET_KINDS[asset]) throw new Error(`unknown branding file: ${asset}`);
  if (typeof locale !== 'string' || !LOCALE.test(locale)) throw new Error(`invalid branding locale: ${locale}`);
  return `/organization/${encodeURIComponent(organizationId)}/branding/localizations/${encodeURIComponent(locale)}/${asset}`;
}

/** A Content-Type without parameters, lower case, or null. */
function bareType(value) {
  if (typeof value !== 'string') return null;
  const type = value.split(';')[0].trim().toLowerCase();
  return type.length > 0 ? type : null;
}

/** The image type the bytes themselves show, or null. */
export function sniffImageType(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 4) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01 && bytes[3] === 0x00) return 'image/x-icon';
  return null;
}

/**
 * The Content-Type a file is stored and uploaded with: the stylesheet is always
 * text/css; an image keeps the image type Graph answered with, else the type
 * its bytes show. Null when an image's type cannot be told, so the restore
 * refuses it rather than guessing.
 */
export function brandingContentType(asset, observed, bytes) {
  if (BRANDING_ASSET_KINDS[asset]?.kind === 'stylesheet') return 'text/css';
  const type = bareType(observed);
  if (type && type.startsWith('image/')) return type;
  return sniffImageType(bytes);
}

/**
 * The locales whose files are read: '0' when the snapshot holds the default
 * branding, and each language it holds. Sorted, without duplicates.
 */
export function brandingLocales(collected) {
  const locales = new Set();
  for (const [type, items] of collected ?? []) {
    if (!Array.isArray(items) || items.length === 0) continue;
    if (type === 'organizationalBranding') locales.add(DEFAULT_BRANDING_LOCALE);
    if (type === 'organizationalBrandingLocalization') {
      for (const item of items) if (typeof item?.id === 'string' && LOCALE.test(item.id)) locales.add(item.id);
    }
  }
  return [...locales].sort();
}

/** The directory id read in this run, from the collected organization object. */
export function organizationIdOf(collected) {
  for (const [type, items] of collected ?? []) {
    if (type !== 'organization') continue;
    const id = items?.[0]?.id;
    if (typeof id === 'string' && DIRECTORY_ID.test(id)) return id;
  }
  return null;
}

/**
 * One observation of one file. Outcomes: 'present' (bytes, sha256, size,
 * contentType), 'absent', 'too-large' or 'failed'. Never throws for a Graph
 * answer; only a reader without stream reads is refused.
 */
export async function readBrandingAsset(reader, { organizationId, locale, asset, maxBytes = MAX_BRANDING_ASSET_BYTES }) {
  if (typeof reader?.getStream !== 'function') throw new Error('the reader cannot read file streams');
  const path = brandingAssetPath(organizationId, locale, asset);
  const base = { locale, asset, path };
  let result;
  try {
    result = await reader.getStream('v1.0', path, { maxBytes });
  } catch (error) {
    return { ...base, outcome: 'failed', httpStatus: null, error: String(error?.message ?? error).slice(0, 300) };
  }
  if (result?.ok !== true) {
    if (result?.status === 404) return { ...base, outcome: 'absent', httpStatus: 404 };
    return {
      ...base, outcome: 'failed', httpStatus: Number.isInteger(result?.status) ? result.status : null,
      error: String(result?.error ?? `HTTP ${result?.status ?? 'unknown'}`).slice(0, 300),
    };
  }
  if (result.tooLarge) return { ...base, outcome: 'too-large', httpStatus: result.status, error: `larger than ${maxBytes} bytes` };
  const bytes = Buffer.isBuffer(result.bytes) ? result.bytes : Buffer.from(result.bytes ?? []);
  if (bytes.length === 0) return { ...base, outcome: 'absent', httpStatus: result.status };
  return {
    ...base,
    outcome: 'present',
    httpStatus: result.status,
    bytes,
    sha256: sha256Hex(bytes),
    size: bytes.length,
    contentType: brandingContentType(asset, result.contentType, bytes),
  };
}

/** Every file of every locale, one read each, in a stable order. */
export async function collectBrandingAssets(reader, { organizationId, locales, maxBytes = MAX_BRANDING_ASSET_BYTES }) {
  if (typeof organizationId !== 'string' || !DIRECTORY_ID.test(organizationId)) {
    throw new Error('branding files are read under the directory id, and none was observed');
  }
  const observations = [];
  for (const locale of locales) {
    for (const asset of BRANDING_ASSETS) {
      observations.push(await readBrandingAsset(reader, { organizationId, locale, asset, maxBytes }));
    }
  }
  return observations;
}
