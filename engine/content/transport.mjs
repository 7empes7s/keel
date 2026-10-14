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
 *
 * tokenSource() returns a token string or { accessToken, expiresAt } (tools/tenant-probe
 * getToken). A night's run outlives one Graph token, so the token is renewed five minutes
 * before it expires, and once more when Graph answers 401.
 */
import { Readable } from 'node:stream';
import { CONTENT_READER_IDENTITY, scopeProblems } from '../collect/workloadContract.mjs';

const GRAPH_HOST = 'graph.microsoft.com';
const RENEW_BEFORE_MS = 5 * 60 * 1000;

export function contentReadTransport(tokenSource, fetchImpl = globalThis.fetch, { now = () => Date.now() } = {}) {
  let token = null;
  const renew = async () => {
    const issued = await tokenSource();
    token = typeof issued === 'string'
      ? { accessToken: issued, expiresAt: Infinity }
      : { accessToken: issued?.accessToken, expiresAt: Number.isFinite(issued?.expiresAt) ? issued.expiresAt : Infinity };
    if (typeof token.accessToken !== 'string' || !token.accessToken) throw new Error('the content reader token source returned no token');
  };
  return async (url, { method = 'GET', body, as = 'json' } = {}) => {
    const verb = String(method).toUpperCase();
    if (verb !== 'GET' || body !== undefined) throw new Error(`content backup is read-only: refused ${verb} ${url}`);
    const parsed = new URL(url);
    if (parsed.hostname !== GRAPH_HOST) throw new Error(`content backup reads Microsoft Graph only: refused ${url}`);
    const endpoint = `${decodeURIComponent(parsed.pathname).replace(/^\/(v1\.0|beta)/, '')}${parsed.search}`;
    const problems = scopeProblems({ kind: 'graph', method: 'GET', endpoint }, { identity: CONTENT_READER_IDENTITY });
    if (problems.length) throw new Error(`content backup refused ${url}: ${problems.join('; ')}`);
    if (!['json', 'stream'].includes(as)) throw new TypeError('as must be json or stream');
    if (!token || now() >= token.expiresAt - RENEW_BEFORE_MS) await renew();
    const send = () => fetchImpl(parsed.href, { method: 'GET', headers: { authorization: `Bearer ${token.accessToken}` } });
    let response = await send();
    if (response.status === 401) {
      await response.body?.cancel?.();
      await renew();
      response = await send();
    }
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
