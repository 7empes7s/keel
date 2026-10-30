/** Write-capable Graph client. Separate module from graph.mjs (read-only client
 * used by Collector) by design — spec §15's read/write app-registration split
 * is mirrored at the code level, not just the credential level. */
const GRAPH = { 'v1.0': 'https://graph.microsoft.com/v1.0', beta: 'https://graph.microsoft.com/beta' };
const GRAPH_HOSTS = new Set(['graph.microsoft.com']);
export const RETRY_AFTER_FALLBACK_SECONDS = 60;
// Every Graph request carries Accept-Language. Measured live (Q43 step 45,
// 2026-10-12): the PIM role-settings read-back (unifiedRoleManagementPolicy)
// 400s with CultureNotFoundException under an app token when the header is
// absent, so a correct write was recorded as unverified. The collector's
// GraphReader (tools/tenant-probe/graph.mjs) sends the same default for the
// same reason. A caller's own Accept-Language (company branding: a specific
// language, or `0` for the default branding) always wins.
export const DEFAULT_ACCEPT_LANGUAGE = 'en-US';

function withAcceptLanguage(headers) {
  return headerValue(headers, 'accept-language') === undefined
    ? { 'Accept-Language': DEFAULT_ACCEPT_LANGUAGE, ...headers }
    : { ...headers };
}

function isGraphUrl(url) {
  try { return GRAPH_HOSTS.has(new URL(url).host); } catch { return false; }
}

function headerValue(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === 'function') return headers.get(name) ?? headers.get(name.toLowerCase()) ?? undefined;
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry?.[1];
}

/** HTTP Retry-After permits either non-negative delay-seconds or an HTTP-date.
 * A past date, a decimal, or an otherwise invalid value is deliberately not
 * trusted as a throttle delay. */
export function parseRetryAfter(value, now = Date.now()) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isSafeInteger(seconds) ? seconds : undefined;
  }
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  const seconds = Math.ceil((date - now) / 1000);
  return seconds >= 0 ? seconds : undefined;
}

export function retryAfterFor(status, headers, now = Date.now()) {
  const retryAfter = parseRetryAfter(headerValue(headers, 'retry-after'), now);
  if (retryAfter !== undefined) return retryAfter;
  return status === 429 || status === 503 ? RETRY_AFTER_FALLBACK_SECONDS : undefined;
}

export class GraphWriter {
  // getAccessToken(url) is told the request URL, so one writer can sign in as a
  // different app for some endpoints (Viva Engage: restore/engageWriter.mjs).
  constructor(getAccessToken, { clock = () => Date.now() } = {}) {
    this.getAccessToken = getAccessToken;
    this.clock = clock;
  }

  url(version, path) {
    return path.startsWith('http') ? path : `${GRAPH[version]}${path}`;
  }

  // `headers` adds request headers (issue #156: company branding names its
  // language with Accept-Language); it can never replace the two below.
  async write(version, path, { method, body, headers = {} }) {
    const url = this.url(version, path);
    if (!isGraphUrl(url)) throw new Error(`refused write to non-Graph host: ${url}`);
    const res = await fetch(url, {
      method,
      headers: { ...withAcceptLanguage(headers), Authorization: `Bearer ${await this.getAccessToken(url)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const responseBody = await res.json().catch(() => null);
    const result = { ok: res.ok, status: res.status, body: responseBody };
    if (!result.ok) result.retryAfter = retryAfterFor(res.status, res.headers, this.clock());
    return result;
  }

  /**
   * Roadmap M6: upload one binary stream (a company branding image or the
   * custom stylesheet) with PUT and its own Content-Type. The body is sent as
   * bytes, never JSON-encoded.
   */
  async putStream(version, path, { body, contentType, headers = {} }) {
    const url = this.url(version, path);
    if (!isGraphUrl(url)) throw new Error(`refused write to non-Graph host: ${url}`);
    if (!Buffer.isBuffer(body)) throw new TypeError('putStream needs a Buffer body');
    if (typeof contentType !== 'string' || contentType.length === 0) throw new TypeError('putStream needs a Content-Type');
    const res = await fetch(url, {
      method: 'PUT',
      headers: { ...withAcceptLanguage(headers), Authorization: `Bearer ${await this.getAccessToken(url)}`, 'Content-Type': contentType },
      body,
    });
    const responseBody = await res.json().catch(() => null);
    const result = { ok: res.ok, status: res.status, body: responseBody };
    if (!result.ok) result.retryAfter = retryAfterFor(res.status, res.headers, this.clock());
    return result;
  }

  async read(version, path, { headers = {} } = {}) {
    const url = this.url(version, path);
    if (!isGraphUrl(url)) throw new Error(`refused read from non-Graph host: ${url}`);
    const res = await fetch(url, {
      headers: { ...withAcceptLanguage(headers), Authorization: `Bearer ${await this.getAccessToken(url)}` },
    });
    const body = await res.json().catch(() => null);
    const result = { ok: res.ok, status: res.status, body };
    if (!result.ok) result.retryAfter = retryAfterFor(res.status, res.headers, this.clock());
    return result;
  }

  /**
   * Spec §11.2–§11.3: max 20 requests per batch; a 429 inside the batch
   * arrives inside a 200 envelope, and every item is parsed individually — the
   * outer status is NEVER treated as evidence of success.
   */
  async batch(version, requests) {
    if (requests.length > 20) throw new Error(`batch of ${requests.length} exceeds the 20-request limit`);
    const url = this.url(version, '/$batch');
    if (!isGraphUrl(url)) throw new Error(`refused write to non-Graph host: ${url}`);
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...withAcceptLanguage(), Authorization: `Bearer ${await this.getAccessToken(url)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests: requests.map((r) => ({ id: r.id, method: r.method, url: r.url, body: r.body })) }),
    });
    const body = await res.json().catch(() => null);

    const succeeded = [];
    const failed = [];
    if (!res.ok) {
      failed.push({
        status: res.status,
        error: body?.error,
        retryAfter: retryAfterFor(res.status, res.headers, this.clock()),
      });
      return { ok: false, succeeded, failed };
    }
    if (!Array.isArray(body?.responses)) {
      failed.push({
        status: res.status,
        error: new Error('malformed Graph batch response: missing responses array'),
      });
      return { ok: false, succeeded, failed };
    }
    for (const item of body.responses) {
      if (item.status >= 200 && item.status < 300) {
        succeeded.push({ id: item.id, status: item.status, body: item.body });
      } else {
        const retryAfter = retryAfterFor(item.status, item.headers, this.clock());
        failed.push({ id: item.id, status: item.status, error: item.body?.error, retryAfter });
      }
    }
    return { ok: failed.length === 0, succeeded, failed };
  }

  /** Spec §10.3 — Conditional Access What If Evaluation API. Beta-only
   * endpoint (verified 2026-09-04 against Microsoft Graph docs); re-verify
   * before use if this file is revisited long after that date, since preview
   * surfaces move (same caveat the design spec itself carries in §3). */
  async whatIf({ signInIdentity, signInContext, signInConditions, appliedPoliciesOnly = true }) {
    const url = this.url('beta', '/identity/conditionalAccess/evaluate');
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...withAcceptLanguage(), Authorization: `Bearer ${await this.getAccessToken(url)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ signInIdentity, signInContext, signInConditions, appliedPoliciesOnly }),
    });
    const body = await res.json();
    return body.value ?? [];
  }
}
