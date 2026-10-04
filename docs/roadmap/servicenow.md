# ServiceNow configurable workflow adapter (task-97)

Date: 2026-10-04 UTC. Status: implemented and tested against a fake ServiceNow
instance only (an injected `fetch`), with an isolated test database. No ServiceNow
instance was contacted. No credential was read. No live qualification is claimed. D6
stays pending until task-118 has test-instance evidence: an instance, mapped test users
and a workflow inside the instance.

## The rule

KEEL keeps the one canonical decision (task-96). A ServiceNow record mirrors it. The
record's approval state only asks KEEL to decide. It is never authority on its own: a
ServiceNow approval decides only for the record's current plan version and digest, and
only through a mapped, enabled KEEL principal who may approve that request now.

## What was built

- `engine/itsm/adapters/servicenow.mjs`, the adapter. It implements the task-96 contract
  (`name`, `deliver`, `fetchRecord`) over the REST Table API.
  - **Explicit mappings, no defaults.** The config names all of these:
    - the instance (plain `https` origin) and the table;
    - the field holding the approval state, and the state values that mean approved and
      that mean rejected;
    - the field naming who decided (it may be dot-walked, such as `u_owner.email`);
    - the fields KEEL writes the plan version, plan digest, request id and decision into;
    - the access token, as a reference only (`credential.tokenRef`, `env:NAME`).

    Any other state value is informational, and the bridge ignores it. Nothing assumes
    the out-of-the-box `change_request` workflow.
  - **A missing mapping disables the adapter visibly.** `serviceNowConfigProblems`
    returns every missing or ambiguous mapping as a code and a sentence: a missing field
    or state map, one value mapped to both outcomes, two roles sharing a field, an
    instance address that is not plain `https`, a token that is not a reference.
    `createServiceNowAdapter` refuses (`disabled`) while any problem remains, so a
    half-configured adapter never sends or reads. `runServiceNowCycle` returns
    `{ enabled: false, problems }` without contacting the instance.
  - **Outbound** (`deliver`). PATCH `/api/now/table/{table}/{sys_id}` sets only KEEL's
    fields:
    - a `record` event writes the plan version, digest and request id;
    - a `decision` event writes the canonical outcome, its digest and the event id;
    - a `conflict` event writes the canonical outcome and the status ServiceNow
      reported.

    KEEL never writes the approval state field, so its own writes cannot be read back as
    an approval. Setting the same values again is harmless, so at-least-once delivery
    is safe.
  - **Failures are kept, never lost.** `deliver` throws on every failure:
    - a network error, timeout, 401, 408, 429 or 5xx is transient, so the outbox keeps
      the event pending and retries it;
    - 400, 403, 404, 405, 409, 413 and 422 are permanent, so the event is quarantined
      with its reason.

    The canonical decision is never changed by a failed write. Error text carries the
    method and status only, never the token.
  - **Authenticated polling** (`fetchRecord`). GET with `sysparm_fields` (only the
    mapped fields), `sysparm_display_value=false` and
    `sysparm_exclude_reference_link=true`. The state is mapped through the config only.
    A 404 reads as absent, and any other failure throws, so nothing is decided.
  - **Authenticated callbacks** (`verifyCallback`, `handleServiceNowCallback`).
    - The header `x-keel-servicenow-signature: t=<unix seconds>,v1=<base64
      HMAC-SHA256 of "t.body">` is required. The secret is a reference
      (`callback.secretRef`), and the comparison is constant-time.
    - The timestamp must be inside the window: `callback.maxSkewSeconds`, 30 to 900
      seconds, 300 by default.
    - The event id is `servicenow:<sys_id>:<sys_mod_count>`, so a replay inside the
      window is a duplicate in the bridge's inbox and acts no further.
    - A signed callback is then **read back from the instance** with KEEL's own token.
      It acts only if the instance shows the same state, approver, version and digest.
      Otherwise it is `refused-instance-mismatch`, which covers a leaked secret or a
      callback overtaken by a later change. Every refusal before the bridge is written
      as `itsm-callback` evidence.
    - Without `callback`, every callback is refused (`refused-callbacks-off`) and
      polling is the only inbound path.
  - **Reconciliation after a lost delivery** (`runServiceNowCycle`). The cycle records
    portal decisions, delivers due outbound events (`runMirrorCycle`), then polls every
    record whose request is still pending (`reconcileRecord`). The bridge's
    deterministic reconcile event id makes a second poll a duplicate, and a late
    original callback finds the request already decided.
  - **Config storage** (`saveServiceNowConfig`, configuration capability). The config
    is stored in `itsm_adapter_config`. Unknown keys, secret-shaped values (bearer
    tokens, JWTs, private keys, credentials in a URL) and any credential that is not an
    `env:` reference are refused. An incomplete config is stored, so the page can name
    what is missing. Each save is written as `itsm-adapter-config` evidence.
  - **Status** (`serviceNowStatus`, read capability). Whether ServiceNow is on, its
    problems, the mapping (secret names only), the mirror's counts and the last 20
    held-back updates with their reasons.
- `engine/store/schema.sql`, additive only: `itsm_adapter_config` (tenant_ref, adapter,
  config, updated_by, updated_at). Nothing existed before, so there is no legacy data
  to migrate. Re-applying the schema is a no-op, and the test applies it twice.
- `tools/qualification/servicenow.mjs check --config <file> [--tenant <ref>]`. An offline
  check: it validates a config and prints a task-45-shaped ledger record. The record is
  always `evidenceLevel: 'fixture-tested'`, `synthetic: true` and
  `liveQualified: false`, with `liveGate: 'task-118'`. It never contacts an instance or
  resolves a reference. It exits 0 when complete and 1 when a mapping is missing.
- Portal.
  - `GET /api/integrations/servicenow` (read) and `PUT /api/integrations/servicenow`
    (configuration, recorded attempt) are in `portal/lib/servicenow.ts`. The read
    surface is registered as `DATA_SURFACES.integrationsServiceNowApi`.
  - The Integrations page has a "ServiceNow change approvals" section
    (`portal/components/servicenow-panel.tsx`), shown as verdict, explanation and record:
    - when ServiceNow is off, it says why, listing each missing setting in words;
    - when it is on, it lists the values counting as approved and rejected, how a
      ServiceNow decision counts, and whether callbacks are signed or KEEL polls;
    - it shows delivery counts, and each held-back update as a sentence ending "KEEL's
      decision stands.";
    - it says "Not yet proven against a real ServiceNow instance.".
  - The record holds the table, field names, raw state values, secret names, held-back
    event ids, record sys_ids, error text, the API contract source and the proof level.
  - The page verdict leads with a ServiceNow problem (off, or updates held back) ahead
    of the audit-record destinations.
  - UI harness: `/integrations` (on, one update held back) and
    `/integrations/servicenow-off` (two missing settings) pass the contract checks 1 to 7
    and axe in both themes, with per-route record IDs. The allowlist stays empty.

## API contract source (Global Constraint 8)

- **Source:** https://www.servicenow.com/docs/r/api-reference/rest-apis/c_TableAPI.html,
  retrieved 2026-10-04.
- **Retrieval limits:** the page itself was blocked by this build's egress proxy, so the
  points used were taken from the search index's copy of the official docs:
  - GET and PATCH on `/api/now/table/{table}/{sys_id}`;
  - a `result` body;
  - 404 for a missing record;
  - `sysparm_fields` with dot-walking;
  - `sysparm_display_value`;
  - `sysparm_exclude_reference_link`.

  Callback signing relies on `GlideCertificateEncryption.generateMac(key, 'HmacSHA256',
  data)`, which returns base64 per the same index. The instance-side business rule or
  flow that signs and sends is not built here (task-118).
- **Credential mode:** an OAuth bearer token, by reference only. How the token is
  obtained and refreshed (the OAuth app in `/etc/keel/servicenow.env`) is outside this
  task. A 401 is retried so that a refreshed token can take over.

## Acceptance evidence (`engine/roadmap/servicenow.test.mjs`, 6 tests)

- **A non-default workflow maps to the same canonical approval.** Two tenants:
  - one on `change_request.approval` with `approved` and `rejected`;
  - one on a custom table `u_keel_gated_change` with gate field `u_gate`, its own
    approver and plan fields, `gate_passed` for approved, and `gate_blocked` or
    `gate_withdrawn` for rejected.

  KEEL writes the plan into each workflow's own fields. In the custom workflow the value
  `approved` is an intermediate step and is `ignored-status`. Each workflow's own
  approval yields the same canonical decision (outcome, approver, action, plan digest,
  version, source) and one job. A custom rejection value rejects with no job.
- **A lost callback is reconciled once.** The instance approves and the callback never
  arrives. The cycle's poll applies it once. A second poll is a duplicate, and a second
  cycle applies nothing. The late original callback, authentic and confirmed, is
  `already-decided`. The result is one job and one decision, and the decision is written
  back to the decision field, not the state field.
- **A forged or replayed event cannot widen authority.** Each of these is refused, and
  the request stays pending with no job:
  - unsigned, even when the instance agrees with every field;
  - signed with a guessed key;
  - an incomplete header;
  - a body altered after signing;
  - an authentic callback replayed after the window;
  - a callback signed with a leaked secret but claiming another approver
    (`refused-instance-mismatch`);
  - an authentic callback from a mapped viewer (`refused-not-eligible`);
  - an authentic version-1 approval replayed after a re-plan to version 2.

  Every refusal is evidenced. The authentic callback decides once, and its replay
  inside the window is a duplicate. With callbacks off, a callback is refused.
- **A missing mapping disables the adapter visibly.**
  - A config missing the rejected values and the approver field lists exactly those two
    problems, the adapter refuses to build, and a cycle never calls `fetch`.
  - Overlapping state values, a shared field and plain `http` are each a problem.
  - Not set up reads as `not-configured`.
  - Secret values and unknown keys are refused, and a viewer cannot save.
- **A failed external update does not roll back the canonical decision silently.**
  - A network error while writing the decision back leaves the event pending, with the
    error and no token, and the status shows the update waiting. The same event is
    delivered once when the network returns.
  - A 403 quarantines the event, and the request stays rejected. The status shows the
    held-back update with `HTTP 403` and its reason, and `listMirror` counts it.
  - 401, 429 and 503 are retried, and a vanished record is permanent.
  - The evidence chain verifies.
- **The qualification check never claims a live result.**

Portal: `portal/test/servicenow.test.ts` covers three things:

- the off verdict and its listed problem;
- the held-back sentence, with no internal vocabulary outside the record;
- the GET and PUT routes refusing callers without `read` or `configuration`.

## Required mutation checks

Each mutation was applied to `engine/itsm/adapters/servicenow.mjs`. Each made the named
test fail, and each was reverted. The restored suite passes 6 of 6.

1. **Hardcode default change-request states.** `canonicalStatus` maps `approved` and
   `rejected` instead of the configured values. The non-default workflow test fails:
   `gate_passed` no longer decides, and the custom workflow's intermediate `approved`
   would.
2. **Accept unsigned unauthenticated callback.** `verifyCallback` skips the signature
   and window checks when the header is absent. The forged/replayed test fails: the
   unsigned callback is applied instead of `refused-unsigned`.
3. **Lose pending mirror after network error.** A network error on PATCH resolves as
   success. The failed-update test fails: the decision event is marked delivered after
   the network error instead of staying pending (`retried: 1`).

The contract's UI mutation was also checked: rendering a held-back record's sys_id
outside the record makes the identifier check on `/integrations` fail.

## Limits

- **Not live.** Fixture-tested against a fake instance. ServiceNow's real responses,
  field types, ACLs, OAuth flow and the instance-side signing script are unproven until
  task-118. D6 remains pending.
- **No HTTP ingress for callbacks.** `handleServiceNowCallback` is the verified entry
  point, but no public route exposes it. The portal's API routes require a signed-in
  principal, and an unauthenticated machine route needs its own exposure decision.
  Polling (`runServiceNowCycle`) is the working inbound path.
- **No scheduled job.** No job kind runs `runServiceNowCycle` yet. It is the entry point
  a scheduled job or operator command calls, as with task-96's `runMirrorCycle`.
- **No mapping form.** The mapping is saved with `PUT /api/integrations/servicenow` (and
  checked offline with the CLI). The page shows it read-only, in words, with the raw
  mapping in its record.
- **Identity.** The approver field's value is matched to `itsm_identity_map`
  (task-96). Choosing a stable attribute, such as `user_name` or `email` via dot-walk,
  is the operator's mapping decision. A ServiceNow-side rename breaks the match safely
  (`unmapped-identity`).
- **Callback confirmation compares four fields.** A callback overtaken by a later
  change is refused, not queued. The next poll reads the current state.
- **Decision text only.** KEEL writes its decision into one mapped text field. It does
  not add work notes, change the record's state or close it.
