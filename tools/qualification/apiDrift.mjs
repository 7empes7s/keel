#!/usr/bin/env node
// /opt/keel/tools/qualification/apiDrift.mjs
//
// node apiDrift.mjs --config /etc/keel/tenant.json [--db-url $KEEL_DB_URL]
//                   [--sources sources.json] [--timeout-ms 30000] [--max-bytes 33554432]
//
// Bounded, scheduled comparison of the configured official Microsoft Graph
// metadata/OpenAPI sources against the explicit catalog mappings in
// tools/tenant-probe/catalog.mjs (roadmap task-62). Each downloaded source is
// pinned by sha256 digest, HTTP Date, ETag and the metadata document's own
// version; the parsed model is diffed by engine/coverage/catalogDrift.mjs and
// the findings persist as REVIEW CANDIDATES ONLY — this tool never registers
// types, permissions or write verbs, and a changed field never becomes
// writable.
//
// Bounds and failure semantics (the acceptance pins these):
// - every fetch is time-bounded (AbortController) and size-bounded (both the
//   Content-Length header and the streamed body); a timeout or oversized
//   source is recorded as its own visible status, never silently swallowed;
// - a 304 (If-None-Match against the pinned ETag) is a proven no-change;
// - a network failure, non-2xx response or unparsable body is UNKNOWN — the
//   previously pinned digest/model is retained and the run exits non-zero so
//   the failure is visible in the job queue; it is never equated with
//   "no changes";
// - re-fetching unchanged metadata inserts zero new candidates (dedupe by
//   finding identity in catalogDrift.mjs).
//
// Tests inject fetchImpl; the real run uses globalThis.fetch. This tool sends
// no credentials anywhere — the metadata endpoints are anonymous — and never
// touches the tenant.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { CATALOG } from '../tenant-probe/catalog.mjs';
import { connect } from '../../engine/store/db.mjs';
import { tenantRefFor } from '../../engine/store/tenantRef.mjs';
import {
  buildComparisonModel, diffCatalog, listCandidates, loadSourceState,
  persistCandidates, recordSourceState,
} from '../../engine/coverage/catalogDrift.mjs';

// The configured official sources. `catalogVersion` binds a source to the
// catalog entries it is compared against; a source config file (--sources)
// uses this exact shape. Only https URLs are accepted — the check refuses a
// plaintext or scheme-less endpoint before any request is made.
export const DEFAULT_SOURCES = Object.freeze([
  Object.freeze({
    key: 'graph-csdl-v1.0',
    url: 'https://graph.microsoft.com/v1.0/$metadata',
    format: 'csdl',
    catalogVersion: 'v1.0',
  }),
  Object.freeze({
    key: 'graph-csdl-beta',
    url: 'https://graph.microsoft.com/beta/$metadata',
    format: 'csdl',
    catalogVersion: 'beta',
  }),
]);

export const DEFAULT_TIMEOUT_MS = 30 * 1000;
// The real v1.0 CSDL document is ~1.5 MB and beta ~4 MB; 32 MB is far above
// any legitimate metadata document and far below anything that could pressure
// the worker host. The bound is enforced on Content-Length AND the stream.
export const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

export const SOURCE_STATUSES = Object.freeze(['fetched', 'not-modified', 'unknown', 'timeout', 'oversized']);

function requireSource(source) {
  if (!source || typeof source !== 'object') throw new TypeError('a source must be an object');
  for (const field of ['key', 'url', 'format', 'catalogVersion']) {
    if (typeof source[field] !== 'string' || source[field].length === 0) {
      throw new TypeError(`source.${field} must be a non-empty string`);
    }
  }
  if (!source.url.startsWith('https://')) {
    throw new TypeError(`source ${source.key}: only https URLs are accepted`);
  }
  if (!['csdl', 'openapi'].includes(source.format)) {
    throw new TypeError(`source ${source.key}: format must be csdl or openapi`);
  }
  return source;
}

/**
 * One bounded conditional GET. Returns a discriminated result and NEVER
 * throws for a transport/HTTP failure:
 *   { status: 'fetched', body, digest, etag, date }
 *   { status: 'not-modified' }
 *   { status: 'timeout' | 'oversized' | 'unknown', error }
 */
export async function fetchMetadataSource({
  url,
  etag = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = DEFAULT_MAX_BYTES,
  fetchImpl = globalThis.fetch,
}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be a positive integer');
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new TypeError('maxBytes must be a positive integer');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required');

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const headers = { Accept: 'application/xml, application/json' };
    if (etag) headers['If-None-Match'] = etag;
    const response = await fetchImpl(url, { headers, signal: controller.signal });

    // 304: the pinned ETag still identifies the current document — a PROVEN
    // no-change, distinct from an unknown fetch.
    if (response.status === 304) return { status: 'not-modified' };
    if (!(response.status >= 200 && response.status < 300)) {
      return { status: 'unknown', error: `HTTP ${response.status} from ${url}` };
    }

    const declared = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      return { status: 'oversized', error: `content-length ${declared} exceeds the ${maxBytes}-byte limit` };
    }

    let body;
    try {
      body = await readBoundedBody(response, maxBytes);
    } catch (error) {
      if (error?.name === 'OversizedBodyError') return { status: 'oversized', error: error.message };
      if (timedOut || error?.name === 'AbortError') {
        return { status: 'timeout', error: `timed out after ${timeoutMs}ms` };
      }
      return { status: 'unknown', error: `reading body failed: ${error?.message ?? String(error)}` };
    }

    return {
      status: 'fetched',
      body,
      digest: createHash('sha256').update(body).digest('hex'),
      etag: response.headers?.get?.('etag') ?? null,
      date: response.headers?.get?.('date') ?? null,
    };
  } catch (error) {
    if (timedOut || error?.name === 'AbortError') {
      return { status: 'timeout', error: `timed out after ${timeoutMs}ms` };
    }
    // A network failure is UNKNOWN — the caller must keep the previous pin and
    // must not read this as "no changes".
    return { status: 'unknown', error: `fetch failed: ${error?.message ?? String(error)}` };
  } finally {
    clearTimeout(timer);
  }
}

class OversizedBodyError extends Error {
  constructor(total, maxBytes) {
    super(`body exceeded the ${maxBytes}-byte limit (>${total} bytes read)`);
    this.name = 'OversizedBodyError';
  }
}

// Streams the body in chunks and aborts the read the moment the running total
// crosses maxBytes — the digest is computed only over a body that fit, so a
// mutation that dropped the size check would let an unbounded body through
// here and fail the oversized-fixture tests.
async function readBoundedBody(response, maxBytes) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    // Fake-fetch convenience: a text() body is still size-checked before use.
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new OversizedBodyError(Buffer.byteLength(text, 'utf8'), maxBytes);
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new OversizedBodyError(total, maxBytes);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function shortTypeName(typeRef) {
  if (typeof typeRef !== 'string') return null;
  const inner = typeRef.replace(/^Collection\((.*)\)$/, '$1');
  const dot = inner.lastIndexOf('.');
  return dot === -1 ? inner : inner.slice(dot + 1);
}

function attribute(tag, name) {
  const match = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
  return match ? match[1] : null;
}

/**
 * Minimal CSDL extraction: EntitySet and Singleton names (with their entity
 * type), and EntityType property signatures (name -> { type, nullable };
 * CSDL defaults Nullable to true). This is intentionally NOT a general XML
 * parser — it reads the flat, well-known shapes of a Graph $metadata document,
 * and anything it cannot parse fails the whole parse so the source reads
 * UNKNOWN rather than diffing a half-read model. BaseType inheritance,
 * complex types and function imports are out of scope (docs/roadmap/
 * api-drift.md records the limitation).
 */
export function parseCsdl(xml) {
  if (typeof xml !== 'string' || !xml.includes('<') || !/<(\w+:)?Schema[\s>]/.test(xml)) {
    throw new Error('not a CSDL metadata document (no Schema element)');
  }
  const version = attribute(xml.match(/<(\w+:)?Edmx[\s>][^>]*>/)?.[0] ?? '', 'Version');

  const endpoints = new Map();
  for (const match of xml.matchAll(/<(\w+:)?EntitySet\s[^>]*>/g)) {
    const name = attribute(match[0], 'Name');
    const entityType = shortTypeName(attribute(match[0], 'EntityType'));
    if (!name || !entityType) throw new Error('malformed EntitySet element (Name/EntityType required)');
    endpoints.set(name, entityType);
  }
  for (const match of xml.matchAll(/<(\w+:)?Singleton\s[^>]*>/g)) {
    const name = attribute(match[0], 'Name');
    const entityType = shortTypeName(attribute(match[0], 'Type'));
    if (!name || !entityType) throw new Error('malformed Singleton element (Name/Type required)');
    endpoints.set(name, entityType);
  }

  const types = new Map();
  for (const match of xml.matchAll(/<(\w+:)?EntityType\s[^>]*>([\s\S]*?)<\/(\w+:)?EntityType>/g)) {
    const name = attribute(match[0].slice(0, match[0].indexOf('>') + 1), 'Name');
    if (!name) throw new Error('malformed EntityType element (Name required)');
    const fields = new Map();
    for (const property of match[2].matchAll(/<(\w+:)?Property\s[^>]*>/g)) {
      const fieldName = attribute(property[0], 'Name');
      const type = attribute(property[0], 'Type');
      if (!fieldName || !type) throw new Error(`malformed Property in EntityType ${name}`);
      fields.set(fieldName, { type, nullable: attribute(property[0], 'Nullable') !== 'false' });
    }
    for (const navigation of match[2].matchAll(/<(\w+:)?NavigationProperty\s[^>]*>/g)) {
      const fieldName = attribute(navigation[0], 'Name');
      const type = attribute(navigation[0], 'Type');
      if (!fieldName || !type) throw new Error(`malformed NavigationProperty in EntityType ${name}`);
      fields.set(fieldName, { type, nullable: attribute(navigation[0], 'Nullable') !== 'false' });
    }
    types.set(name, { fields });
  }
  if (endpoints.size === 0) throw new Error('CSDL document declares no EntitySet or Singleton');
  return { version, endpoints, types };
}

/**
 * OpenAPI sources contribute endpoint paths only: the normalized model maps
 * each path's last literal segment to a null entity type, so they take part in
 * added/removed-endpoint diffs but carry no field signatures (a documented
 * limitation — field-level diffing is CSDL-only today).
 */
export function parseOpenApi(text) {
  let document;
  try {
    document = JSON.parse(text);
  } catch (error) {
    throw new Error(`not an OpenAPI JSON document: ${error.message}`);
  }
  if (!document || typeof document !== 'object' || typeof document.paths !== 'object' || document.paths === null) {
    throw new Error('not an OpenAPI document (no paths object)');
  }
  const endpoints = new Map();
  for (const path of Object.keys(document.paths)) {
    const segments = path.split('/').filter((segment) => segment.length > 0 && !segment.startsWith('{'));
    if (segments.length > 0) endpoints.set(segments[segments.length - 1], null);
  }
  return { version: document.info?.version ?? null, endpoints, types: new Map() };
}

export function parseSource(format, body) {
  if (format === 'csdl') return parseCsdl(body);
  if (format === 'openapi') return parseOpenApi(body);
  throw new TypeError(`unknown source format: ${format}`);
}

/**
 * Runs one comparison pass over all configured sources against the tenant's
 * persisted pins. Returns { results, ok }; ok is false when ANY source read
 * as timeout/oversized/unknown, so the worker job fails visibly instead of
 * recording a silent no-op run.
 */
export async function runApiDrift({
  client,
  tenantRef,
  sources = DEFAULT_SOURCES,
  fetchImpl,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = DEFAULT_MAX_BYTES,
  catalog = CATALOG,
  now = new Date(),
}) {
  const results = [];
  for (const raw of sources) {
    const source = requireSource(raw);
    const prior = await loadSourceState(client, { tenantRef, sourceKey: source.key });
    const fetched = await fetchMetadataSource({
      url: source.url, etag: prior?.etag ?? null, timeoutMs, maxBytes, fetchImpl,
    });

    if (fetched.status === 'not-modified') {
      await recordSourceState(client, {
        tenantRef, sourceKey: source.key, url: source.url,
        outcome: { status: 'not-modified', etag: prior?.etag ?? null },
      });
      results.push({ source: source.key, status: 'not-modified', candidates: 0, inserted: 0 });
      continue;
    }

    if (fetched.status !== 'fetched') {
      // timeout / oversized / unknown: the pin is retained untouched, the
      // status and error are recorded, and the run fails visibly. Nothing here
      // is ever read as "no changes".
      await recordSourceState(client, {
        tenantRef, sourceKey: source.key, url: source.url,
        outcome: { status: fetched.status, error: fetched.error },
      });
      results.push({ source: source.key, status: fetched.status, error: fetched.error, candidates: 0, inserted: 0 });
      continue;
    }

    let parsed;
    try {
      parsed = parseSource(source.format, fetched.body);
    } catch (error) {
      await recordSourceState(client, {
        tenantRef, sourceKey: source.key, url: source.url,
        outcome: { status: 'unknown', error: `unparsable metadata: ${error.message}` },
      });
      results.push({ source: source.key, status: 'unknown', error: error.message, candidates: 0, inserted: 0 });
      continue;
    }

    const model = buildComparisonModel(parsed, catalog, source.catalogVersion);

    // A 200 whose bytes are identical to the pinned digest is a proven
    // no-change even when the server sent no ETag — same handling as a 304,
    // with the fresh ETag adopted for future conditional requests.
    if (prior?.digest && prior.digest === fetched.digest) {
      await recordSourceState(client, {
        tenantRef, sourceKey: source.key, url: source.url,
        outcome: { status: 'not-modified', etag: fetched.etag },
      });
      results.push({ source: source.key, status: 'not-modified', candidates: 0, inserted: 0 });
      continue;
    }

    const findings = diffCatalog({
      previous: prior?.model ?? null,
      current: model,
      catalog,
      catalogVersion: source.catalogVersion,
    });
    const proof = {
      sourceUrl: source.url,
      digest: fetched.digest,
      etag: fetched.etag,
      sourceDate: fetched.date,
      metadataVersion: model.version,
      fetchedAt: now.toISOString(),
    };
    const inserted = await persistCandidates(client, {
      tenantRef, sourceKey: source.key, sourceUrl: source.url, findings, proof,
    });
    await recordSourceState(client, {
      tenantRef, sourceKey: source.key, url: source.url,
      outcome: {
        status: 'fetched',
        etag: fetched.etag,
        digest: fetched.digest,
        sourceDate: fetched.date,
        metadataVersion: model.version,
        model,
        changed: true,
      },
    });
    results.push({ source: source.key, status: 'fetched', candidates: findings.length, inserted });
  }

  return { tenantRef, results, ok: results.every((result) => result.status === 'fetched' || result.status === 'not-modified') };
}

function arg(name, fallback, argv = process.argv) {
  const i = argv.indexOf(`--${name}`);
  return i > -1 ? argv[i + 1] : fallback;
}

export async function runApiDriftCli({
  config,
  dbUrl = process.env.KEEL_DB_URL,
  sourcesPath,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = DEFAULT_MAX_BYTES,
  readFile = readFileSync,
  dependencies = {},
  logger = console,
}) {
  const { connect: connectFn = connect, fetchImpl } = dependencies;
  if (!dbUrl) throw new Error('KEEL_DB_URL not set (source /etc/keel/db.env or pass --db-url)');
  const tenantRef = tenantRefFor(config.tenantId);
  const sources = sourcesPath
    ? JSON.parse(readFile(sourcesPath, 'utf8'))
    : DEFAULT_SOURCES;
  if (!Array.isArray(sources) || sources.length === 0) {
    throw new Error('sources must be a non-empty array');
  }
  const client = await connectFn(dbUrl);
  try {
    const { results, ok } = await runApiDrift({
      client, tenantRef, sources, fetchImpl, timeoutMs, maxBytes,
    });
    for (const result of results) {
      const suffix = result.error ? ` — ${result.error}` : ` — ${result.candidates} candidate(s), ${result.inserted} new`;
      logger.log(`${result.source}: ${result.status}${suffix}`);
    }
    const candidates = await listCandidates(client, { tenantRef });
    logger.log(`api drift candidates open for review: ${candidates.length}`);
    return { results, candidates, exitCode: ok ? 0 : 1 };
  } finally {
    await client.end();
  }
}

export async function main({
  argv = process.argv,
  readFile = readFileSync,
  dependencies,
  logger = console,
} = {}) {
  if (argv.includes('--help')) {
    logger.log('usage: apiDrift.mjs --config /etc/keel/tenant.json [--db-url $KEEL_DB_URL] [--sources sources.json] [--timeout-ms 30000] [--max-bytes 33554432]');
    return 0;
  }
  const timeoutMs = Number(arg('timeout-ms', DEFAULT_TIMEOUT_MS, argv));
  const maxBytes = Number(arg('max-bytes', DEFAULT_MAX_BYTES, argv));
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('--timeout-ms must be a positive integer');
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('--max-bytes must be a positive integer');
  const config = JSON.parse(readFile(arg('config', '/etc/keel/tenant.json', argv), 'utf8'));
  const dbUrl = arg('db-url', process.env.KEEL_DB_URL, argv);
  const sourcesPath = arg('sources', undefined, argv);
  const { exitCode } = await runApiDriftCli({
    config, dbUrl, sourcesPath, timeoutMs, maxBytes, readFile, dependencies, logger,
  });
  return exitCode;
}

export async function runCli(options = {}) {
  try {
    return await main(options);
  } catch (err) {
    (options.logger ?? console).error(err);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().then((exitCode) => { process.exitCode = exitCode; });
}
