# KEEL operator portal

Phase P1 is a Next.js 16 App Router scaffold with defence-in-depth Cloudflare
Access authentication. It contains only the authenticated placeholder page and
the health endpoint.

## Configuration

Set both variables in the service environment:

```text
CLOUDFLARE_ACCESS_TEAM_DOMAIN=https://your-team.cloudflareaccess.com
CLOUDFLARE_ACCESS_AUD=your-application-audience-tag
```

`CLOUDFLARE_ACCESS_TEAM_DOMAIN` must be the complete HTTPS team origin with no
path. `CLOUDFLARE_ACCESS_AUD` is the Application Audience (AUD) tag from the
Cloudflare Access application. No Cloudflare credential or private key is
stored by this app; signing keys are fetched from
`<team-domain>/cdn-cgi/access/certs` and cached by `jose`.

## Authentication boundary

Next.js 16 names its middleware file convention `proxy.ts`. The proxy runs for
every application path and reads only `Cf-Access-Jwt-Assertion`. It accepts a
request after verifying all of the following:

- the JWT has a valid RS256 signature from the team's remote JWKS;
- `iss` is the configured team domain;
- `aud` contains the configured application audience;
- the required `exp` claim has not passed; and
- a non-empty `email` claim is present.

Missing configuration, a missing or malformed assertion, verification failure,
wrong audience, or expiry all fail closed with HTTP 401. The proxy overwrites
the internal identity header with the email from verified claims, so a caller
cannot spoof the email rendered by the page.

The one intentional unauthenticated route is `GET /api/health`. It returns the
literal body `{"status":"ok"}` and reads no database, filesystem, or other
service. Even other HTTP methods at that path go through authentication. Any
future route is authenticated automatically and must have a regression test
showing that a request without an assertion receives 401.

## Local commands

```sh
npm install
npm test
npm run typecheck
npm run dev
```

The test suite generates local RSA keypairs and serves a JWKS from an ephemeral
loopback port. It does not contact Cloudflare and needs no credentials.
