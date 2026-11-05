/**
 * Issue #1007: the files (PDFs) of each terms of use agreement.
 *
 * The catalog reads an agreement with its files (`?$expand=files`, one
 * agreementFileLocalization per language). The PDF bytes are never kept in
 * the snapshot payload: each file's `fileData` is replaced by its SHA-256 and
 * size, so the payload hash (and drift) changes when a PDF changes, and the
 * bytes are stored once per tenant and hash (engine/store/agreementFiles.mjs).
 *
 *  - `fileData: { sha256, size }`: the file was returned and is stored.
 *  - `fileData: { tooLarge: true, size }`: returned, over the size bound, not stored.
 *  - `fileData: null`: Graph returned no bytes for it (its reference shows
 *    fileData null), so a restore cannot upload it and says so.
 */
import { createHash } from 'node:crypto';

const AGREEMENT_TYPE = 'agreement';
// Entra limits a terms of use PDF to well under this; a larger one is not stored.
const MAX_AGREEMENT_FILE_BYTES = 20 * 1024 * 1024;

export const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** One file with its bytes replaced by their digest, and the bytes to store (or null). */
function digestAgreementFile(file) {
  if (!file || typeof file !== 'object') return { file, blob: null };
  const data = file.fileData?.data;
  const bytes = typeof data === 'string' && data.length > 0 ? Buffer.from(data, 'base64') : null;
  if (!bytes || bytes.length === 0) return { file: { ...file, fileData: null }, blob: null };
  if (bytes.length > MAX_AGREEMENT_FILE_BYTES) return { file: { ...file, fileData: { tooLarge: true, size: bytes.length } }, blob: null };
  const sha256 = sha256Hex(bytes);
  return { file: { ...file, fileData: { sha256, size: bytes.length } }, blob: { sha256, size: bytes.length, bytes } };
}

/**
 * The collected kinds with every agreement's files digested, and the bytes to
 * store: { collected, blobs } (one blob per distinct hash). Other kinds are
 * returned as they are.
 */
export function digestAgreementFiles(collected) {
  const blobs = new Map();
  const out = [...collected].map(([type, objects]) => {
    if (type !== AGREEMENT_TYPE) return [type, objects];
    return [type, objects.map((agreement) => {
      if (!Array.isArray(agreement?.files)) return agreement;
      const files = agreement.files.map((file) => {
        const { file: digested, blob } = digestAgreementFile(file);
        if (blob) blobs.set(blob.sha256, blob);
        return digested;
      });
      return { ...agreement, files };
    })];
  });
  return { collected: out, blobs: [...blobs.values()] };
}
