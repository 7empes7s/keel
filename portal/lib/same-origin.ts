// Cross-site request protection. The only credential the portal sees is the
// Cloudflare Access assertion, which Access builds from the browser's ambient
// cookie, so a page on another site could otherwise make a signed-in browser send
// a state-changing request (for example, approve a restore). Every request that is
// not a safe read must come from the portal's own pages.

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function isSafeMethod(method: string): boolean {
  return SAFE_METHODS.has(method.toUpperCase());
}

function hostOf(value: string | null | undefined): string | null {
  const host = value?.split(",")[0]?.trim().toLowerCase();
  return host ? host : null;
}

function originOf(value: string | null | undefined): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

/**
 * True when a state-changing request may proceed. Browsers send Sec-Fetch-Site on
 * every request and Origin on every non-GET request, so:
 * - Sec-Fetch-Site, when present, must be "same-origin" (or "none": the user typed
 *   or bookmarked the request, which no other site can trigger).
 * - Origin, when present, must name this portal: the host the request was sent to,
 *   or KEEL_PORTAL_URL. An opaque "null" origin is refused.
 * A request with neither header is not from a browser, so no ambient cookie rode
 * along with it, and the Access assertion alone decides.
 */
export function isSameOriginRequest(
  method: string,
  headers: Headers,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (isSafeMethod(method)) return true;

  const fetchSite = headers.get("sec-fetch-site")?.trim().toLowerCase();
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") return false;

  const originHeader = headers.get("origin");
  if (originHeader === null) return true;
  const origin = originOf(originHeader);
  if (!origin) return false;

  const configured = originOf(env.KEEL_PORTAL_URL);
  if (configured && configured.origin === origin.origin) return true;

  const allowedHosts = [hostOf(headers.get("x-forwarded-host")), hostOf(headers.get("host"))].filter(
    (host): host is string => host !== null,
  );
  return allowedHosts.includes(origin.host.toLowerCase());
}

/** True when the Content-Type names JSON (application/json, any parameters). */
export function isJsonContentType(value: string | null): boolean {
  if (!value) return false;
  return value.split(";")[0].trim().toLowerCase() === "application/json";
}
