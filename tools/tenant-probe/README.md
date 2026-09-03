# KEEL tenant probe

Read-only enumeration of a Microsoft 365 tenant, producing the measured numbers
that spec §19.1 requires before implementation begins.

## What it measures

1. **Reachability** — which of the 50 catalogued Entra/Intune resource types
   actually return data with the granted scopes. A type is reachable only if a
   real request returned it; nothing is inferred from documentation.
2. **Scale** — true object counts per type via `$count`, independent of any
   page cap, so a sampled payload still yields an accurate size.
3. **Reference resolvability** — of every GUID an object carries, what fraction
   resolves to a tenant-independent natural key. The unresolvable share is the
   honest ceiling on cross-tenant restore fidelity.
4. **On-premises sync** — how many principals are AD-mastered and therefore
   must not be restored cloud-side.
5. **Throttling** — observed 429/503 rate, `Retry-After` values, effective
   request rate.

## Read-only by construction

`graph.mjs` exposes no HTTP method parameter. There is no code path through
which the probe can write to a tenant, which is a stronger guarantee than a
configuration flag and mirrors the collector/restorer split in spec §4.

## Running

```bash
node /opt/keel/tools/tenant-probe/probe.mjs
```

Configuration is `/etc/keel/tenant.json` (mode 600, outside the repo):

```json
{
  "tenantId": "…",
  "clientId": "…",
  "certPath": "/etc/keel/keel-collector.cer",
  "keyPath":  "/etc/keel/keel-collector.key"
}
```

Output lands in `/opt/keel/out/` as timestamped JSON and Markdown, plus
`latest.md`. Output is gitignored: it contains tenant object names and
structure.

## Tests

```bash
node /opt/keel/tools/tenant-probe/references.test.mjs
```

The reference analyser is the module the M1 go/no-go decision rests on, so its
fixture is built to distinguish a correct implementation from the plausible
wrong ones — self-references, appId-only resolution, well-known Microsoft ids,
GUIDs nested in arrays, and genuine dangling references each change the totals.
All four mutations tried against it are killed by the suite.
