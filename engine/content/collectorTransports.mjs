/**
 * Adapts the content transport (./transport.mjs, `transport(url, { as, headers })`) to
 * the shapes the Wave 1 collectors were written against. Every adapter still goes
 * through the content transport, so every request stays a Graph GET.
 *
 *   graphTransport(transport)  -> (url, { method, headers }) -> { status, headers, body }
 *       SITES, TEAMS, PLANNER. A file download (a path ending in /content) is read as a
 *       stream, everything else as JSON.
 *   driveTransport(transport)  -> ({ method, url, headers }) -> { status, headers, body }
 *       DRIVE (syncDrive, resolveUserDrive).
 *   mailReader(transport)      -> { get(version, path), getStream(version, path, { maxBytes }) }
 *       MAIL. Answers { ok, status, body, code, error } like the tenant-probe GraphReader,
 *       and waits out 429/503 with Retry-After, which the mail sync does not do itself.
 */
export const GRAPH_ORIGIN = 'https://graph.microsoft.com';
const RETRY_STATUSES = new Set([429, 503]);

const isFileDownload = (url) => /\/content$/i.test(new URL(url).pathname);

export function graphTransport(transport) {
  if (typeof transport !== 'function') throw new TypeError('a content transport is required');
  return (url, { method = 'GET', headers = {}, as } = {}) => transport(url, {
    method, headers, as: as ?? (isFileDownload(url) ? 'stream' : 'json'),
  });
}

export function driveTransport(transport) {
  const send = graphTransport(transport);
  return ({ method = 'GET', url, headers = {} } = {}) => send(url, { method, headers });
}

function discard(body) {
  if (typeof body?.destroy === 'function') body.destroy();
}

async function readBounded(body, maxBytes) {
  const parts = [];
  let size = 0;
  for await (const part of body ?? []) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
    size += chunk.length;
    if (size > maxBytes) {
      discard(body);
      return { tooLarge: true };
    }
    parts.push(chunk);
  }
  return { bytes: Buffer.concat(parts) };
}

function failure(response, body = response?.body) {
  const error = body?.error ?? {};
  return { ok: false, status: response?.status ?? 0, code: error.code, error: error.message ?? `HTTP ${response?.status}` };
}

export function mailReader(transport, { sleep = async () => {}, maxRetries = 5 } = {}) {
  const send = graphTransport(transport);
  const urlFor = (version, path) => (/^https:\/\//i.test(path) ? path : `${GRAPH_ORIGIN}/${version}${path}`);

  async function request(url, as) {
    for (let attempt = 0; ; attempt += 1) {
      const response = await send(url, { as });
      if (!RETRY_STATUSES.has(response?.status) || attempt >= maxRetries) return response;
      if (as === 'stream') discard(response.body);
      const seconds = Number(response.headers?.['retry-after']);
      await sleep(Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 2 ** attempt * 1000);
    }
  }

  // A refused request (outside Graph, not a read) answers like a failed read, so the
  // mail sync records it against the mailbox instead of stopping the whole run.
  const refused = (error) => ({ ok: false, status: 0, code: 'Refused', error: String(error?.message ?? error) });

  return Object.freeze({
    async get(version, path) {
      let response;
      try {
        response = await request(urlFor(version, path), 'json');
      } catch (error) {
        return refused(error);
      }
      if (response.status >= 200 && response.status < 300) return { ok: true, status: response.status, body: response.body };
      return failure(response);
    },
    async getStream(version, path, { maxBytes } = {}) {
      if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new TypeError('getStream needs a positive maxBytes');
      let response;
      try {
        response = await request(urlFor(version, path), 'stream');
      } catch (error) {
        return refused(error);
      }
      const contentType = response.headers?.['content-type'] ?? null;
      if (response.status < 200 || response.status >= 300) {
        const read = await readBounded(response.body, 64 * 1024);
        let body = null;
        try { body = JSON.parse(read.bytes?.toString('utf8') ?? ''); } catch { body = null; }
        return failure(response, body);
      }
      const declared = Number(response.headers?.['content-length']);
      if (Number.isFinite(declared) && declared > maxBytes) {
        discard(response.body);
        return { ok: true, status: response.status, tooLarge: true, contentType };
      }
      const read = await readBounded(response.body, maxBytes);
      if (read.tooLarge) return { ok: true, status: response.status, tooLarge: true, contentType };
      return { ok: true, status: response.status, bytes: read.bytes, contentType };
    },
  });
}
