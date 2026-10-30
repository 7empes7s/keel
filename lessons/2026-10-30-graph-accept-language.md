# A Graph reader without Accept-Language (2026-10-30)

Graph's PIM endpoints reject `Accept-Language: *` with 400 CultureNotFoundException. That was
measured on 2026-09-08 and fixed in the tenant probe, Discovery and the restore writer, but the
read-only transport in `cli/keel-workload-collect.mjs` (used by scheduled workload collection
and `tools/scubagear-pim-check.mjs`) sent only the token. Node's fetch fills in `*`, so the PIM
check's first live run (Q294) failed with HTTP 400.

| Mistake | Rule now |
| --- | --- |
| A new Graph transport sent no Accept-Language. | Every Graph transport sends `accept-language: en-US` on every request (company branding's `0` is the only override). A new transport gets a test that checks the header. |
