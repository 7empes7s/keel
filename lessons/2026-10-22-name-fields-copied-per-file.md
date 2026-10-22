# Name fields were copied into every file (2026-10-22)

Each list, page and query had its own copy of the fields a saved object is named
by (displayName, name, title, ...). When #478 taught the capture tool that a
branding profile is named by `profileName` (its displayName is the organization
name), an imported ADMX file by `fileName` and an app relationship by its two
apps, none of the nine portal and engine copies learned it, so branding profiles
were listed under the organization name and the others by id.

| Mistake | Rule now |
| --- | --- |
| The name fields were copied into each query and view. | Name saved objects only through `engine/cir/objectName.mjs` (`objectName`, `objectNameSql`). A portal test fails on any hand-written `payload->>'displayName'`. |
| A kind with its own name field was fixed in one tool only. | Add the kind to `OWN_NAME_FIELDS` in `objectName.mjs`; its test fails when the capture tool names a kind by a field the lists do not read. |
