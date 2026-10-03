# Credential and service recovery completion (roadmap task-65)

Restoring configuration is not the same as restoring a working service. KEEL
can never read some parts of an object back, so it can never write them
either:

- client secrets and certificates;
- admin consent;
- for a **recreated** object, its old id: every system outside the tenant that
  referenced the old id must be told about the new one.

After an enforced restore, `engine/restore/completion.mjs` opens **owned
completion items** for that remaining work and tracks each one through to
verified evidence.

## What is emitted

The restore CLI emits items at the end of an enforced promotion. Items are
keyed by the promoted dry-run artifact id (`restore_ref`) and owned by the
principal who requested the dry run. A resource gets items only when it was
actually **recreated** or **soft-restored**. An in-place update leaves nothing
to complete.

| Type | Recreate | Soft restore |
| --- | --- | --- |
| application | credential (`passwordCredentials`), certificate (`keyCredentials`), consent, integration (new id), service validation (sign-in) | service validation |
| servicePrincipal | consent, integration, service validation | service validation |
| identityProvider | credential (client secret), integration, service validation | service validation |
| user | credential (password and MFA re-registration), integration, service validation | service validation |
| any other type | integration (new id), service validation | — |

A recreate is **never** complete immediately: every recreate emits at least an
integration item and a service-validation item. Emission is idempotent on
`(tenant, restore_ref, natural_key, kind, requirement)`, so a retried run adds
nothing.

## States

| Resource state | Meaning |
| --- | --- |
| `configuration-restored` | KEEL wrote and verified the configuration. Credential, consent or integration items are open. |
| `service-validation-pending` | Only the service-validation check remains. |
| `verified-complete` | Every item is closed with evidence, or none was needed. |

Items are either `pending` or `verified`. Reopening is always possible.

## Closing and reopening

`completeItem` / `reopenItem`, or `POST /api/actions/restore/completion` from the
portal:

- **Current authority.** The route checks the downstreamed `restore`
  capability. The engine re-checks the actor's **current** grants in the
  database (`can(..., 'restore')`). Each of these is refused:
  - a revoked grant;
  - a disabled principal;
  - a read-only principal;
  - an unknown or missing actor.
- **Linked evidence.** Closing requires evidence with a closed schema:
  `type` (`ticket`, `link`, `log-reference` or `attestation`), `reference`, and
  optional `note` and `observedAt`.
- **Never the secret.** Any other field is refused, never stored, never
  redacted-and-kept. So is secret-shaped text in an allowed field: JWTs, long
  tokens, PEM blocks, or Entra client-secret shapes. The form asks for "Ticket or
  link — never the secret".
- **Idempotent.** Closing an already-verified item changes nothing and records
  no second event.
- **Recorded.** Every transition writes a `recovery_completion_event` row and a
  `recovery-completion` entry in the tamper-evident evidence chain. These hold
  metadata and the evidence reference only.

## Portal

The page of a succeeded `restore` job (an enforced promotion) shows **Recovery
completion**: each recovered resource with its state, its items, the latest
evidence reference, and, for principals holding `restore`, a reference form
or a Reopen button. The data comes from the read surface
`GET /api/actions/restore/completion/[ref]` (`restoreCompletionApi`).

## Migration and legacy reads

The new tables `recovery_completion_item` and `recovery_completion_event` are
created with `IF NOT EXISTS` and are additive. Restores that ran before this
change have no items, and the job page says no follow-up work is recorded.

## Limitations

- The rules are declarations, not discovery. Downstream integrations are named
  generically ("update every external system that referenced the old id"); KEEL
  does not inventory those systems.
- Evidence is a reference. KEEL does not fetch or validate the linked ticket or
  log.
- Secret detection is pattern-based. The closed evidence schema is the primary
  guard, and pattern refusal is a second line.
- Applications, service principals and identity providers had no registered
  write capability when this shipped. Since task-107 (2026-10-03) application
  create and soft restore and service principal create are fixture-tested
  (see `fidelity-expansion.md`), so their items can be emitted; identity
  providers still have none.
