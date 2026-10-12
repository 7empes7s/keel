# Pseudonymize every encoding of an id, not only the GUID (2026-10-12)

Found by the Q43 evidence review: a pseudonymized Entra capture still carried a fixture
group's id, because Graph returns the object GUID a second time as a cloud security
identifier (`S-1-12-1-a-b-c-d`, the GUID as four 32-bit words) and
`tools/qualification/pseudonymize.mjs` rewrote GUIDs, tenant hosts and base64 tokens only.

| Mistake | Rule now |
| --- | --- |
| The pseudonymizer matched one textual form of an id (the GUID) and assumed the rest of the record held no other. | An id leaks in every encoding it is carried in. Cloud SIDs decode to the GUID and map through the same GUID mapping; on-premises SIDs (`S-1-5-21-…`) and immutable ids (base64 of the objectGUID) get digest-derived pseudonyms of the same shape. |
| The capture guard checked only for the raw tenant id, so a leaked object id was never refused. | `captureLive` collects every GUID and SID from the raw log before pseudonymization and refuses to write anything that still holds one of them. |
| The leak was found by reading committed evidence, not by a test. | The pseudonymizer test asserts a SID round-trips consistently with its GUID, and the Entra gate fixture carries a SID so the end-to-end capture test fails if it ever passes through again. |
