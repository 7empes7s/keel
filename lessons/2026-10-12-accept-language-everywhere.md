# Accept-Language on every Graph request (2026-10-12)

Live (Q43 step 45): the PIM role-settings update (`unifiedRoleManagementPolicy`) wrote correctly, but the read-back failed with `CultureNotFoundException` under an app token, so the write was recorded as unverified and demoted.

| Mistake | Rule now |
| --- | --- |
| The collector's `GraphReader` (`tools/tenant-probe/graph.mjs`) defaulted to `Accept-Language: en-US` after measuring this exact error in 2026-09, but the restore side's `GraphWriter` (`engine/restore/graphWriter.mjs`) was written without it. Same trap, second client. | Every Graph client sends `Accept-Language: en-US` on every request (read, write, batch, whatIf) unless the caller names its own language. A caller header always wins (company branding uses a specific language or `0`). |
| The workaround lived in one client with a comment, not in a rule, so the next client repeated the omission. | A fix to a shared Graph quirk is applied to every Graph client in the repo in the same PR, and a fixture test asserts the header on each client. |
