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
  };
}

