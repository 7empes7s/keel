/**
 * Read-only Graph client with explicit throttle observation.
 *
 * Read-only is enforced structurally: this module never accepts an HTTP method,
 * so there is no code path through which the probe can write to a tenant. That
 * is a stronger guarantee than a flag, and it is the same separation the
 * product uses between the collection plane and the restore plane (spec §4).
 */

const GRAPH = {
  'v1.0': 'https://graph.microsoft.com/v1.0',
  beta: 'https://graph.microsoft.com/beta',
};

const GRAPH_HOSTS = new Set(['graph.microsoft.com']);

const JWT_PATTERN = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;
const BEARER_PATTERN = /bearer\s+[A-Za-z0-9._~+/=-]+/gi;
const LONG_TOKEN_PATTERN = /[A-Za-z0-9_-]{48,}/g;

/**
 * Error messages are persisted in coverage digests and surfaced in reports,
 * and Graph occasionally echoes request material back in them. Strip bearer
 * tokens, JWT-shaped strings and long token-shaped runs before any message
 * leaves the read path; ordinary prose and Graph error codes pass through.
 */
export function redactSecrets(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(JWT_PATTERN, '[redacted]')
    .replace(BEARER_PATTERN, 'Bearer [redacted]')
    .replace(LONG_TOKEN_PATTERN, '[redacted]');
}

/**
 * The access token may only ever be sent to Graph itself. @odata.nextLink
 * values arrive as absolute URLs and are followed verbatim, so without this
 * guard a malicious or buggy response could point the client at a foreign
 * host and receive the bearer token there.
 */
function isGraphUrl(url) {
  try {
    return GRAPH_HOSTS.has(new URL(url).host);
  } catch {
    return false;
  }
}

export class GraphReader {
  constructor(getAccessToken) {
    this.getAccessToken = getAccessToken;
    this.stats = {
      requests: 0,
      throttled: 0,
      retryAfterSeconds: [],
      totalWaitMs: 0,
      statusCounts: {},
      slowest: [],
    };
  }

  url(version, path) {
    return path.startsWith('http') ? path : `${GRAPH[version]}${path}`;
  }

  /**
   * Single GET with throttle handling. A 429 is honoured by waiting the full
   * Retry-After — never a shorter guess — and the wait is recorded so the
   * observed ceiling can be reported rather than estimated.
   */
  async get(version, path, { consistencyLevel = false, maxRetries = 5, acceptLanguage = 'en-US' } = {}) {
    const url = this.url(version, path);
    if (!isGraphUrl(url)) {
      return { ok: false, status: 0, code: 'UnsafeUrl', error: redactSecrets(`refused request to non-Graph host: ${url}`) };
    }
    // Accept-Language is required on every Graph request, not just this one.
    // Measured live 2026-09-08: GET
    // roleManagement/directory/roleEligibilityScheduleInstances 400s with
    // {"ErrorCode":"CultureNotFoundException","Message":"Culture is not
    // supported. Parameter name: name\n* is an invalid culture identifier."}
    // when no Accept-Language is sent, and returns 200 once
    // `Accept-Language: en-US` is added — nothing else about the request
    // differs. Graph's PIM endpoints (and, per Microsoft's own guidance,
    // others) fall back to a locale of "*" without this header, which their
    // culture parser then rejects. The header is harmless and standard
    // everywhere else, so it is sent unconditionally here rather than only on
    // the one endpoint that is known to need it today — scoping it would
    // leave the same trap for the next PIM-like endpoint.
    // Issue #156: company branding is the one exception. Its GET answers in
    // the language named here, and only `0` returns the default branding, so
    // its catalogue entry overrides the header (catalog.mjs acceptLanguage).
    const headers = {
      Authorization: `Bearer ${await this.getAccessToken()}`,
      'Accept-Language': acceptLanguage,
    };
    if (consistencyLevel) headers.ConsistencyLevel = 'eventual';

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const started = Date.now();
      const res = await fetch(url, { method: 'GET', headers });
      const elapsed = Date.now() - started;

      this.stats.requests++;
      this.stats.statusCounts[res.status] = (this.stats.statusCounts[res.status] ?? 0) + 1;
      this.#recordLatency(path, elapsed);

      if (res.status === 429 || res.status === 503) {
        const retryAfter = Number(res.headers.get('retry-after') ?? 10);
        this.stats.throttled++;
        this.stats.retryAfterSeconds.push(retryAfter);
        this.stats.totalWaitMs += retryAfter * 1000;
        if (attempt === maxRetries) {
          return { ok: false, status: res.status, error: `throttled, gave up after ${maxRetries} retries` };
        }
        await new Promise((r) => setTimeout(r, retryAfter * 1000));
        continue;
      }

      let body = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }

      if (!res.ok) {
        return {
          ok: false,
          status: res.status,
          error: redactSecrets(body?.error?.message ?? res.statusText),
          code: body?.error?.code,
        };
      }
      return { ok: true, status: res.status, body, elapsed };
    }
  }

  /**
   * Follow @odata.nextLink. Returns whatever was retrieved even when the walk
   * stops early, with `capped` set, so a bounded read is never mistaken for a
   * complete one. A mid-walk failure keeps the items and page count gathered
   * before it: callers can record a partial outcome with a real partial count
   * instead of discarding the evidence or claiming completeness.
   */
  async collect(version, path, { pageCap = Infinity, consistencyLevel = false, acceptLanguage } = {}) {
    const items = [];
    let next = path;
    let pages = 0;
    let lastStatus = null;
    let firstError = null;

    while (next && pages < pageCap) {
      const res = await this.get(version, next, {
        consistencyLevel: consistencyLevel && pages === 0,
        ...(acceptLanguage ? { acceptLanguage } : {}),
      });
      if (!res.ok) {
        firstError = res;
        break;
      }
      pages++;
      lastStatus = res.status;
      const value = res.body?.value;
      if (Array.isArray(value)) items.push(...value);
      else if (res.body) items.push(res.body); // singleton resource
      next = res.body?.['@odata.nextLink'] ?? null;
    }

    return { items, pages, status: lastStatus, capped: Boolean(next), error: firstError };
  }

  #recordLatency(path, ms) {
    this.stats.slowest.push({ path, ms });
    this.stats.slowest.sort((a, b) => b.ms - a.ms);
    this.stats.slowest.length = Math.min(this.stats.slowest.length, 10);
  }
}
