/**
 * Wave 1 DISC: the only way discovery reaches Microsoft Graph.
 *
 * It can only read. A request that is not a GET, carries a body, or goes to any host
 * but graph.microsoft.com is refused before it is sent, and the token never leaves
 * the closure. 429 and 503 answers are retried after the full Retry-After.
 * A body larger than `maxBytes` is never buffered whole.
 */

export const GRAPH_ORIGIN = 'https://graph.microsoft.com';
export const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_RETRIES = 4;

export class DiscoveryWriteRefused extends Error {
  constructor(message) {
    super(message);
    this.name = 'DiscoveryWriteRefused';
  }
}

/** Throws unless the request is a body-less GET to Microsoft Graph. */
export function assertReadOnly(url, init = {}) {
  const method = String(init?.method ?? 'GET').toUpperCase();
  if (method !== 'GET' || init?.body !== undefined) throw new DiscoveryWriteRefused(`discovery is read-only: refused ${method} ${url}`);
  let origin;
  try {
    origin = new URL(url).origin;
  } catch {
    throw new DiscoveryWriteRefused(`discovery reads Microsoft Graph only: refused ${url}`);
  }
  if (origin !== GRAPH_ORIGIN) throw new DiscoveryWriteRefused(`discovery reads Microsoft Graph only: refused ${url}`);
  return true;
}

async function readBounded(response, maxBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel?.().catch(() => {});
    return { tooLarge: true, text: null };
  }
  if (!response.body || typeof response.body.getReader !== 'function') {
    const text = await response.text();
    return Buffer.byteLength(text) > maxBytes ? { tooLarge: true, text: null } : { tooLarge: false, text };
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
      return { tooLarge: true, text: null };
    }
    chunks.push(Buffer.from(value));
  }
  return { tooLarge: false, text: Buffer.concat(chunks).toString('utf8') };
}

/**
 * A read-only Graph client: `get(pathOrUrl, { version, headers })` resolves
 * { status, headers, text, json, tooLarge }. `tokenSource` is called once, on the
 * first request.
 */
export function readOnlyGraph(tokenSource, {
  fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((done) => { setTimeout(done, ms); }),
  maxBytes = DEFAULT_MAX_BYTES, maxRetries = DEFAULT_RETRIES,
} = {}) {
  let token = null;
  const stats = { requests: 0, throttled: 0 };
  async function get(pathOrUrl, { version = 'v1.0', headers = {} } = {}) {
    const url = /^https?:/i.test(pathOrUrl) ? pathOrUrl : `${GRAPH_ORIGIN}/${version}${pathOrUrl}`;
    const init = { method: 'GET', headers: { 'Accept-Language': 'en-US', ...headers } };
    assertReadOnly(url, init);
    token ??= tokenSource ? await tokenSource() : null;
    if (token) init.headers.Authorization = `Bearer ${token}`;
    for (let attempt = 0; ; attempt++) {
      const response = await fetchImpl(url, init);
      stats.requests++;
      if ((response.status === 429 || response.status === 503) && attempt < maxRetries) {
        stats.throttled++;
        await response.body?.cancel?.().catch(() => {});
        const seconds = Number(response.headers.get('retry-after'));
        await sleep((Number.isFinite(seconds) && seconds > 0 ? seconds : 10) * 1000);
        continue;
      }
      const read = await readBounded(response, maxBytes);
      let json = null;
      if (read.text) {
        try { json = JSON.parse(read.text); } catch { json = null; }
      }
      return { status: response.status, headers: response.headers, text: read.text, json, tooLarge: read.tooLarge };
    }
  }
  return { get, stats };
}
