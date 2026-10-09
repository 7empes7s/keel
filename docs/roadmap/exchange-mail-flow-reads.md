# Exchange mail flow and protection reads (issue #153)

Date: 2026-10-09 UTC. Status: implemented and fixture-tested only. Every read ships
**disabled**. No tenant was read, and nothing contacted Microsoft.

## Why

Exchange coverage was the named mailboxes (at most 50) plus `Get-OrganizationConfig`.
None of the organization-wide mail settings were backed up, yet they are the settings
most often changed, and a broken transport rule or connector stops mail.

## What is collected

A new workload, `exchange-mail-flow`, with eleven declared reads in
`engine/collect/workloadContract.mjs`. Each is one `Get-` cmdlet with no parameters, in
the Exchange Online session of `ExchangeOnlineManagement`. Each needs
`Exchange.ManageAsApp` and the Exchange Administrator role, like the other Exchange reads.

| Operation | Cmdlet | Stored under (identity) |
| --- | --- | --- |
| `mailflow.accepted-domains` | `Get-AcceptedDomain` | `accepted-domain:<domain name>` |
| `mailflow.remote-domains` | `Get-RemoteDomain` | `remote-domain:<domain name>` (`*` is the default) |
| `mailflow.transport-rules` | `Get-TransportRule` | `transport-rule:<Guid>` |
| `mailflow.inbound-connectors` | `Get-InboundConnector` | `inbound-connector:<Guid>` |
| `mailflow.outbound-connectors` | `Get-OutboundConnector` | `outbound-connector:<Guid>` |
| `mailflow.anti-spam-policies` | `Get-HostedContentFilterPolicy` | `anti-spam-policy:<Guid>` |
| `mailflow.anti-phish-policies` | `Get-AntiPhishPolicy` | `anti-phish-policy:<Guid>` |
| `mailflow.anti-malware-policies` | `Get-MalwareFilterPolicy` | `anti-malware-policy:<Guid>` |
| `mailflow.dkim-signing` | `Get-DkimSigningConfig` | `dkim:<domain>` |
| `mailflow.safe-links-policies` | `Get-SafeLinksPolicy` | `safe-links-policy:<Guid>` |
| `mailflow.safe-attachment-policies` | `Get-SafeAttachmentPolicy` | `safe-attachment-policy:<Guid>` |

Safe Links and Safe Attachments were named in the issue's gap but not in its cmdlet
list. They are included.

**Identity.** Domains (accepted, remote, DKIM) are keyed by the domain name, lower-cased.
The domain is what the object configures, it is unique in the tenant, and a domain
removed and added back is the same domain. Rules, connectors and policies are keyed by
their `Guid`. Their names are unique too, but a rename would change the key; the Guid
does not change. The name is kept as a field, for a later restore to match an object
that was deleted and recreated. An answer with no valid Guid or domain is not guessed
at: it is counted as `unidentified` and the run is `partial`.

**Fields.** Each family keeps a declared list of fields (`FAMILIES` in
`engine/collect/workloads/mailFlow.mjs`), and everything else is dropped unread. That
drops the DKIM public keys (published in DNS anyway), validation timestamps and
internal ids. Transport rules keep `Description` (Exchange's full text of the rule)
plus the common typed conditions, exceptions and actions.

**Secrets.** No declared field holds a credential. Connectors carry certificate names,
TLS domains and IP ranges, never a password or key. An administrator could still type
a secret into a rule (a header value, say). Every kept value goes through the shared
redactor (`redactPayload` in `engine/telemetry/events.mjs`). A credential-shaped value
is stored as `[redacted]` with field status `redacted`, never as the value. A
transport rule that stamps a header whose name suggests a credential (`X-Api-Key`,
anything with auth, token, secret, key or password) has its header value and its
Description redacted too, because an opaque key does not look like a credential.

## How it runs, and how it is enabled

- `readMailFlow` reads the families through the bounded cmdlet job
  (`engine/powershell/jobQueue.mjs`). The container side, `ops/powershell/run-cmdlet.ps1`,
  allows exactly these eleven cmdlets with no parameters (`$AllowedMailFlow`). A test
  checks that both lists match.
- A family that fails is `failed` or `denied`, with the structured error. A successful
  empty answer is a family with no objects.
- **Not licensed is labelled, and it is a gap.** Safe Links and Safe Attachments need
  Microsoft Defender for Office 365. Without it, or when the app's Exchange role no
  longer includes the cmdlet, Exchange does not expose it (`CommandNotFoundException`),
  and the family is recorded as `not-licensed`. These reads only run once they are
  live-qualified, so the cmdlet once existed: losing it means those policies are no
  longer backed up, and the run is `partial`. A tenant that never had the licence
  never qualifies these reads, so they are listed as skipped instead. The same error
  on any other cmdlet is a failure. A run that kept no object is `failed` when every
  family failed, was not licensed, or answered only objects with no identity (issue #157
  review).
- **Disabled until qualified.** `collectMailFlow` records a `disabled` run and sends
  nothing unless:
  - the Exchange mailbox workload is qualified (as Purview requires, so the order stays
    SharePoint, Teams, Exchange, then mail flow);
  - and the nine core reads are each live-qualified and enabled in the task-101 ledger.
- Safe Links and Safe Attachments are optional. Each runs only when its own ledger row
  is enabled. Otherwise it is listed under `skipped` with the row's reason, and the run
  is `partial`, because KEEL did not look.
- The workload is registered with `enabledByDefault: false` and appears in the coverage
  report. Runs are stored in the existing `workload_collection` and
  `workload_observation` tables. No schema change.
- There is no write capability: no write operation is declared, no `Set-`, `New-` or
  `Remove-` cmdlet is allowed, and the `exchangeMailFlow` type is refused as an Entra
  wave.

## Proof

`engine/roadmap/exchange-mail-flow.test.mjs` (4 tests) runs against the isolated test
database and a fake container behind the real job spawn path. It checks:
- the declarations, the probe and the allowlists;
- that fixture proof never enables a read;
- identities, field filtering and redaction;
- the not-licensed, denied, crashed and empty cases;
- activation, persistence and the coverage entry.

The read-only probe (`ops/powershell/probe-workloads.ps1`) now runs all eleven cmdlets
in its Exchange Online block (`Get-TransportRule` was already there).

## What an operator must do to live-qualify it

1. Qualify the Exchange mailbox workload first (`docs/roadmap/exchange-live-acceptance.md`).
   Mail flow cannot activate before it.
2. Make sure the collector app has `Exchange.ManageAsApp` and the Exchange Administrator
   role.
3. On the host, run the read-only probe for Exchange Online with the collector
   credential: a `run-job.sh` job `{ "mode": "probe", "workload": "exo" }` in the
   PowerShell container, or `probe-workloads.ps1 -Workloads exo` directly. Save its
   JSON output.
4. Import the capture and the observed grants:
   `node tools/qualification/workloads.mjs --tenant-ref sha256:... --capture probe.json --grants grants.json`.
   Each `mailflow.*` row that read successfully becomes `live-qualified`.
5. In a tenant without Defender for Office 365, the Safe Links and Safe Attachments
   probe rows fail with the cmdlet not found. Those two rows stay disabled, and
   collection runs without them, as `partial`, with the reason listed.

## Not included

- **Restore.** Nothing here writes. Restoring rules, connectors, domains and policies
  is a separate task, once these reads are live-qualified.
- **Policy scoping rules.** The rules that assign protection policies to users and
  domains (`Get-HostedContentFilterRule`, `Get-AntiPhishRule`, `Get-MalwareFilterRule`,
  `Get-SafeLinksRule`, `Get-SafeAttachmentRule`) are not read. Without them, a policy
  backup does not say who the policy applies to.
- **Other mail settings.** Outbound spam policies, connection filter policies, quarantine
  policies, journal rules and mobile device policies are not read.
- **Live facts.** Field names and the not-found behaviour of unlicensed cmdlets come
  from Microsoft's documentation, which could not be fetched from this environment,
  and have not been measured live.
- **Probe overlap.** The probe's `defender` block (Security and Compliance session)
  already runs `Get-AntiPhishPolicy`, `Get-SafeLinksPolicy` and
  `Get-SafeAttachmentPolicy`. Rows map to reads by cmdlet name, so a success there
  also counts as proof for the same read.
