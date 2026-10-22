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
import {
  CAPABILITIES_HEADER,
  ENTITY_CAPABILITIES_HEADER,
  PRINCIPAL_ID_HEADER,
  encodeEntityCapabilities,
  resolveIdentity,
  type ResolvedIdentity,
  type SignInHints,
} from "@/lib/principal";

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
      } catch {
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

export const config = {
  matcher: ["/:path*"],
};
