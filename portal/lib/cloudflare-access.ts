import { createRemoteJWKSet, jwtVerify } from "jose";

export const ACCESS_ASSERTION_HEADER = "cf-access-jwt-assertion";
export const AUTHENTICATED_EMAIL_HEADER = "x-keel-authenticated-email";

export interface AccessVerificationConfig {
  audience: string;
  issuer: string;
  jwksUrl: URL;
}

export interface VerifiedAccessClaims {
  email: string;
  subject: string | undefined;
  /** Every verified claim, so a name the sign-in service sends can be read. */
  claims: Record<string, unknown>;
}

const jwksByUrl = new Map<
  string,
  ReturnType<typeof createRemoteJWKSet>
>();

function remoteJwks(url: URL): ReturnType<typeof createRemoteJWKSet> {
  const cacheKey = url.href;
  let jwks = jwksByUrl.get(cacheKey);

  if (!jwks) {
    jwks = createRemoteJWKSet(url);
    jwksByUrl.set(cacheKey, jwks);
  }

  return jwks;
}

export function accessConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): AccessVerificationConfig {
  const configuredTeamDomain = env.CLOUDFLARE_ACCESS_TEAM_DOMAIN?.trim();
  const audience = env.CLOUDFLARE_ACCESS_AUD?.trim();

  if (!configuredTeamDomain || !audience) {
    throw new Error("Cloudflare Access is not configured");
  }

  const teamDomain = new URL(configuredTeamDomain);
  if (
    teamDomain.protocol !== "https:" ||
    !teamDomain.hostname.endsWith(".cloudflareaccess.com") ||
    teamDomain.username ||
    teamDomain.password ||
    teamDomain.port ||
    (teamDomain.pathname !== "/" && teamDomain.pathname !== "") ||
    teamDomain.search ||
    teamDomain.hash
  ) {
    throw new Error("Cloudflare Access team domain is invalid");
  }

  const issuer = teamDomain.origin;

  return {
    audience,
    issuer,
    jwksUrl: new URL("/cdn-cgi/access/certs", `${issuer}/`),
  };
}

export async function verifyAccessAssertion(
  token: string,
  config: AccessVerificationConfig,
): Promise<VerifiedAccessClaims> {
  const { payload } = await jwtVerify(token, remoteJwks(config.jwksUrl), {
    algorithms: ["RS256"],
    audience: config.audience,
    issuer: config.issuer,
    requiredClaims: ["exp", "email"],
  });

  if (typeof payload.email !== "string" || payload.email.trim() === "") {
    throw new Error("Cloudflare Access assertion has no email claim");
  }

  return {
    email: payload.email,
    subject: payload.sub,
    claims: payload as Record<string, unknown>,
  };
}

export const ACCESS_IDENTITY_PATH = "/cdn-cgi/access/get-identity";

const DNS_NAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const PRIVATE_SUFFIX = /\.(?:local|localhost|internal|lan|home|corp|test|invalid|example)$/;

/**
 * The portal's public https origin, where Cloudflare Access answers who is signed in:
 * KEEL_PORTAL_URL when set, else the request's own host when it is a public DNS name
 * (never an IP address, a port or an internal name). Null when neither fits.
 */
export function accessIdentityOrigin(host: string | null, env: Record<string, string | undefined> = process.env): string | null {
  const configured = env.KEEL_PORTAL_URL?.trim();
  if (configured) {
    try {
      const url = new URL(configured);
      return url.protocol === "https:" && !url.username && !url.password ? url.origin : null;
    } catch {
      return null;
    }
  }
  const name = (host ?? "").trim().toLowerCase();
  return DNS_NAME.test(name) && !PRIVATE_SUFFIX.test(name) ? `https://${name}` : null;
}

/**
 * The identity Cloudflare Access holds for this sign-in (it carries the person's name
 * from the identity provider). Null on any failure; never throws.
 */
export async function fetchAccessIdentity(
  origin: string,
  assertion: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 2000,
): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetchImpl(new URL(ACCESS_IDENTITY_PATH, origin), {
      headers: { cookie: `CF_Authorization=${assertion}`, accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as unknown;
    return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

