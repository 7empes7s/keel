import { NextRequest, NextResponse } from "next/server";

import {
  ACCESS_ASSERTION_HEADER,
  AUTHENTICATED_EMAIL_HEADER,
  accessConfigFromEnv,
  accessIdentityOrigin,
  fetchAccessIdentity,
  verifyAccessAssertion,
  type AccessVerificationConfig,
} from "@/lib/cloudflare-access";
import { DatabaseBusyError } from "@/lib/db";
import {
  CAPABILITIES_HEADER,
  ENTITY_CAPABILITIES_HEADER,
  PRINCIPAL_ID_HEADER,
  encodeEntityCapabilities,
  resolveIdentity,
  type ResolvedIdentity,
  type SignInHints,
} from "@/lib/principal";
import { isSameOriginRequest } from "@/lib/same-origin";

type ConfigProvider = () => AccessVerificationConfig;
type IdentityResolver = (email: string, hints?: SignInHints) => Promise<ResolvedIdentity>;

const NO_STORE = { "cache-control": "no-store" } as const;

function unauthorized(): NextResponse {
  return NextResponse.json(
    { error: "unauthorized" },
    { status: 401, headers: NO_STORE },
  );
}

function forbidden(): NextResponse {
  return NextResponse.json(
    { error: "forbidden" },
    { status: 403, headers: NO_STORE },
  );
}

function crossSiteRefused(): NextResponse {
  return NextResponse.json(
    { error: "cross-site request refused" },
    { status: 403, headers: NO_STORE },
  );
}

export const BUSY_MESSAGE = "Keel is busy, try again in a moment.";
const BUSY_RETRY_SECONDS = 5;

// A plain page for a browser: the sign-in check could not reach the database in time.
// Self-contained (no app styles load here) with Keel's navy and amber, light and dark.
const BUSY_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Keel is busy</title>
<style>
:root { --bg: #1B2A4A; --card: #22355c; --text: #f4f6fb; --muted: #c3cbe0; --accent: #F5A623; --on-accent: #1B2A4A; }
@media (prefers-color-scheme: light) {
  :root { --bg: #f4f6fb; --card: #ffffff; --text: #1B2A4A; --muted: #4a5878; --accent: #F5A623; --on-accent: #1B2A4A; }
}
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px;
  background: var(--bg); color: var(--text); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 420px; width: 100%; background: var(--card); border-radius: 12px; padding: 24px;
  border-top: 4px solid var(--accent); box-shadow: 0 8px 24px rgba(0,0,0,.18); }
.badge { display: inline-block; background: var(--accent); color: var(--on-accent); font-weight: 700;
  font-size: 13px; border-radius: 999px; padding: 2px 10px; }
h1 { font-size: 22px; margin: 12px 0 8px; }
p { margin: 0 0 20px; color: var(--muted); }
a.button { display: inline-block; background: var(--accent); color: var(--on-accent); font-weight: 700;
  text-decoration: none; border-radius: 8px; padding: 10px 18px; }
</style>
</head>
<body>
<main role="alert">
<span class="badge">Busy</span>
<h1>${BUSY_MESSAGE}</h1>
<p>Too many requests are running right now. Nothing was changed. Wait a few seconds, then try again.</p>
<a class="button" href="">Try again</a>
</main>
</body>
</html>
`;

function busy(request: NextRequest): NextResponse {
  const headers = { ...NO_STORE, "retry-after": String(BUSY_RETRY_SECONDS) };
  if (request.nextUrl.pathname === "/api" || request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "busy", message: BUSY_MESSAGE }, { status: 503, headers });
  }
  return new NextResponse(BUSY_PAGE, {
    status: 503,
    headers: { ...headers, "content-type": "text/html; charset=utf-8" },
  });
}

function isDatabaseBusy(error: unknown): boolean {
  return error instanceof DatabaseBusyError || (error as Error | null)?.name === "DatabaseBusyError";
}

function isUnauthenticatedHealthCheck(request: NextRequest): boolean {
  return request.method === "GET" && request.nextUrl.pathname === "/api/health";
}

export function createAccessMiddleware(
  getConfig: ConfigProvider = accessConfigFromEnv,
  resolve: IdentityResolver = resolveIdentity,
): (request: NextRequest) => Promise<NextResponse> {
  return async function accessMiddleware(request: NextRequest): Promise<NextResponse> {
    // Intentional sole auth exception: this literal liveness probe reads no state.
    if (isUnauthenticatedHealthCheck(request)) {
      return NextResponse.next();
    }

    // A state change must come from the portal's own pages, never from another site
    // riding on the browser's Access cookie.
    if (!isSameOriginRequest(request.method, request.headers)) {
      return crossSiteRefused();
    }

    const assertion = request.headers.get(ACCESS_ASSERTION_HEADER);
    if (!assertion) {
      return unauthorized();
    }

    try {
      const claims = await verifyAccessAssertion(assertion, getConfig());
      const requestHeaders = new Headers(request.headers);

      // Never trust an identity value supplied by the caller. Only downstream the
      // email extracted from the cryptographically verified Access assertion, plus the
      // principal and capabilities resolved from that email here — the one module that
      // does identity resolution.
      requestHeaders.delete(AUTHENTICATED_EMAIL_HEADER);
      requestHeaders.set(AUTHENTICATED_EMAIL_HEADER, claims.email);
      requestHeaders.delete(PRINCIPAL_ID_HEADER);
      requestHeaders.delete(CAPABILITIES_HEADER);
      requestHeaders.delete(ENTITY_CAPABILITIES_HEADER);

      // Authentication is not authorisation: an email with no principal row — or a
      // principal that cannot be resolved at all — is downstreamed with no principal
      // id and no capabilities. Deny by default, never fail open.
      let identity: ResolvedIdentity = { principalId: null, capabilities: [] };
      try {
        const origin = accessIdentityOrigin(request.headers.get("host"));
        identity = await resolve(claims.email, {
          claims: claims.claims,
          lookupIdentity: origin ? () => fetchAccessIdentity(origin, assertion) : undefined,
        });
      } catch (error) {
        // A full database pool is not a refusal: say Keel is busy so the person retries.
        // Still fail closed: nothing is passed downstream.
        if (isDatabaseBusy(error)) return busy(request);
        // fail closed: an unresolvable principal has no capabilities
      }
      if (!identity.principalId) return forbidden();

      requestHeaders.set(PRINCIPAL_ID_HEADER, identity.principalId);
      requestHeaders.set(CAPABILITIES_HEADER, identity.capabilities.join(" "));
      requestHeaders.set(ENTITY_CAPABILITIES_HEADER, encodeEntityCapabilities(identity.entityCapabilities));

      return NextResponse.next({ request: { headers: requestHeaders } });
    } catch {
      return unauthorized();
    }
  };
}

const authenticate = createAccessMiddleware();

export function proxy(request: NextRequest): Promise<NextResponse> {
  return authenticate(request);
}

// Every request is checked except the build's static files and the app icon.
// Those are the same public bundles for every visitor (content-hashed JS and CSS,
// no data), and Cloudflare Access still guards them at the edge. Skipping them saves
// a token check and a database lookup on each of the ~50 files a page load fetches.
// Only these exact prefixes are skipped: /_next/image, /_next/data and every page
// and API route stay checked.
export const config = {
  matcher: ["/((?!_next/static/|icon\\.svg$).*)"],
};
