/**
 * The Graph transport content restores write through (Wave 2 seam for MAILR and FILER).
 * It is built for the content-restorer token (PLAN ask B) and can only reach Microsoft Graph with GET,
 * POST, PATCH or PUT. DELETE and every other method, a host other than Graph, a
 * header outside the allowed set, and any request the target guard does not allow are
 * refused before anything is sent. The token never leaves the closure.
 *
 *   transport = contentWriteTransport(tokenSource, fetchImpl, { guard })
 *   transport(url, { method, body, headers }) -> { status, headers, body }   JSON (null when not JSON)
 *
 * guard(url, { method, endpoint, body }) is called for every request, reads included,
 * before anything is sent. It refuses by throwing, or by returning false or a reason
 * string; returning nothing or true lets the request through. It is where a package
 * checks that the target is a KEEL-RT- mailbox, site or drive on the test tenant.
 * There is no default guard.
 *
 * body is a plain object (sent as JSON), or a string or bytes (Buffer or Uint8Array)
 * sent as is with the content-type the caller names: a base64 MIME message is a
 * text/plain string, a small file PUT is bytes.
 *
 * One exception to Graph-only: a large file's chunks. The uploadUrl a createUploadSession
 * POST through this same transport returned (on the tenant's SharePoint host) may be
 * sent PUT requests with Content-Range, and with no Authorization header, because that
 * URL is pre-authorized. Any other non-Graph URL is refused, the guard still runs, and
 * the URL is forgotten once the upload completes (200 or 201).
 *
 * tokenSource() returns a token string or { accessToken, expiresAt }. The token is
 * renewed five minutes before it expires, and once more when Graph answers 401.
 * Redirects are never followed, so the token stays on Graph.
 */
const GRAPH_HOST = 'graph.microsoft.com';
const RENEW_BEFORE_MS = 5 * 60 * 1000;
const METHODS = new Set(['GET', 'POST', 'PATCH', 'PUT']);
const PASSED_HEADERS = new Set(['content-type', 'if-match', 'prefer', 'consistencylevel']);
const UPLOAD_HEADERS = new Set(['content-type', 'content-range']);
const SHAREPOINT_HOST = /\.sharepoint\.(com|us|de|cn)$/;

export function contentWriteTransport(tokenSource, fetchImpl = globalThis.fetch, { guard, now = () => Date.now() } = {}) {
  if (typeof guard !== 'function') throw new TypeError('a content write transport needs a target guard');
  let token = null;
  const uploadUrls = new Set();
  const renew = async () => {
    const issued = await tokenSource();
    token = typeof issued === 'string'
      ? { accessToken: issued, expiresAt: Infinity }
      : { accessToken: issued?.accessToken, expiresAt: Number.isFinite(issued?.expiresAt) ? issued.expiresAt : Infinity };
    if (typeof token.accessToken !== 'string' || !token.accessToken) throw new Error('the content restorer token source returned no token');
  };
  return async (url, { method = 'GET', body, headers: asked = {} } = {}) => {
    const verb = String(method).toUpperCase();
    if (!METHODS.has(verb)) throw new Error(`content restore never sends ${verb}: refused ${url}`);
    const parsed = new URL(url);
    const upload = verb === 'PUT' && uploadUrls.has(parsed.href);
    if (upload) return putChunk(parsed, { body, headers: asked });
    if (parsed.protocol !== 'https:' || parsed.hostname !== GRAPH_HOST || parsed.port !== '') {
      throw new Error(`content restore writes to Microsoft Graph only: refused ${url}`);
    }
    if (verb === 'GET' && body !== undefined) throw new Error(`content restore refused a GET with a body: ${url}`);
    const raw = body instanceof Uint8Array || typeof body === 'string';
    if (body !== undefined && !raw && (body === null || typeof body !== 'object')) {
      throw new TypeError('body must be an object, a string or bytes');
    }
    const extra = {};
    for (const [name, value] of Object.entries(asked ?? {})) {
      if (!PASSED_HEADERS.has(name.toLowerCase())) throw new Error(`content restore refused request header ${name}`);
      extra[name.toLowerCase()] = String(value);
    }
    if (raw && !extra['content-type']) throw new Error(`content restore needs a content-type for a string or byte body: ${url}`);
    const endpoint = `${decodeURIComponent(parsed.pathname).replace(/^\/(v1\.0|beta)/, '')}${parsed.search}`;
    const verdict = await guard(parsed.href, { method: verb, endpoint, body });
    if (verdict !== undefined && verdict !== true) {
      throw new Error(`content restore target guard refused ${verb} ${url}${typeof verdict === 'string' && verdict ? `: ${verdict}` : ''}`);
    }
    const payload = body === undefined ? undefined : raw ? body : JSON.stringify(body);
    if (body !== undefined && !raw) extra['content-type'] ??= 'application/json';
    if (!token || now() >= token.expiresAt - RENEW_BEFORE_MS) await renew();
    const send = () => fetchImpl(parsed.href, {
      method: verb, body: payload, redirect: 'manual', headers: { ...extra, authorization: `Bearer ${token.accessToken}` },
    });
    let response = await send();
    if (response.status === 401) {
      await response.body?.cancel?.();
      await renew();
      response = await send();
    }
    const result = await answer(response);
    if (verb === 'POST' && /\/createUploadSession$/.test(parsed.pathname) && typeof result.body?.uploadUrl === 'string') {
      const issued = new URL(result.body.uploadUrl);
      if (issued.protocol === 'https:' && issued.port === '' && SHAREPOINT_HOST.test(issued.hostname)) uploadUrls.add(issued.href);
    }
    return result;
  };

  async function putChunk(parsed, { body, headers: asked }) {
    if (!(body instanceof Uint8Array)) throw new TypeError('an upload chunk is bytes');
    const extra = {};
    for (const [name, value] of Object.entries(asked ?? {})) {
      if (!UPLOAD_HEADERS.has(name.toLowerCase())) throw new Error(`content restore refused upload header ${name}`);
      extra[name.toLowerCase()] = String(value);
    }
    if (!extra['content-range']) throw new Error('an upload chunk needs a content-range');
    const verdict = await guard(parsed.href, { method: 'PUT', endpoint: null, body });
    if (verdict !== undefined && verdict !== true) {
      throw new Error(`content restore target guard refused an upload chunk${typeof verdict === 'string' && verdict ? `: ${verdict}` : ''}`);
    }
    const response = await fetchImpl(parsed.href, { method: 'PUT', body, redirect: 'manual', headers: extra });
    const result = await answer(response);
    if (result.status === 200 || result.status === 201) uploadUrls.delete(parsed.href);
    return result;
  }
}

async function answer(response) {
  const headers = Object.fromEntries(response.headers.entries());
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: response.status, headers, body: json };
}
