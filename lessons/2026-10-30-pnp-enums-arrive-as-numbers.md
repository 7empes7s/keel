# PnP enums arrive as numbers (2026-10-30)

`run-cmdlet.ps1` serialises every answer with `ConvertTo-Json`, which writes an enum as its
number. `sharepoint.mjs` already maps `SharingCapability` from 0-3 to its name, but the
OneDrive restore (PR #776) judged `Get-PnPTenantSite`'s sharing enums by name only.

| Mistake | Rule now |
| --- | --- |
| The OneDrive content-effect rules ranked `SharingCapability`, `SharingDomainRestrictionMode`, `DefaultSharingLinkType` and `DefaultLinkPermission` by name. A number is off the scale, so every change counted as wider sharing. | `widensOn(order, field)` reads the number as its name first (`oneDriveEnumName`, `ONEDRIVE_ENUMS` in `onedrive.mjs`). |
| A default link type or permission of 0 (`None`, the tenant default) was read as the site's own value. | `inheritedIfNone` compares the enum name, so 0 is inherited. |
| Each new PnP or Exchange enum field needs its own mapping. | When a rule or check compares a cmdlet enum by name, map the number to the name in the same change, and test it with the number as the fake container sends it. |
