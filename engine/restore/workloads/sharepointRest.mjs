/**
 * Gap 4: the SharePoint REST transport the site permissions restore writes through,
 * as the Restorer (SharePoint Online Sites.FullControl.All, a certificate token for
 * https://<tenantHost>/.default).
 *
 * It can reach only the tenant's own SharePoint host, under a site's /_api/:
 *  - GET on the site permissions reads the backup uses (assertPermissionsRequest);
 *  - POST on the writes in WRITE_PATHS and nothing else: no query string, a JSON
 *    body or none, and `X-HTTP-Method: MERGE` only to set IsSiteAdmin on one site user.
 * DELETE, PUT, PATCH, a breakroleinheritance or removeroleassignment call, another
 * host, a redirect or any other header is refused before anything is sent. The token
 * never leaves the closure and is renewed like the content transports' tokens.
 *
 *   transport(url, { method, body, headers }) -> { status, headers, body }   JSON (odata=nometadata)
 */
import { assertPermissionsRequest } from '../../content/sharepointSites.mjs';

const GUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const RENEW_BEFORE_MS = 5 * 60 * 1000;
const ADD_ROLE = 'roleassignments/addroleassignment\\(principalid=[0-9]+,roledefid=[0-9]+\\)';

// Every write, relative to <site>/_api/. `merge` marks the one path sent as MERGE.
export const WRITE_PATHS = Object.freeze([
  { pattern: /^web\/roledefinitions$/i, body: true },
  { pattern: /^web\/sitegroups$/i, body: true },
  { pattern: /^web\/sitegroups\/getbyid\([0-9]+\)\/users$/i, body: true },
  { pattern: /^web\/ensureuser$/i, body: true },
  { pattern: /^web\/siteusers\/getbyid\([0-9]+\)$/i, body: true, merge: true },
  { pattern: new RegExp(`^web/${ADD_ROLE}$`, 'i'), body: false },
  { pattern: new RegExp(`^web/lists\\(guid'${GUID}'\\)/${ADD_ROLE}$`, 'i'), body: false },
]);

/** Throws unless the request is one this restore may send. Returns the API path (lower case). */
export function assertSitePermissionsRequest(url, { method = 'GET', body, headers = {} } = {}, tenantHost) {
  const verb = String(method).toUpperCase();
  const names = Object.keys(headers ?? {}).map((name) => name.toLowerCase());
  if (verb === 'GET') {
    if (body !== undefined || names.length) throw new Error(`site permissions restore: refused a GET with a body or headers: ${url}`);
    return assertPermissionsRequest(url, 'GET', tenantHost);
  }
  if (verb !== 'POST') throw new Error(`site permissions restore never sends ${verb}: refused ${url}`);
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.port || parsed.hostname.toLowerCase() !== String(tenantHost).toLowerCase()) {
    throw new Error(`site permissions restore writes to ${tenantHost} only: refused ${url}`);
  }
  if (parsed.search || parsed.hash) throw new Error(`site permissions restore: refused a write with a query: ${url}`);
  const path = decodeURIComponent(parsed.pathname);
  const at = path.toLowerCase().indexOf('/_api/');
  const api = at < 0 ? null : path.slice(at + '/_api/'.length);
  const allowed = api === null ? null : WRITE_PATHS.find((entry) => entry.pattern.test(api));
  if (!allowed) throw new Error(`site permissions restore: refused POST ${path}: not an allow-listed write`);
  if (allowed.body !== (body !== undefined)) throw new Error(`site permissions restore: refused POST ${path}: ${allowed.body ? 'it needs' : 'it takes no'} body`);
  if (body !== undefined && (body === null || typeof body !== 'object' || Array.isArray(body))) throw new TypeError('the body must be a JSON object');
  for (const name of names) {
    if (name !== 'x-http-method') throw new Error(`site permissions restore refused request header ${name}`);
  }
  const merge = names.includes('x-http-method');
  if (merge && (!allowed.merge || String(Object.entries(headers).find(([name]) => name.toLowerCase() === 'x-http-method')[1]).toUpperCase() !== 'MERGE')) {
    throw new Error(`site permissions restore: refused X-HTTP-Method on ${path}`);
  }
  if (allowed.merge && !merge) throw new Error(`site permissions restore: ${path} is only ever sent as MERGE`);
  if (allowed.merge && Object.keys(body).join() !== 'IsSiteAdmin') throw new Error(`site permissions restore: only IsSiteAdmin is set on a site user`);
  return `${path.slice(0, at)}|${api}`.toLowerCase();
}

export function sitePermissionsWriteTransport(tokenSource, fetchImpl = globalThis.fetch, { tenantHost, now = () => Date.now() } = {}) {
  if (typeof tenantHost !== 'string' || !/^[a-z0-9-]+\.sharepoint\.com$/i.test(tenantHost)) {
    throw new TypeError('tenantHost must be the tenant\'s SharePoint host, such as contoso.sharepoint.com');
  }
  let token = null;
  const renew = async () => {
    const issued = await tokenSource();
    token = typeof issued === 'string'
      ? { accessToken: issued, expiresAt: Infinity }
      : { accessToken: issued?.accessToken, expiresAt: Number.isFinite(issued?.expiresAt) ? issued.expiresAt : Infinity };
    if (typeof token.accessToken !== 'string' || !token.accessToken) throw new Error('the SharePoint restorer token source returned no token');
  };
  return async (url, init = {}) => {
    assertSitePermissionsRequest(url, init, tenantHost);
    const verb = String(init.method ?? 'GET').toUpperCase();
    const extra = {};
    for (const [name, value] of Object.entries(init.headers ?? {})) extra[name.toLowerCase()] = String(value);
    if (init.body !== undefined) extra['content-type'] = 'application/json;odata=nometadata';
    if (!token || now() >= token.expiresAt - RENEW_BEFORE_MS) await renew();
    const send = () => fetchImpl(new URL(url).href, {
      method: verb, redirect: 'error', body: init.body === undefined ? undefined : JSON.stringify(init.body),
      headers: { ...extra, accept: 'application/json;odata=nometadata', authorization: `Bearer ${token.accessToken}` },
    });
    let response = await send();
    if (response.status === 401) {
      await response.body?.cancel?.();
      await renew();
      response = await send();
    }
    const headers = Object.fromEntries(response.headers.entries());
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: response.status, headers, body: json };
  };
}
