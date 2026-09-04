/** Write-capable Graph client. Separate module from graph.mjs (read-only client
 * used by Collector) by design — spec §15's read/write app-registration split
 * is mirrored at the code level, not just the credential level. */
const GRAPH = { 'v1.0': 'https://graph.microsoft.com/v1.0', beta: 'https://graph.microsoft.com/beta' };
const GRAPH_HOSTS = new Set(['graph.microsoft.com']);

function isGraphUrl(url) {
  try { return GRAPH_HOSTS.has(new URL(url).host); } catch { return false; }
}

export class GraphWriter {
  constructor(getAccessToken) {
    this.getAccessToken = getAccessToken;
  }

  url(version, path) {
    return path.startsWith('http') ? path : `${GRAPH[version]}${path}`;
  }

  async write(version, path, { method, body }) {
    const url = this.url(version, path);
    if (!isGraphUrl(url)) throw new Error(`refused write to non-Graph host: ${url}`);
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${await this.getAccessToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const responseBody = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, body: responseBody };
  }

  async read(version, path) {
    const url = this.url(version, path);
    if (!isGraphUrl(url)) throw new Error(`refused read from non-Graph host: ${url}`);
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${await this.getAccessToken()}` },
    });
    const body = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, body };
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
      headers: { Authorization: `Bearer ${await this.getAccessToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests: requests.map((r) => ({ id: r.id, method: r.method, url: r.url, body: r.body })) }),
    });
    const body = await res.json();

    const succeeded = [];
    const failed = [];
    for (const item of body.responses ?? []) {
      if (item.status >= 200 && item.status < 300) {
        succeeded.push({ id: item.id, status: item.status, body: item.body });
      } else {
        const retryAfter = item.headers?.['Retry-After'] ? Number(item.headers['Retry-After']) : undefined;
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
      headers: { Authorization: `Bearer ${await this.getAccessToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ signInIdentity, signInContext, signInConditions, appliedPoliciesOnly }),
    });
    const body = await res.json();
    return body.value ?? [];
  }
}
