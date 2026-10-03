# SharePoint site configuration read adapter (task 102)

Date: 2026-10-03 UTC. Status: implemented, fixture-tested only. The adapter ships
**disabled**, and no tenant was read.

## What was built

### The adapter (`engine/collect/workloads/sharepoint.mjs`)

`readSharePointSites` reads three things through the task-101 contract
(`readGraphConfiguration`): tenant sharing settings, each site's properties, and each
site's own app permission grants.

| Field | Source operation | Endpoint |
| --- | --- | --- |
| Tenant `sharingCapability`, `sharingDomainRestrictionMode`, `sharingAllowedDomainList`, `sharingBlockedDomainList`, `isResharingByExternalUsersEnabled` | `sharepoint.tenant-settings` | `GET /admin/sharepoint/settings` |
| Site discovery | `sharepoint.site-discovery` | `GET /sites/getAllSites` (paged) |
| Site `displayName`, `name`, `webUrl`, `createdDateTime`, `lastModifiedDateTime`, `hostname` | `sharepoint.site-properties` | `GET /sites/{site-id}` |
| Site `appPermissionGrants`: id, roles, applications | `sharepoint.site-permissions` | `GET /sites/{site-id}/permissions` |

- **Per-field coverage.** Every field records its source operation and one of these
  statuses:
  - `observed`;
  - `denied` (401 or 403);
  - `failed`;
  - `unknown`.
- **Unsupported fields.** Per-site `sharingCapability`, `lockState`, `sensitivityLabel`,
  `conditionalAccessPolicy` and `externalUserExpirationInDays` need the SharePoint admin
  interface, which is not qualified here. They are always `unknown` with that reason,
  and never get a value.
- **Missing fields.** A supported field that Graph did not return is also `unknown`,
  not null.
- **Outcome.**
  - `complete` (or `complete-empty`) only when every supported field of the tenant and
    of every in-scope site was observed.
  - `partial` when any field was denied, failed or unknown, or when discovery hit
    `maxSites` (default 500).
  - `failed` when discovery itself failed. The site set is then unknown, never empty.
- **Separation from file permissions.** Only `/sites/{site-id}/permissions`, the site's
  own grant list, is read. The task-101 validator now allows `permissions` in exactly
  that shape. Under a drive item it stays refused. No drive, item, list, page or
  message endpoint is ever requested.
- **Tenant scope.**
  - `tenantHost` (for example `contoso.sharepoint.com`) comes from the caller's
    configuration.
  - A discovered site is read only when both its `webUrl` host and the host inside its
    composite id are `tenantHost`, and its id is well formed (`host,guid,guid`).
  - Every other site is recorded under `outOfScope` and never requested. That includes
    OneDrive personal sites, which belong to the OneDrive workload.
- **Consistency.** Sites are keyed by id, so a site that Graph returns on two pages
  becomes one observation. All observations of a run share the run's window.

### Activation gate

- `collectSharePointSites` checks the task-101 ledger first. Every one of the four
  operations must be `live-qualified` and enabled (grants confirmed).
- Otherwise it records a `disabled` run that names what is missing, and sends no
  request.
- Fixture proof alone never enables it.

### Persistence (`engine/store/schema.sql`)

- `workload_collection` holds one row per run: outcome (including `disabled`),
  observation window, and a digest with discovery, field counts, out-of-scope sites and
  reasons.
- `workload_observation` holds one row per resource of a run (`tenant`, `site:<id>`),
  with its fields and per-field coverage, keyed by `(collection_id, resource_key)`.
- A run is written in one transaction.

### Registry (`engine/collect/registry.mjs`)

- `registerWorkload` and `listWorkloads` keep workload adapters apart from catalogue
  types. `list()` and the Entra snapshot path are unchanged.
- A workload must declare `enabledByDefault: false`. The registered adapter's
  `collect()` refuses to run.

### Coverage report (`engine/coverage/report.mjs`)

- The report gains a `workloads` array.
- It holds one entry per registered workload: status (`never-collected`, `disabled`,
  `complete`, `partial` or `failed`), whether it is covered, the observation window,
  the site count, field counts, the number of out-of-scope sites, and the reasons.
- It sits beside `types` and never counts toward `summary`.

## Migration and legacy reads

- Two new tables are created with `IF NOT EXISTS`. Nothing existing changes.
- The report checks `to_regclass('workload_collection')`, so a database without the
  table reads every workload as `never-collected`.
- Task 101 gains two descriptors, `sharepoint.site-discovery` and
  `sharepoint.site-permissions`. Both start `disabled` like the rest.

## Limitations

- **Fixture-tested only, and disabled.** No live capture exists for the four
  operations, so nothing reads a tenant until one is supplied through
  `tools/qualification/workloads.mjs --capture`.
- **Documentation not re-fetched.** learn.microsoft.com is blocked by the egress
  proxy.
  - The endpoints and permissions come from Microsoft's published references as
    previously known.
  - In particular, check `getAllSites` (app-only) and `Sites.FullControl.All` for
    listing site permissions before a capture.
- **No scheduled job or portal view yet.** The coverage report carries the data. A job
  kind and a UI card would follow once the workload can be enabled.
- **Graph v1.0 does not expose per-site sharing settings.** They stay unknown until the
  PnP route (`sharepoint.site-sharing`) is qualified and wired in.
- `engine/roadmap/foundation.test.mjs` fails on master with or without this change
  (`Cannot read properties of null (reading 'revision')`). It is not part of CI, and
  it is unrelated to this task.

## Boundary tests

`engine/roadmap/sharepoint-read.test.mjs` has 7 tests. They use an isolated schema and a
fake Graph.
- A three-page discovery with a 429 and a site duplicated across pages persists 4 sites
  plus the tenant. Every request passes the scope validator and none is a file or
  message endpoint. The report shows `complete`.
- A 403 on tenant settings and on one site's permissions gives `partial`. The denied
  fields carry no value and the rest stay observed. A failed discovery is `failed`
  with an unknown site count.
- Unsupported fields stay `unknown`, and so does a missing supported field.
- Sites on another host, a URL host that disagrees with the id host, a malformed id and
  a OneDrive personal site are all out of scope and never requested. A `tenantHost`
  that is not a SharePoint host is refused.
- `maxSites` caps discovery and makes the read `partial`.
- The gate:
  - an unqualified ledger records `disabled` and sends nothing;
  - fixture proof stays off;
  - live-qualified proof with grants runs, and the report shows the newest run.
- The registry keeps workloads apart and refuses one that does not ship disabled.

Required mutations were each applied alone and then restored (2026-10-03):

| Mutation | Pass | Fail |
| --- | --- | --- |
| Crawl files to infer coverage (read `/drive/root/children` per site) | 6 | 1 |
| Label partial field read complete (ignore field statuses) | 5 | 2 |
| Trust arbitrary site URL tenant (check the URL host only) | 6 | 1 |
| Trust arbitrary site URL tenant (no scope check) | 6 | 1 |

Validation: `node --test engine/roadmap/sharepoint-read.test.mjs engine/authz/*.test.mjs engine/jobs/*.test.mjs engine/collect/*.test.mjs engine/coverage/*.test.mjs engine/cir/*.test.mjs`
gives 21 pass, 0 fail.
- The task-101 suite still passes (7 of 7).
- The coverage, diagnosis, outcomes, portal-experience, capability and relationship
  suites pass.
- Portal typecheck is clean.
