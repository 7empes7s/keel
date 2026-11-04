# Content restore fakes must reproduce service refusals

Q188 (#656) and Q194 (#667) reached writes that local fakes accepted but Graph
or PnP refused: creating a migration channel in a normal team, adding an empty
site script, and applying a provisioning document with duplicate XML IDs.

When fixing a live refusal, put its response shape and condition into the fake
transport. Exercise the real restore or capture path, and temporarily revert
each production fix independently to confirm the regression fails. Restore the
fix before running the full suites. A request-body assertion alone does not
prove the restore handles the service's answer.

For generated PnP XML, also validate representative documents against the
official provisioning XSD. Deterministic section order is our choice; unique
`xs:ID` values are a schema requirement. Offline tests do not qualify a live
writer: Q188 and Q194 retries remain with keel-operator and the existing gates.
