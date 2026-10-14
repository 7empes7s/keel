/**
 * The Graph transport content collectors read through (Wave 1 CONT). It runs as the
 * content-reader identity, so content paths are allowed, and it can only read: a
 * non-GET request, a request body or a host other than Microsoft Graph is refused
 * before anything is sent. The token never leaves the closure.
 *
 *   transport(url) -> { status, headers, body }            JSON (null when not JSON)
 *   transport(url, { as: 'stream' }) -> { status, headers, body: Readable | null }
 *
 * A file download answers with a redirect to a pre-authorized SharePoint URL; fetch
 * follows it and drops the Authorization header on the way, so the token stays on Graph.
 */
import { Readable } from 'node:stream';
import { CONTENT_READER_IDENTITY, scopeProblems } from '../collect/workloadContract.mjs';

const GRAPH_HOST = 'graph.microsoft.com';

export function contentReadTransport(tokenSource, fetchImpl = globalThis.fetch) {
  let token = null;
  return async (url, { method = 'GET', body, as = 'json' } = {}) => {
    const verb = String(method).toUpperCase();
    if (verb !== 'GET' || body !== undefined) throw new Error(`content backup is read-only: refused ${verb} ${url}`);
    const parsed = new URL(url);
    if (parsed.hostname !== GRAPH_HOST) throw new Error(`content backup reads Microsoft Graph only: refused ${url}`);
    const endpoint = `${decodeURIComponent(parsed.pathname).replace(/^\/(v1\.0|beta)/, '')}${parsed.search}`;
    const problems = scopeProblems({ kind: 'graph', method: 'GET', endpoint }, { identity: CONTENT_READER_IDENTITY });
    if (problems.length) throw new Error(`content backup refused ${url}: ${problems.join('; ')}`);
    if (!['json', 'stream'].includes(as)) throw new TypeError('as must be json or stream');
    token ??= await tokenSource();
    const response = await fetchImpl(parsed.href, { method: 'GET', headers: { authorization: `Bearer ${token}` } });
    const headers = Object.fromEntries(response.headers.entries());
    if (as === 'stream') {
      return { status: response.status, headers, body: response.body ? Readable.fromWeb(response.body) : null };
    }
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: response.status, headers, body: json };
  };
}
