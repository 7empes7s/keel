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

### Live records (gap P2)

The coverage report loads the signed live records committed under
`docs/release/qualifications/` (Entra write captures in `entra-live/` and the
SharePoint, Teams, Exchange, OneDrive and Purview acceptance records) and
verifies each one for this portal's tenant with the same code the release
ledger and `tools/qualification/entraLive.mjs promote` use. A verified record
shows its operation as proven on this tenant; a record that does not verify
(no key, signature mismatch, another tenant, more than 30 days old) counts as
not live and the page says why. Records are re-checked at most every 10
minutes, so an expired record stops counting without a restart.

| Variable | Default | Purpose |
|---|---|---|
| `KEEL_QUALIFICATION_HMAC_KEY` | unset | The evidence signing key. Prefer the file below over the unit environment. |
| `KEEL_QUALIFICATION_ENV_PATH` | `/etc/keel/qualification.env` | A file with one line `KEEL_QUALIFICATION_HMAC_KEY=...`. It must be owned by the portal user and mode 600; a file other users can read is ignored and the page says so. |
| `KEEL_LIVE_EVIDENCE_DIR` | `../docs/release/qualifications` (from `portal/`) | Where the committed records are read from. |

Never commit the key. Without it every record shows as not live, with the
reason "the key that checks live records is not set up on this server".

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
