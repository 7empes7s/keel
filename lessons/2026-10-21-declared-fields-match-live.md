# Declared fields must match what the live cmdlet returns (2026-10-21)

The Exchange mail flow and Exchange settings reads declared their fields from Microsoft's
cmdlet docs. On live (Q103, Q105) every family read, but three declared properties never
came back: `WhenChangedUTC` on the transport and protection rule cmdlets,
`UseTranslatedNotificationText` on `Get-SafeLinksPolicy`, and
`EndUserQuarantinePermissionsValue` on `Get-QuarantinePolicy` (a `Set-` input only). Each
became an `unknown` field, so both groups reported `partial` every night with nothing missing.

| Mistake | Rule now |
| --- | --- |
| A field was declared because the docs list it, never checked live. | After a workload's first live run, list its `unknown` fields (the run digest's `unknownFields`) and drop any the cmdlet does not return. |
| A `partial` run said only how many fields were unknown. | The run digest names each unknown field per family (`unknownFields`), so no extra query is needed. |
| A test sample carried every declared field, so it could never show the gap. | Shape test samples like the live answer, not like the declaration. |
