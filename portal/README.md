# KEEL operator portal

Phase P2 is a Next.js 16 App Router operator console with defence-in-depth
Cloudflare Access authentication. Its read-only dashboard, coverage, drift, and
baseline surfaces read KEEL data directly from Postgres through the existing
engine/query modules.

## Configuration

Set both variables in the service environment:

```text
CLOUDFLARE_ACCESS_TEAM_DOMAIN=https://your-team.cloudflareaccess.com
CLOUDFLARE_ACCESS_AUD=your-application-audience-tag
```

The portal also reads `KEEL_DB_URL` from the process environment, falling back
to `/etc/keel/db.env`, and derives the tenant reference from
`/etc/keel/tenant.json`. Both paths can be overridden with
`KEEL_DB_ENV_PATH` and `KEEL_TENANT_CONFIG_PATH`.

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

## Read-only routes

| Page | API | Purpose |
|---|---|---|
| `/` | `/api/dashboard` | Active baseline, collection, drift, coverage, and integrity posture |
| `/coverage` | `/api/coverage` | Per-type collection and fidelity honesty report |
| `/drift` | `/api/drift` | Sortable/filterable open drift against the active baseline |
| `/baselines` | `/api/baselines` | Named baseline register |

P2 intentionally contains no write handlers or controls. Restore and schedules
belong to later phases.

## Local commands

```sh
npm install
npm test
npm run typecheck
npm run dev
```

The test suite generates local RSA keypairs and serves a JWKS from an ephemeral
loopback port. It does not contact Cloudflare and needs no credentials.
