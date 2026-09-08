import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";

import {
  exportJWK,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type JWK,
} from "jose";
import { NextRequest } from "next/server";

import { GET as healthCheck } from "@/app/api/health/route";
import { AUTHENTICATED_EMAIL_HEADER } from "@/lib/cloudflare-access";
import { createAccessMiddleware } from "@/proxy";

const issuer = "https://keel-test.cloudflareaccess.com";
const audience = "keel-test-audience";
const trustedKeyId = "trusted-key";
const authenticatedEmail = "operator@example.com";
const readOnlyApiRoutes = [
  "/api/dashboard",
  "/api/coverage",
  "/api/drift",
  "/api/baselines",
] as const;

let jwksServer: Server;
let trustedPrivateKey: CryptoKey;
let wrongPrivateKey: CryptoKey;
let middleware: ReturnType<typeof createAccessMiddleware>;

before(async () => {
  const trustedKeys = await generateKeyPair("RS256", { modulusLength: 2048 });
  const wrongKeys = await generateKeyPair("RS256", { modulusLength: 2048 });
  const publicJwk: JWK = await exportJWK(trustedKeys.publicKey);

  publicJwk.alg = "RS256";
  publicJwk.kid = trustedKeyId;
  publicJwk.use = "sig";
  trustedPrivateKey = trustedKeys.privateKey;
  wrongPrivateKey = wrongKeys.privateKey;

  jwksServer = createServer((request, response) => {
    assert.equal(request.url, "/cdn-cgi/access/certs");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ keys: [publicJwk] }));
  });

  await new Promise<void>((resolve, reject) => {
    jwksServer.once("error", reject);
    jwksServer.listen(0, "127.0.0.1", resolve);
  });

  const address = jwksServer.address();
  assert(address && typeof address !== "string");

  middleware = createAccessMiddleware(() => ({
    audience,
    issuer,
    jwksUrl: new URL(
      `http://127.0.0.1:${address.port}/cdn-cgi/access/certs`,
    ),
  }));
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    jwksServer.close((error) => (error ? reject(error) : resolve()));
  });
});

function request(
  path = "/api/protected",
  token?: string,
  method = "GET",
  extraHeaders?: HeadersInit,
): NextRequest {
  const headers = new Headers(extraHeaders);
  if (token !== undefined) {
    headers.set("Cf-Access-Jwt-Assertion", token);
  }

  return new NextRequest(`http://localhost${path}`, { method, headers });
}

async function accessToken({
  signingKey = trustedPrivateKey,
  tokenAudience = audience,
  expiresAt = "5 minutes",
}: {
  signingKey?: CryptoKey;
  tokenAudience?: string;
  expiresAt?: number | string | Date;
} = {}): Promise<string> {
  return new SignJWT({ email: authenticatedEmail })
    .setProtectedHeader({ alg: "RS256", kid: trustedKeyId })
    .setIssuer(issuer)
    .setAudience(tokenAudience)
    .setSubject("operator-id")
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(signingKey);
}

test("an API request with no Access assertion is rejected with 401", async () => {
  const response = await middleware(request());

  assert.equal(response.status, 401);
});

for (const path of readOnlyApiRoutes) {
  test(`GET ${path} rejects an unauthenticated request with 401`, async () => {
    const response = await middleware(request(path));

    assert.equal(response.status, 401);
  });
}

test("a malformed Access assertion is rejected with 401", async () => {
  const response = await middleware(request("/", "garbage"));

  assert.equal(response.status, 401);
});

test("a token signed by the wrong key is rejected with 401", async () => {
  const response = await middleware(
    request("/", await accessToken({ signingKey: wrongPrivateKey })),
  );

  assert.equal(response.status, 401);
});

test("a token for the wrong audience is rejected with 401", async () => {
  const response = await middleware(
    request("/", await accessToken({ tokenAudience: "another-application" })),
  );

  assert.equal(response.status, 401);
});

test("an expired token is rejected with 401", async () => {
  const response = await middleware(
    request("/", await accessToken({ expiresAt: Math.floor(Date.now() / 1000) - 1 })),
  );

  assert.equal(response.status, 401);
});

test("a valid token is accepted and supplies only its verified email", async () => {
  const response = await middleware(
    request("/", await accessToken(), "GET", {
      [AUTHENTICATED_EMAIL_HEADER]: "attacker@example.com",
    }),
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-middleware-next"), "1");
  assert.equal(
    response.headers.get(
      `x-middleware-request-${AUTHENTICATED_EMAIL_HEADER}`,
    ),
    authenticatedEmail,
  );
});

test("GET /api/health is reachable without a token and returns the literal body", async () => {
  const middlewareResponse = await middleware(request("/api/health"));
  const routeResponse = healthCheck();

  assert.equal(middlewareResponse.status, 200);
  assert.equal(middlewareResponse.headers.get("x-middleware-next"), "1");
  assert.equal(routeResponse.status, 200);
  assert.equal(await routeResponse.text(), '{"status":"ok"}');
});

test("non-GET requests to /api/health do not bypass authentication", async () => {
  const response = await middleware(request("/api/health", undefined, "POST"));

  assert.equal(response.status, 401);
});
