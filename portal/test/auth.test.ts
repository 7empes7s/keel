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
import { ACCESS_IDENTITY_PATH, AUTHENTICATED_EMAIL_HEADER, accessIdentityOrigin, fetchAccessIdentity } from "@/lib/cloudflare-access";
import {
  CAPABILITIES_HEADER,
  ENTITY_CAPABILITIES_HEADER,
  PRINCIPAL_ID_HEADER,
  type ResolvedIdentity,
  type SignInHints,
} from "@/lib/principal";
import { DatabaseBusyError, connect, databaseUnreachableReason } from "@/lib/db";
import { BUSY_MESSAGE, UNREACHABLE_MESSAGE, createAccessMiddleware } from "@/proxy";

const issuer = "https://keel-test.cloudflareaccess.com";
const audience = "keel-test-audience";
const trustedKeyId = "trusted-key";
const authenticatedEmail = "operator@example.com";
const readOnlyApiRoutes = [
  "/api/change-flag-settings",
  "/api/dashboard",
  "/api/menu-status",
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

  // Identity resolution is stubbed: middleware tests must never reach a database.
  const stubIdentity: ResolvedIdentity = {
    principalId: "principal-1",
    capabilities: ["read", "collect"],
  };
  middleware = createAccessMiddleware(
    () => ({
      audience,
      issuer,
      jwksUrl: new URL(
        `http://127.0.0.1:${address.port}/cdn-cgi/access/certs`,
      ),
    }),
    async () => stubIdentity,
  );
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
  email = authenticatedEmail,
}: {
  signingKey?: CryptoKey;
  tokenAudience?: string;
  expiresAt?: number | string | Date;
  email?: string;
} = {}): Promise<string> {
  return new SignJWT({ email })
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

test("a valid token is accepted and supplies only its verified identity", async () => {
  const response = await middleware(
    request("/", await accessToken(), "GET", {
      [AUTHENTICATED_EMAIL_HEADER]: "attacker@example.com",
      [PRINCIPAL_ID_HEADER]: "attacker-principal",
      [CAPABILITIES_HEADER]: "admin",
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
  assert.equal(
    response.headers.get(`x-middleware-request-${PRINCIPAL_ID_HEADER}`),
    "principal-1",
  );
  assert.equal(
    response.headers.get(`x-middleware-request-${CAPABILITIES_HEADER}`),
    "read collect",
  );
});

// Task 90: entity-scoped capabilities are downstreamed only from identity resolution.
test("a caller-supplied entity scope header is replaced by the resolved one", async () => {
  const response = await middleware(
    request("/", await accessToken(), "GET", { [ENTITY_CAPABILITIES_HEADER]: "read:CREOS approve:ENOVOS" }),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get(`x-middleware-request-${ENTITY_CAPABILITIES_HEADER}`), "");
});

test("sign-in hands identity resolution the verified claims and an identity lookup on the portal's public host only", async () => {
  const address = jwksServer.address();
  assert(address && typeof address !== "string");
  const seen: { email: string; hints?: SignInHints }[] = [];
  const recording = createAccessMiddleware(
    () => ({ audience, issuer, jwksUrl: new URL(`http://127.0.0.1:${address.port}/cdn-cgi/access/certs`) }),
    async (email, hints) => { seen.push({ email, hints }); return { principalId: "principal-1", capabilities: ["read"] }; },
  );
  const token = await accessToken();
  assert.equal((await recording(request("/", token, "GET", { host: "keel.example.com" }))).status, 200);
  assert.equal((await recording(request("/", token, "GET", { host: "127.0.0.1:3000" }))).status, 200);
  assert.equal(seen[0].email, authenticatedEmail);
  assert.equal(seen[0].hints?.claims?.email, authenticatedEmail);
  assert.equal(seen[0].hints?.claims?.sub, "operator-id");
  assert.equal(typeof seen[0].hints?.lookupIdentity, "function");
  assert.equal(seen[1].hints?.lookupIdentity, undefined);
});

test("the identity lookup goes only to the configured or a public https origin", () => {
  assert.equal(accessIdentityOrigin("keel.techinsiderbytes.com", {}), "https://keel.techinsiderbytes.com");
  assert.equal(accessIdentityOrigin("Keel.Example.com", {}), "https://keel.example.com");
  for (const host of [null, "", "localhost", "localhost:3000", "127.0.0.1", "10.0.0.5:443", "keel.example.com:8443", "metadata.internal", "box.local", "evil.example.com/x"]) {
    assert.equal(accessIdentityOrigin(host, {}), null, String(host));
  }
  assert.equal(accessIdentityOrigin("anything", { KEEL_PORTAL_URL: "https://portal.example.com/app" }), "https://portal.example.com");
  assert.equal(accessIdentityOrigin("keel.example.com", { KEEL_PORTAL_URL: "http://portal.example.com" }), null);
});

test("the identity lookup sends the sign-in token as Access's cookie and never throws", async () => {
  const calls: { url: string; cookie: string | null }[] = [];
  const answer = (body: unknown, status = 200) => (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), cookie: new Headers(init?.headers).get("cookie") });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  assert.deepEqual(await fetchAccessIdentity("https://keel.example.com", "a.b.c", answer({ name: "Lee Chen" })), { name: "Lee Chen" });
  assert.deepEqual(calls[0], { url: `https://keel.example.com${ACCESS_IDENTITY_PATH}`, cookie: "CF_Authorization=a.b.c" });
  assert.equal(await fetchAccessIdentity("https://keel.example.com", "a.b.c", answer({ err: "no" }, 401)), null);
  assert.equal(await fetchAccessIdentity("https://keel.example.com", "a.b.c", (async () => { throw new Error("offline"); }) as typeof fetch), null);
});

test("a valid Access JWT for an unregistered email is refused", async () => {
  const address = jwksServer.address();
  assert(address && typeof address !== "string");
  const unregisteredMiddleware = createAccessMiddleware(
    () => ({
      audience,
      issuer,
      jwksUrl: new URL(
        `http://127.0.0.1:${address.port}/cdn-cgi/access/certs`,
      ),
    }),
    async () => ({ principalId: null, capabilities: [] }),
  );

  const response = await unregisteredMiddleware(
    request("/api/drift", await accessToken()),
  );

  assert.equal(response.status, 403);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-middleware-next"), null);
  assert.deepEqual(await response.json(), { error: "forbidden" });
});

function middlewareResolvingWith(resolve: () => Promise<ResolvedIdentity>) {
  const address = jwksServer.address();
  assert(address && typeof address !== "string");
  return createAccessMiddleware(
    () => ({ audience, issuer, jwksUrl: new URL(`http://127.0.0.1:${address.port}/cdn-cgi/access/certs`) }),
    resolve,
  );
}

test("a full database pool during the sign-in check answers an API call with 503 busy JSON", async () => {
  const busyMiddleware = middlewareResolvingWith(async () => {
    throw new DatabaseBusyError(new Error("timeout exceeded when trying to connect"));
  });

  const response = await busyMiddleware(request("/api/drift", await accessToken()));

  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("retry-after"), "5");
  // Fails closed: the request never reaches the route.
  assert.equal(response.headers.get("x-middleware-next"), null);
  assert.equal(response.headers.get(`x-middleware-request-${PRINCIPAL_ID_HEADER}`), null);
  assert.deepEqual(await response.json(), { error: "busy", message: BUSY_MESSAGE });
});

test("a full database pool during the sign-in check shows a busy page for a page request", async () => {
  const busyMiddleware = middlewareResolvingWith(async () => {
    throw new DatabaseBusyError(new Error("timeout exceeded when trying to connect"));
  });

  const response = await busyMiddleware(request("/changes", await accessToken()));

  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("content-type") ?? "", /^text\/html/);
  assert.equal(response.headers.get("x-middleware-next"), null);
  const html = await response.text();
  assert.match(html, /Keel is busy, try again in a moment\./);
  assert.match(html, /Try again/);
});

test("every busy answer is logged with its method, path and Cloudflare ray id, so the 503 can be traced", async (t) => {
  const busyMiddleware = middlewareResolvingWith(async () => {
    throw new DatabaseBusyError(new Error("timeout exceeded when trying to connect"));
  });
  const logged: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { logged.push(args.map(String).join(" ")); });

  const api = await busyMiddleware(request("/api/dashboard?x=1", await accessToken(), "GET", { "cf-ray": "8d1f2a3b4c5d6e7f-FRA" }));
  const page = await busyMiddleware(request("/changes", await accessToken()));

  assert.equal(api.status, 503);
  assert.equal(page.status, 503);
  assert.equal(logged.length, 2);
  assert.match(logged[0], /^\[keel-portal\] 503 busy: GET \/api\/dashboard \(/);
  assert.match(logged[0], /cf-ray 8d1f2a3b4c5d6e7f-FRA/);
  // Only the path is logged, never the query string.
  assert.doesNotMatch(logged[0], /x=1/);
  assert.match(logged[1], /^\[keel-portal\] 503 busy: GET \/changes \(/);
  assert.doesNotMatch(logged[1], /cf-ray/);
});

test("any other sign-in check failure is still a plain 403", async () => {
  const brokenMiddleware = middlewareResolvingWith(async () => {
    throw new Error("relation \"principals\" does not exist");
  });

  for (const path of ["/api/drift", "/changes"]) {
    const response = await brokenMiddleware(request(path, await accessToken()));
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("x-middleware-next"), null);
    assert.deepEqual(await response.json(), { error: "forbidden" });
  }
});

test("a signed-in browser with no principal gets a page that says who to ask, not raw JSON (#1005)", async () => {
  const unregistered = middlewareResolvingWith(async () => ({ principalId: null, capabilities: [] }));

  const response = await unregistered(request("/", await accessToken({ email: "new.person+<b>@example.com" })));

  assert.equal(response.status, 403);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-middleware-next"), null);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html/);
  const html = await response.text();
  assert.match(html, /This account isn't set up in Keel yet\./);
  // The email comes from the token, so it is escaped before it goes into the page.
  assert.match(html, /Ask an admin to add new\.person\+&#60;b&#62;@example\.com\./);
  assert.doesNotMatch(html, /<b>/);
});

// Live 2026-11-04 22:45 (#1005): the port forward in front of Postgres died. Every sign-in
// failed to connect with this exact error and was answered 403 "forbidden" until 14:10 the
// next day. The resolver below goes through the portal's real connect() to a closed port.
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

test("a database that can't be reached during the sign-in check answers 503 and says so, never 403 (#1005)", async (t) => {
  const url = `postgres://keel:unused@127.0.0.1:${await closedPort()}/keel`;
  const unreachable = middlewareResolvingWith(async () => {
    const client = await connect(url);
    await client.end();
    return { principalId: "principal-1", capabilities: ["read"] };
  });
  const logged: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { logged.push(args.map(String).join(" ")); });

  const api = await unreachable(request("/api/drift?x=1", await accessToken(), "GET", { "cf-ray": "9a55c3abcd9394d6-FRA" }));
  assert.equal(api.status, 503);
  assert.equal(api.headers.get("cache-control"), "no-store");
  assert.equal(api.headers.get("retry-after"), "60");
  // Fails closed: the request never reaches the route.
  assert.equal(api.headers.get("x-middleware-next"), null);
  assert.equal(api.headers.get(`x-middleware-request-${PRINCIPAL_ID_HEADER}`), null);
  assert.deepEqual(await api.json(), { error: "database-unreachable", message: UNREACHABLE_MESSAGE });

  const page = await unreachable(request("/", await accessToken()));
  assert.equal(page.status, 503);
  assert.equal(page.headers.get("x-middleware-next"), null);
  assert.match(page.headers.get("content-type") ?? "", /^text\/html/);
  const html = await page.text();
  assert.match(html, /Keel can't reach its database right now\./);
  assert.match(html, /Nothing was changed\. Try again in a minute\./);

  assert.equal(logged.length, 2);
  assert.match(logged[0], /^\[keel-portal\] 503 database unreachable: GET \/api\/drift \(sign-in check failed: ECONNREFUSED, cf-ray 9a55c3abcd9394d6-FRA\)$/);
  assert.doesNotMatch(logged[0], /x=1/);
  assert.match(logged[1], /^\[keel-portal\] 503 database unreachable: GET \/ \(/);
});

test("connection failures count as an unreachable database, other errors do not", () => {
  const coded = (message: string, code: string) => Object.assign(new Error(message), { code });
  assert.equal(databaseUnreachableReason(coded("connect ECONNREFUSED 127.0.0.1:5433", "ECONNREFUSED")), "ECONNREFUSED");
  assert.equal(databaseUnreachableReason(coded("getaddrinfo ENOTFOUND db.internal", "ENOTFOUND")), "ENOTFOUND");
  assert.equal(databaseUnreachableReason(coded("connect ETIMEDOUT 10.0.0.5:5432", "ETIMEDOUT")), "ETIMEDOUT");
  assert.equal(databaseUnreachableReason(coded('password authentication failed for user "keel"', "28P01")), "28P01");
  assert.equal(databaseUnreachableReason(coded("the database system is starting up", "57P03")), "57P03");
  assert.equal(databaseUnreachableReason(new Error("Connection terminated unexpectedly")), "connection terminated");
  assert.equal(databaseUnreachableReason(new Error("Connection terminated due to connection timeout")), "connection terminated");
  // localhost resolving to two addresses, both refused.
  const both = Object.assign(new AggregateError([coded("connect ECONNREFUSED ::1:5433", "ECONNREFUSED"), coded("connect ECONNREFUSED 127.0.0.1:5433", "ECONNREFUSED")], ""), {});
  assert.equal(databaseUnreachableReason(both), "ECONNREFUSED");

  assert.equal(databaseUnreachableReason(coded('relation "principal" does not exist', "42P01")), null);
  assert.equal(databaseUnreachableReason(new Error("Connection terminated by a bug in this message")), null);
  assert.equal(databaseUnreachableReason(new DatabaseBusyError(new Error("timeout exceeded when trying to connect"))), null);
  assert.equal(databaseUnreachableReason(null), null);
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

// Insights sits behind the same sign-in check as every page.
for (const path of ["/insights", "/insights?days=90"]) {
  test(`GET ${path} rejects an unauthenticated request with 401`, async () => {
    const response = await middleware(request(path));

    assert.equal(response.status, 401);
  });
}

// Every change and its API, which entity-scoped readers now reach too (issue #981), sit
// behind the same sign-in check.
for (const path of ["/changes?view=feed", "/changes?view=feed&days=7", "/api/changes/feed", "/api/changes/feed?days=7&by=service"]) {
  test(`GET ${path} rejects an unauthenticated request with 401`, async () => {
    const response = await middleware(request(path));

    assert.equal(response.status, 401);
  });
}

// Issue #980: "Send this week's summary now" and the rule routes it uses go through the
// same sign-in check: no Access assertion, no write.
for (const [method, path] of [["POST", "/api/channels/00000000-0000-4000-8000-000000000001/summary"], ["POST", "/api/subscriptions"], ["PATCH", "/api/subscriptions/00000000-0000-4000-8000-000000000002"]]) {
  test(`${method} ${path} rejects an unauthenticated request with 401`, async () => {
    const response = await middleware(request(path, undefined, method));

    assert.equal(response.status, 401);
  });
}

// The Owner review page (issue #964) goes through the same sign-in check as every page.
test("GET /owner-review rejects an unauthenticated request with 401", async () => {
  const response = await middleware(request("/owner-review"));

  assert.equal(response.status, 401);
});

// The Restore section's sub-pages sit behind the same sign-in check as every page.
for (const path of ["/restore/follow-up-steps", "/restore/past-restores", "/restore/past-restores?jobs=failed"]) {
  test(`GET ${path} rejects an unauthenticated request with 401`, async () => {
    const response = await middleware(request(path));

    assert.equal(response.status, 401);
  });
}

test("an old page URL is sent to the page's new name, with the rest of the path and the query", async () => {
  const token = await accessToken();
  for (const [from, to] of [
    ["/drift?open=dr5", "/changes?open=dr5"],
    ["/policies/p1", "/rules/p1"],
    ["/principals?role=investigator", "/people?role=investigator"],
    ["/readiness", "/emergency-access"],
    ["/baselines/new", "/approved-setups/new"],
    ["/benchmarks?result=failing", "/compliance?result=failing"],
  ]) {
    const response = await middleware(request(from, token));
    assert.equal(response.status, 307, from);
    assert.equal(response.headers.get("location"), to, from);
  }
  // Not before the sign-in check, not for the API (which kept its names), not for a post.
  assert.equal((await middleware(request("/drift"))).status, 401);
  assert.equal((await middleware(request("/api/drift", token))).headers.get("location"), null);
  assert.equal((await middleware(request("/driftwood", token))).headers.get("location"), null);
  assert.equal((await middleware(request("/policies", token, "POST", { "sec-fetch-site": "same-origin" }))).headers.get("location"), null);
});
