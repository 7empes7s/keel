# Keel bundle v1

A Keel bundle is one file that holds one completed snapshot of one tenant: every
configuration object and the references between them, plus every content item this Keel
knows for that tenant when the bundle is made (by reference, or with their bytes).
Content is not cut at the snapshot's time, so two bundles of one snapshot made on
different days can differ in their content entries. It is signed, it verifies offline with only a
public key, and it imports into any Keel.

Code: `engine/export/bundle.mjs` (writer, verifier, importer), `cli/keel-export.mjs --bundle`,
`cli/keel-import.mjs`. Table: `engine/store/schema.d/33-bundle.sql`.

## Layout

The file is a POSIX ustar tar archive. Entries, in this exact order:

| Path | What it holds |
| --- | --- |
| `bundle.json` | The manifest (below). |
| `bundle.sig` | `{ algorithm: "ed25519", keyId, signature }`: an Ed25519 signature over the exact bytes of `bundle.json`, base64. |
| `objects/<resourceType>/<sha256(naturalKey)>.json` | One configuration object. |
| `content/<workload>/<sha256(contentKey)>.json` | One content item. |
| `blobs/<sha256>` | The plaintext of a content item, named by its sha256. Only with content mode `bytes`. |

After `bundle.sig`, entries are sorted by path (byte order). The archive ends with two
zero blocks and nothing else.

Every header is written the same way: mode `0000644`, uid and gid 0, mtime 0, type `0`,
magic `ustar\0`, version `00`, empty user and group names, and the path in the name
field, or split at a `/` into the prefix field when it is longer than 100 bytes. Padding
is zero bytes. An entry is at most 8 GiB minus one byte.

## Canonical JSON

Every JSON file is canonical: keys sorted recursively, two-space indentation, one
trailing newline (`stableJson` in `engine/export/manifest.mjs`). Times are ISO 8601 UTC
with milliseconds.

## Manifest (`bundle.json`)

```json
{
  "format": "keel-bundle",
  "formatVersion": 1,
  "tenantRef": "sha256:…",
  "snapshot": { "startedAt": "…", "completedAt": "…", "coverageDigest": { "<type>": { "outcome": "complete", "itemCount": 1 } } },
  "objects": 3,
  "content": { "mode": "refs", "items": 3 },
  "signer": { "algorithm": "ed25519", "keyId": "<16 hex>" },
  "files": { "<path>": { "sha256": "<hex>", "bytes": 123 } }
}
```

- `files` lists every entry after `bundle.sig`, in archive order.
- `content.mode` is `none` (no content), `refs` (default: items named, no bytes) or `bytes`.
- `keyId` is the first 16 hex characters of sha256 over the raw 32-byte public key.

## Object file

```json
{
  "naturalKey": "conditionalAccessPolicy:KEEL-RT-Block legacy",
  "resourceType": "conditionalAccessPolicy",
  "payload": { },
  "payloadHash": "…",
  "hashVersion": 1,
  "criticality": "tier1",
  "blastRadius": "access-affecting",
  "fidelity": "read-only",
  "provenance": { },
  "references": [ { "field": "conditions.users.includeGroups[0]", "symbol": "group:KEEL-RT-Finance", "required": true } ]
}
```

The payload is the stored payload in full, not the redacted reviewer export, because a
bundle must restore every object. Store bundles like backups. References point at
natural-key symbols, sorted by field; `prefix` appears only when the reference sits inside
a path.

## Content file

```json
{
  "workload": "exchange-mail",
  "container": "mailbox:…",
  "itemKey": "…",
  "version": "…",
  "metadata": { },
  "sha256": "<hex of the plaintext>",
  "bytes": 1234,
  "body": "blobs/<sha256>"
}
```

The content key is `JSON.stringify([workload, container, itemKey, version])`. `body` is
`null` when the bundle names the item without its bytes.

## No tenant-local ids

A bundle never holds a snapshot id, a version row id or a local content ref
(`keel-content:<uuid>`). Those are database ids of one Keel. Objects are named by
natural key and content items by their content key plus sha256 and length. On import a
Keel gives the snapshot and each stored item its own ids. That is why export, import
into another Keel, and export again gives a byte-identical file.

## Verifying

`verifyBundle(path, { verifyKey })` and `keel-import.mjs --bundle FILE --verify-only` need
only the file and the public key: no database and no content store. A bundle passes only
when all of these hold:

1. Every header equals the header this format would write for that path and size, padding
   is zero, and the file ends with exactly two zero blocks.
2. `bundle.json` and `bundle.sig` come first and are canonical JSON, the signature's base64
   is canonical, and the signature verifies over `bundle.json` with the verify key.
3. The signer key id in both files matches the verify key.
4. The entries after `bundle.sig` are exactly `files`, in that order, and each one's sha256
   and length match.

So one changed byte anywhere in the file fails, and a bundle signed with another key fails.

## Importing

`importBundle(client, path, { verifyKey, contentStore })`, or
`keel-import.mjs --bundle FILE --as EMAIL [--reader /etc/keel/content-reader.json]`:

1. Verifies the bundle and refuses it if verification fails.
2. In one transaction: creates the snapshot (status `complete`, the bundle's times and
   coverage digest), every object with its payload, hash and references, and every content
   item.
3. A content item with a body is put into this Keel's content store, re-chunked and
   encrypted under this Keel's key, and must store as its recorded sha256 and length. An
   item without a body is recorded in `content_ref`. A later bundle export lists both.
4. A bundle whose snapshot this Keel already holds (same tenant, start and end, to the
   millisecond) is refused.
5. Verification and import read one open file, and every object and content file is
   re-hashed as it is read, so a file changed on disk after verification is refused.

## Keys

- `KEEL_BUNDLE_SIGNING_KEY`: a 32-byte Ed25519 seed, 64 hex characters or base64, in
  `/etc/keel/bundle.env` (mode 600, git-ignored, never committed). Make one with
  `openssl rand -hex 32`.
- `KEEL_BUNDLE_VERIFY_KEY`: the 32-byte public key. `keel-import.mjs --public-key` prints it
  from the signing key. Give it to any Keel that should verify or import bundles; that Keel
  can never sign one.

## Who may run it

Bundle export and import need a principal holding the `export` capability
(`--as EMAIL`). Verify-only needs no principal. The plain directory export
(`keel-export.mjs --export-root`) is unchanged.
