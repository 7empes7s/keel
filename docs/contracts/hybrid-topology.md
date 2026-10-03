# Hybrid topology contract, version 1

Source: `engine/contracts/topology.mjs`. Tests: `engine/roadmap/hybrid-contract.test.mjs`.
Implementation notes and limits: `docs/roadmap/hybrid-contract.md`.

## The runtime is deferred

KEEL does not run anything on-premises. There is no agent, no polling service and no
connection into a customer network. This contract fixes what a future adapter would send and
receive, and what the cloud side refuses. Today every command reads "not dispatchable", and
dispatch always throws `HybridRuntimeDeferredError`. The test suite checks that no shipped
entrypoint (a `cli/` script, an `ops/` systemd unit or a package `bin`) loads this contract or
is named like an agent.

## Direction

A future adapter polls KEEL outbound. KEEL answers a poll with at most one command. The adapter
reports one result per intent. KEEL never initiates a connection.

| Kind | Direction | Carries |
| --- | --- | --- |
| `poll` | adapter to KEEL | adapter identity, tenant pin, capability evidence |
| `command` | KEEL to adapter | command identity, lifetime, operation intents |
| `result` | adapter to KEEL | command and intent identity, outcome, result provenance |

## Common envelope

| Field | Rule |
| --- | --- |
| `schemaVersion` | `1`. Anything else, including a missing value, is refused. |
| `kind` | `poll`, `command` or `result`. |
| `messageId` | Single-use. A repeat is refused. |
| `tenantRef` | Must equal the tenant KEEL is pinned to. |
| `adapter.adapterId` | Required. |
| `adapter.adapterKind` | `active-directory` only. |
| `adapter.credentialRef` | Where the adapter's credential lives. Never the credential. |
| `sentAt` | ISO timestamp. |

A key that names a secret (password, token, private key, certificate, secret, API key), or a
string that looks like credential material, refuses the whole message.

## Poll

`capabilityEvidence` is a list of `{ tenantRef, resourceType, operation, claim, proofRef }`.
Each record must name the pinned tenant. `claim` uses the capability registry levels. While the
runtime is deferred, only `declared` is accepted, because nothing exists that could have tested
or qualified an adapter.

## Command

`commandId` is single-use. `issuedAt` and `expiresAt` bound a lifetime of at most 15 minutes.
`intents` is a non-empty list of:

| Field | Rule |
| --- | --- |
| `intentId` | Unique within the command. |
| `resourceType`, `naturalKey`, `operation` | The object and what to do to it. |
| `sourceAuthority` | `cloud`, `on-premises`, `hybrid` or `unknown`. |
| `executionSite` | `on-premises` or `cloud`. |
| `observed` | Optional observed fields. If they show the object is synced, the intent must declare `on-premises` authority. |

Supported intents (all others are refused, and one refused intent refuses the command):

| Adapter kind | Type | Operation | Authority | Executes |
| --- | --- | --- | --- | --- |
| `active-directory` | `user` | `update` | on-premises | on-premises |
| `active-directory` | `group` | `update` | on-premises | on-premises |

## Result

`commandId` and `intentId` must name a command KEEL issued to this tenant and adapter, and one
of its intents. Each intent accepts one result. `outcome` is `succeeded`, `failed`, `refused`
or `uncertain`. `provenance` carries:

- `intentDigest`: the SHA-256 of tenant, adapter, command, intent, object, operation and
  execution site. A result re-pointed at another command does not match.
- `observedAt`: inside the command's lifetime.
- `adapterBuild`: required.
- `synthetic`: must be `false`.

## Cloud write refusal

`engine/safety/syncedObjectGuard.mjs` decides an object's source of authority. An object with
`onPremisesSyncEnabled: true` is on-premises authoritative, whatever any hint says. An object
marked `on-premises`, `hybrid` or an unreadable authority is refused for every cloud-side
write: restore selection, restore apply and delete. The topology contract uses the same guard
for a cloud execution site, so the two can never disagree.
