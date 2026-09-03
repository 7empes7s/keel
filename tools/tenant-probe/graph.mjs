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
  async get(version, path, { consistencyLevel = false, maxRetries = 5 } = {}) {
    const url = this.url(version, path);
    if (!isGraphUrl(url)) {
      return { ok: false, status: 0, code: 'UnsafeUrl', error: `refused request to non-Graph host: ${url}` };
    }
    const headers = { Authorization: `Bearer ${await this.getAccessToken()}` };
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
          error: body?.error?.message ?? res.statusText,
          code: body?.error?.code,
        };
      }
      return { ok: true, status: res.status, body, elapsed };
    }
  }

  /**
   * Follow @odata.nextLink. Returns whatever was retrieved even when the walk
   * stops early, with `capped` set, so a bounded read is never mistaken for a
   * complete one.
   */
  async collect(version, path, { pageCap = Infinity, consistencyLevel = false } = {}) {
    const items = [];
    let next = path;
    let pages = 0;
    let firstError = null;

    while (next && pages < pageCap) {
      const res = await this.get(version, next, { consistencyLevel: consistencyLevel && pages === 0 });
      if (!res.ok) {
        firstError = res;
        break;
      }
      pages++;
      const value = res.body?.value;
      if (Array.isArray(value)) items.push(...value);
      else if (res.body) items.push(res.body); // singleton resource
      next = res.body?.['@odata.nextLink'] ?? null;
    }

    return { items, pages, capped: Boolean(next), error: firstError };
  }

  #recordLatency(path, ms) {
    this.stats.slowest.push({ path, ms });
    this.stats.slowest.sort((a, b) => b.ms - a.ms);
    this.stats.slowest.length = Math.min(this.stats.slowest.length, 10);
  }
}
