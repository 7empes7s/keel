# Purview retention and DLP reads (issue #157)

Date: 2026-10-09 UTC. Status: implemented and fixture-tested only. Every read ships
**disabled**. No tenant was read, and nothing contacted Microsoft.

## Why

Purview coverage was sensitivity labels and their publishing policies only. Retention
policies decide how long mail, files and chats are kept, and DLP policies decide what may
leave the organization. Neither was backed up.

## What is collected

A new workload, `purview-retention-dlp`, with four declared reads in
`engine/collect/workloadContract.mjs`. Each is one `Get-` cmdlet with no parameters, in
the Security & Compliance session (`Connect-IPPSSession`) of `ExchangeOnlineManagement`,
the same session the label reads use. Each needs `Exchange.ManageAsApp` and the
Compliance Administrator role, like the label reads.

| Operation | Cmdlet | Stored under (identity) |
| --- | --- | --- |
| `purview.retention-policies` | `Get-RetentionCompliancePolicy` | `retention-policy:<Guid>` |
| `purview.retention-rules` | `Get-RetentionComplianceRule` | `retention-rule:<Guid>` |
| `purview.dlp-policies` | `Get-DlpCompliancePolicy` | `dlp-policy:<Guid>` |
| `purview.dlp-rules` | `Get-DlpComplianceRule` | `dlp-rule:<Guid>` |

**Why a new workload, not more reads in `purview-labels`.** The label workload
(task 106) has its own activation, which needs both label rows enabled, plus ledger rows,
write operations, change tracking and tests. Adding families to it would have changed
when labels activate, and a tenant without a DLP licence would have held labels back. A
separate workload, built like `exchange-mail-flow` (issue #153), leaves the label
workload, its qualification and its tests unchanged. The two workloads share the
session and the lock-marker reader (`lockState`).

**Identity.** Policies and rules are keyed by their `Guid`. Names are unique too, but a
rename would change the key, and the Guid does not change. The name is kept as a field,
for a later restore to match an object that was deleted and recreated. An answer with no
valid Guid is not guessed at: it is counted as `unidentified`, and the run is `partial`.

**Rules keep their parent.** Each rule names its policy in `Policy` (the policy's Guid).
It is stored as `parentPolicy` on the observation. DLP rules also keep
`ParentPolicyName`. After every family is read, each rule gets a `parentStatus`:
- `found`: its policy was read in this run;
- `missing`: its own policy family (retention policies for a retention rule, DLP
  policies for a DLP rule) was read in full and has no policy with that Guid. A
  retention rule that names a DLP policy is `missing` too;
- `none`: the rule names no valid policy Guid;
- `unchecked`: the policy family was skipped, failed, not licensed, capped or had
  answers with no Guid, so a missing parent proves nothing.

A rule that is `missing` or `none` is still stored, but it is counted as `unparented`
and the run is `partial`, because a restore could not place it.

**Duplicates.** When the same Guid is answered twice, the first copy is kept. If the
second copy differs on a declared field, the run records a conflict
(`discovery.conflicts`, with the fields that differ) and is `partial`, because KEEL
cannot tell which copy is current.

**Fields.** Each family keeps a declared list of fields (`FAMILIES` in
`engine/collect/workloads/purviewRetentionDlp.mjs`), and everything else is dropped
unread. The fields are:
- for policies, the mode, type, workloads and every location and exception (the
  mailboxes, sites and groups the policy covers);
- for retention rules, the duration, action, expiry basis, label and query;
- for DLP rules, the conditions, exceptions, actions, notifications and alert settings.

**Locks.** A policy or rule that reports a preservation lock (`RestrictiveRetention`,
which is a Preservation Lock on a retention policy) is recorded as `locked`. One that
reports nothing is `not-reported`, which is not proof that it has no lock.

## Sensitive content and secrets

- **Configuration only.** Only the four cmdlets above can run. The cmdlets that read DLP
  matches, incident details, detection reports, content searches or alerts
  (`RETENTION_DLP_EXCLUDED_CMDLETS`, for example `Get-DlpDetailReport`) are refused in
  Node and are absent from the container allowlist. No item is ever listed to see which
  policy applies to it.
- **Incident settings are not incident data.** `GenerateIncidentReport` and
  `IncidentReportContent` say who receives a report and what it contains. They are kept,
  because they are configuration. No incident is read.
- **Sensitive information types, keyword lists and custom patterns** in a DLP rule are
  configuration and are kept as they are.
- **Credentials are redacted.** Every kept value goes through the shared redactor
  (`redactPayload` in `engine/telemetry/events.mjs`). A credential-shaped value (a bearer
  token or private key pasted into a keyword list, say) is stored as `[redacted]`, with
  field status `redacted`, and the run is `partial`. A secret that does not look like a
  credential (an opaque string) is not caught by shape. A DLP keyword list that matches a
  known secret will hold that secret in the backup.

## How it runs, and how it is enabled

- `readRetentionDlp` reads the families through the bounded cmdlet job
  (`engine/powershell/jobQueue.mjs`). The container side, `ops/powershell/run-cmdlet.ps1`,
  allows exactly these four cmdlets, with no parameters, in the Security & Compliance
  session (`$AllowedPurviewRetentionDlp`). A test checks that both lists match.
- A family that fails is `failed` or `denied`, with the structured error. A successful
  empty answer is a family with no objects. A run that kept no object is `failed` when
  every family failed, was not licensed, or answered only objects with no Guid (and at
  least one did not just say not licensed).
- **Not licensed is labelled, and it is a gap.** DLP needs a licence that includes
  Microsoft Purview Data Loss Prevention. Without it, or when the app's role no longer
  includes the cmdlet, the session does not expose it (`CommandNotFoundException`), and
  the family is recorded as `not-licensed`. A DLP read runs only once it is
  live-qualified, so the cmdlet once existed. Losing it means those policies are no
  longer backed up, and the run is `partial`, never complete. A tenant that never had the
  licence never qualifies these reads, so they are listed as skipped instead. The same
  error on a retention cmdlet is a failure.
- **Disabled until qualified.** `collectRetentionDlp` records a `disabled` run and sends
  nothing unless:
  - the Exchange mailbox workload is qualified (as for Purview labels and mail flow);
  - and both retention reads are live-qualified and enabled in the task-101 ledger.
  Purview label proof is never retention proof: each read needs its own row.
- Each DLP read is optional. It runs only when its own ledger row is enabled. Otherwise it
  is listed under `skipped` with the row's reason, and the run is `partial`.
- The workload is registered with `enabledByDefault: false` and appears in the coverage
  report. Runs are stored in the existing `workload_collection` and
  `workload_observation` tables. No schema change.
- There is no write capability: no write operation is declared, no `Set-`, `New-` or
  `Remove-` cmdlet is allowed, and the `purviewRetentionDlp` type is refused as an Entra
  wave.

## Proof

`engine/roadmap/purview-retention-dlp.test.mjs` (7 tests) runs against the isolated test
database and a fake container behind the real job spawn path. It checks:
- the declarations, the probe, both allowlists, and that the label workload is unchanged;
- that fixture proof never enables a read;
- identities, parent references and their lookup, duplicates, the object cap, locks,
  field filtering and redaction;
- the not-licensed, denied, crashed and empty cases;
- activation (including DLP rules enabled while DLP policies are not), persistence and
  the coverage entry.

Mutation checks, each run once and caught by the test: keying by name instead of Guid,
not counting rules with no parent, accepting any Guid-shaped parent without looking it
up, checking parents against a capped policy family, ignoring a conflicting duplicate,
reporting a run with no usable object as partial, counting a not-licensed family as
complete or as a failure, and running a DLP read whose own row is not enabled.

The read-only probe (`ops/powershell/probe-workloads.ps1`) runs all four cmdlets in its
`scc` block. The two policy reads were already there; the two rule reads are new.

## What an operator must do to live-qualify it

1. Qualify the Exchange mailbox workload first (`docs/roadmap/exchange-live-acceptance.md`).
   Retention and DLP cannot activate before it.
2. Make sure the collector app has `Exchange.ManageAsApp` and the Compliance
   Administrator role.
3. On the host, run the read-only probe for Security & Compliance with the collector
   credential: a `run-job.sh` job `{ "mode": "probe", "workload": "scc" }` in the
   PowerShell container, or `probe-workloads.ps1 -Workloads scc` directly. Save its JSON
   output.
4. Import the capture and the observed grants:
   `node tools/qualification/workloads.mjs --tenant-ref sha256:... --capture probe.json --grants grants.json`.
   Each `purview.retention-*` and `purview.dlp-*` row that read successfully becomes
   `live-qualified`.
5. In a tenant without a DLP licence, the DLP probe rows fail with the cmdlet not found.
   Those two rows stay disabled, and collection runs without them, as `partial`, with the
   reason listed.

## Not included

- **Restore.** Nothing here writes. Restoring retention and DLP policies is a separate
  task, once these reads are live-qualified. That task must:
  - send every write that shortens retention (a shorter `RetentionDuration`, a
    `RetentionComplianceAction` that deletes sooner, a location removed from a policy, a
    policy or rule disabled or deleted) through the content-effect guard
    (`engine/safety/contentEffects.mjs`) as `retention-reducing` or `hold-releasing`,
    with its separate high-impact approval;
  - never change or delete a `locked` policy or rule, and never retry a lock refusal.
- **Retention labels and adaptive scopes.** `Get-ComplianceTag`,
  `Get-AdaptiveScope`, auto-labeling policies, eDiscovery holds and Communication
  Compliance are not read. A retention rule's `ApplyComplianceTag` and
  `PublishComplianceTag` name labels whose definitions this workload does not back up.
- **Distribution detail.** The policies are read without `-DistributionDetail`, which
  the allowlist refuses. `DistributionStatus` is the last status Microsoft reported.
- **Live facts.** Field names and the not-found behaviour of unlicensed cmdlets come from
  Microsoft's documentation, which could not be fetched from this environment, and have
  not been measured live. A declared field that a live answer lacks shows as `unknown`
  and makes the run `partial` until the list is corrected.
