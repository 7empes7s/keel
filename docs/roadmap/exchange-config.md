# Exchange mailbox configuration adapter (task 105)

Date: 2026-10-04 UTC. Status: implemented and fixture-tested only. Every read and every
write ships **disabled**. No tenant or mailbox was read or written.

Tasks 120 and 121 merged only their code halves: SharePoint and Teams are not
live-qualified yet. Exchange activation requires Teams qualification first, and Teams
requires SharePoint, so nothing in this task can be enabled today, even with Exchange
evidence.

## What was built

### Declared reads (`engine/collect/workloadContract.mjs`)

Task-101 already declared `exchange.mailbox-settings` (Graph `GET /users/{id}/mailboxSettings`)
and `exchange.client-access` (`Get-CASMailbox`). This task adds two cmdlet reads:

| Operation | Cmdlet | Permission and role |
| --- | --- | --- |
| `exchange.mailbox-hold` | `Get-Mailbox -Identity` | `Exchange.ManageAsApp`, Exchange Administrator |
| `exchange.organization-config` | `Get-OrganizationConfig` | `Exchange.ManageAsApp`, Exchange Administrator |

Both pass the task-101 scope validator and start `disabled`. The read-only probe
(`ops/powershell/probe-workloads.ps1`) now also runs `Get-Mailbox -ResultSize 1`, so an
operator capture can qualify the hold read like the others (`Get-OrganizationConfig`
was already probed).

### Bounded PowerShell argument transport (`engine/powershell/jobQueue.mjs`)

`runCmdlet` runs one cmdlet as a structured job through the existing `runJob` container
boundary. The job is `{ mode: 'cmdlet', module, cmdlet, parameters }`:
- there is no script field; nothing builds PowerShell source from a value;
- the cmdlet must be in the caller's allowlist, parameter names must be plain names,
  and values must be strings, numbers, booleans, null or lists of strings (no objects,
  no control characters, at most 1024 characters);
- the container side (`ops/powershell/run-cmdlet.ps1`, mode `cmdlet` in `run-job.sh`)
  checks the same allowlist again and calls the cmdlet by splatting a hashtable, so
  each value is exactly one argument.

A mailbox identity such as `alice'; Remove-Mailbox -Identity bob -Confirm:$false; '`
is passed, compared and written as that literal string. Identities may legitimately
contain quotes (`o'brien@contoso.com`), which is why they are accepted and kept as data
rather than refused.

The container answers one envelope: `{ ok: true, output }` (exit 0) or
`{ ok: false, error: { message, category, errorId } }` (exit 1). A cmdlet error, a
non-zero exit, a timeout or a malformed answer is a `CmdletError` with a structured
`detail` (`code`, `cmdlet`, `message`, `category`, `errorId`, `exitCode`, `stderr`,
`jobId`). It is never read as an empty successful result.

### The reader (`engine/collect/workloads/exchange.mjs`)

`readExchange` reads the mailboxes named in configuration (at most 50 per run) and,
optionally, the organization. It never enumerates the tenant's mailboxes.

| Observation | Fields | Source |
| --- | --- | --- |
| `mailboxSettings` | automatic replies, time zone, language, working hours, date and time format, delegate meeting delivery, `userPurpose` | `exchange.mailbox-settings` (Graph) |
| `clientAccess` | OWA, ActiveSync, POP, IMAP, MAPI, EWS, SMTP client authentication | `exchange.client-access` (`Get-CASMailbox`) |
| `retention` | litigation hold, retention hold, single item recovery, deleted item retention; in-place, compliance tag and delay holds; litigation hold duration | `exchange.mailbox-hold` (`Get-Mailbox`) |
| `organization` | Focused Inbox, mail tips (four settings), OAuth2 client profile, actionable messages, connectors | `exchange.organization-config` (`Get-OrganizationConfig`) |

- **No content.** Every Graph request must match `EXCHANGE_REQUEST_SHAPES` (the
  `mailboxSettings` path with no query) and every cmdlet must be in
  `EXCHANGE_CMDLET_PARAMETERS` with only its listed parameters. Messages, folders,
  inbox rules, calendars, contacts, folder or mailbox statistics, searches and exports
  are refused before sending. Only the declared fields are kept from any answer, so
  properties like `archiveFolder`, item sizes or message subjects are never stored.
- **An identity that would leave the path** (one containing `/`) is `refused` for the
  Graph read with nothing sent; its cmdlet reads still pass it as one argument.
- **Per-field coverage.** Each field is `observed`, `unknown` (the read succeeded but
  returned nothing), `denied`, `failed` or `refused`. A failure carries the structured
  error and is stored as such in `workload_observation.field_coverage`. A cmdlet that
  answers more than one object for one identity is `failed` (`AMBIGUOUS_IDENTITY`).
- Runs are stored in the existing `workload_collection` and `workload_observation`
  tables (`mailbox:{identity}` and `organization` rows). No schema change was needed.

### Activation (`exchangeActivation`, `collectExchange`)

Live collection runs only when Teams is qualified (`teamsActivation`, which itself
requires SharePoint) and every Exchange read is live-qualified and enabled on its own
evidence. Otherwise `collectExchange` records a `disabled` run that names what is
missing and sends nothing. The workload is registered with `enabledByDefault: false`
and appears in the coverage report next to SharePoint and Teams.

### Writes (`engine/coverage/qualification.mjs`)

Four distinct operation records:

| Operation | Request | Read-back | RBAC |
| --- | --- | --- | --- |
| `exchange.mailbox-settings.update` | `PATCH /users/{id}/mailboxSettings`, changed settings only | `exchange.mailbox-settings` | `MailboxSettings.ReadWrite` |
| `exchange.client-access.update` | `Set-CASMailbox` | `exchange.client-access` | `Exchange.ManageAsApp`, Exchange Administrator |
| `exchange.mailbox-retention.update` | `Set-Mailbox` (four hold and retention settings) | `exchange.mailbox-hold` | `Exchange.ManageAsApp`, Exchange Administrator |
| `exchange.organization-config.update` | `Set-OrganizationConfig` (eight settings) | `exchange.organization-config` | `Exchange.ManageAsApp`, Exchange Administrator |

`workloadWriteQualification` gained two inputs, used only by writes that declare them:
- `grants`: what the restorer app is observed to hold. Each Exchange write declares
  `grantsRequired`; while the grants are unknown, or short of the declared permission
  or role, the write stays disabled. **Unknown RBAC blocks writes.**
- `runtime.modules`: a cmdlet write is bound to the `ExchangeOnlineManagement` version
  in use. Proof from another version, or an unknown version in use, does not count.

Each write also `requires` `teams.settings.update` (which requires the SharePoint
write), needs its read-back enabled, and needs its own live write capture. Teams or
SharePoint proof is never Exchange proof, and a fixture pass is never live proof.
SharePoint and Teams writes are unchanged.

### The restore (`engine/restore/workloads/exchange.mjs`)

One plan covers one mailbox and, when asked, the organization. `planExchangeRestore`
builds a frozen plan (source collection, operations, manual and excluded items, the
compliance holds seen live, content effects, a fingerprint per observation and a
digest), stored as a `restore_dry_run` artifact, so the task-66 approval and promotion
checks are the existing ones.

| Source item | What happens |
| --- | --- |
| A changed writable setting, observed in the source and live | Part of that observation's one operation |
| A field not `observed` in the source | Manual: no value to restore from |
| An observation not fully read live | Manual: no change planned, with the structured error |
| In-place, compliance tag and delay holds, litigation hold duration | Manual: owned by Purview or a compliance administrator |
| `userPurpose` | Excluded: server-owned |
| Messages, folders, rules, calendars, contacts, statistics | Excluded: content, never read or restored |

**Holds and retention.** Content-effect rules (`engine/safety/contentEffects.mjs`):
- `LitigationHoldEnabled` or `RetentionHoldEnabled` turned off: `hold-releasing`;
- `SingleItemRecoveryEnabled` turned off, or `RetainDeletedItemsFor` shortened (an
  unreadable window counts as shorter): `retention-reducing`;
- automatic replies sent to a wider external audience: `externally-sharing`.

`executeExchangeRestore`:
1. Checks the artifact is promotable, the stored plan matches its digest, and the plan
   targets this tenant. Otherwise `refused`, nothing sent.
2. Qualification per operation: an operation whose write is not enabled is `disabled`.
3. **Hold effect guard**, per operation: an operation carrying a content effect runs
   only with the separate, current high-impact approval of exactly the plan's effects
   (approver other than the requester, still holding `approve`). Without it the
   operation is `blocked-content-effect` and nothing is sent; the other operations run.
4. **Source authority**: a mailbox under an in-place, compliance tag or delay hold never
   has a hold released or retention shortened. The plan is refused. A hold that
   appears after the plan changes the retention observation, so that operation is
   `stale` and a new dry run refuses it; the executor also re-checks the hold before
   sending.
5. Re-reads each observation. A change since the plan makes only that operation `stale`.
6. Writes once and verifies by read-back, field by field. A 429 on the Graph write is
   resent after `Retry-After` (at most 3 attempts). A cmdlet error is `failed` (or
   `refused` when authorization-shaped) with the structured error in its evidence row.
   A timeout, crash, lost answer or 5xx is reconciled by re-reading and **never sent
   again**.

Every operation has its own outcome and its own `workload-restore` evidence row
(operation, target, outcome, writes, attempts, verified fields, reasons, structured
error), followed by a summary row.

### Wave planner

`exchangeMailbox`, `exchangeMailboxSettings`, `exchangeClientAccess`,
`exchangeMailboxRetention` and `exchangeOrganizationConfig` are refused by `planWaves`
and `planDeletionWaves`; they never run as an Entra wave.

## Proof

`engine/roadmap/exchange-config.test.mjs` has 6 tests. They run against the isolated
database, an in-memory Graph that answers any content request with mail (so one such
call would show up), and a fake container behind the real `runJob` spawn path that
plays the `run-cmdlet.ps1` contract: it refuses any descriptor with a field beyond
`{ mode, module, cmdlet, parameters, tenantConfigPath }`, enforces the allowlist parsed
from `run-cmdlet.ps1` itself, and binds parameters one value per argument.

- **Reads and no content.** Four distinct observations, coverage counted per field,
  one Graph request and three Get cmdlets, zero content calls, and nothing
  content-adjacent stored. Eight Graph content shapes and eight content or destructive
  cmdlets are refused. The Node and container allowlists are identical.
- **Hostile identities.** Five quoted, sub-expression and backtick identities are read
  and written: each cmdlet call has exactly one `Identity` argument equal to the
  identity byte for byte, no job carries a script, and no identity reaches the docker
  command line. An identity containing `/` sends no Graph request. The job builder
  refuses object values, injected parameter names, control characters and composite
  cmdlet names.
- **Structured errors.** A permission error is `denied` and a crash is `failed`, both
  with `code`, `cmdlet`, `category`, `errorId`/`stderr` persisted in the database. A
  successful empty answer is `unknown`. A failed live read plans no change. A rejected
  `Set-CASMailbox` is `failed` with its error in the evidence row, sent once, and the
  other operations keep their own `verified` outcomes.
- **Activation and RBAC.** Reads stay off without Teams, with fixture proof only, or
  with the hold read missing, and send nothing. With grants unknown every write is
  disabled and a restore sends zero writes (not even a re-read). Without the Exchange
  Administrator role only the Graph write is enabled. Missing Teams proof, fixture
  proof, an unknown module version and a different module version all disable.
- **Distinct operations.** Mailbox settings, client access and organization restore as
  three verified operations, with three evidence rows; the PATCH carries only the
  changed setting. With one write qualified only that cmdlet is sent. A lost answer
  that applied is `verified` and one that did not is `failed`; neither is resent. A
  change after the plan makes only that operation `stale`. Another tenant id is refused.
  Exchange types never enter Entra waves and coverage lists the disabled workload.
- **Holds.** Releasing a litigation hold is blocked with no `Set-Mailbox` until a
  separate approver approves exactly that effect; the requester cannot. Shortening the
  deleted-item window and turning single item recovery off are held back the same way.
  Turning a hold on needs no approval. A mailbox under an in-place hold refuses the
  release outright, whatever the approval.

Mutation checks, each caught by failing tests and then reverted:

| Mutation | Result |
| --- | --- |
| Interpolate the mailbox identity into script source (`cmdletJob` emits a `script` with `-Identity '…'`) | 1 pass, 5 fail |
| Treat a cmdlet exit error as an empty success (`runCmdlet` returns `[]` on `NONZERO_EXIT`) | 5 pass, 1 fail |
| Bypass the hold effect guard (`heldBack` always clears) | 5 pass, 1 fail |

Validation command (36 tests, all pass):

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/exchange-config.test.mjs engine/restore/*.test.mjs engine/reconcile/*.test.mjs engine/safety/*.test.mjs engine/policy/*.test.mjs cli/keel-restore.test.mjs cli/keel-remediate.test.mjs cli/keel-worker.test.mjs
```

It was run in a container without `/etc/keel/db.env`, with `KEEL_DB_TEST_URL` and
`KEEL_TENANT_CONFIG_PATH` exported for a local PostgreSQL 16 instead. The suite is added
to the CI engine step in `.github/workflows/portal.yml`.

## Limitations

- **No live proof, and blocked behind Teams and SharePoint.** Nothing was read or
  written in a tenant. Cmdlet names, parameters, Graph fields and permissions were
  declared from Microsoft's documentation, which could not be re-fetched from this
  environment, so no retrieval date is recorded (Global Constraint 8). Exchange stays
  disabled until the task-120 SharePoint and task-121 Teams live qualifications exist,
  and then until an Exchange capture exists for each read and each write (task-122,
  against the fixture user `keel-rt-20260908-alice` only; nothing in this task
  deletes or changes that user).
- **The PowerShell side is unrun.** `run-cmdlet.ps1` has not been executed: there is
  no `pwsh` in this container and no tenant. The tests play its contract, and they
  parse its allowlist from the script, but splatting behaviour, the envelope and
  `Connect-ExchangeOnline` are untested against real PowerShell. It also expects an
  `organization` (the tenant's `.onmicrosoft.com` domain) in the credential
  descriptor, which the current descriptors may not carry. Its first live run belongs
  to task-122.
- **App-only Exchange writes need a grant the Restorer does not have.** The operator
  granted Graph `MailboxSettings.ReadWrite` only. `Set-CASMailbox`, `Set-Mailbox` and
  `Set-OrganizationConfig` need `Exchange.ManageAsApp` and an Exchange role for the
  app; the Restorer has no Exchange admin-as-app grant (operator decision 2026-09-30).
  Until one is granted those three writes stay disabled by the RBAC gate even with
  proof. No grant is requested by this task.
- **No worker job, CLI command or portal action.** As with tasks 103 and 104, nothing
  outside tests calls `collectExchange` or `executeExchangeRestore`. A job kind needs a
  capability mapping and an approval flow and could not run before qualification. The
  only user-visible surface is the coverage report entry, which says the workload is
  disabled and why.
- **Named mailboxes only.** The reader covers the mailboxes it is given (at most 50 per
  run); it does not discover mailboxes. Shared, resource and group mailboxes were not
  considered separately.
- **Narrow organization scope.** Eight organization settings are restorable. Transport
  rules, connectors, accepted domains, retention policies, mobile device policies and
  every other organization object are not read or restored here.
- **Automatic reply text is configuration.** `automaticRepliesSetting` includes the
  reply messages the user wrote. They are stored and restored as mailbox settings, and
  widening their external audience needs the separate approval.
- **Does not recover content.** Restoring a hold or a retention setting never recovers
  mail deleted while it was off, and no content recovery is claimed.
