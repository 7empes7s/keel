# Compensation comparisons must retain observed trust fields

Trust-free write projections also feed compensation. Filtering trust fields out
of that projection hid an administrator's later signInAudience change and let
compensation delete a newly created or soft-delete-restored application.

Before an undo deletes an object, compare its observed postState trust values
with current live values as well as the writable fields. Keep write bodies and
update compensation trust-free. Test both create and soft-delete restore undos
with a changed trust field and with the unchanged observed value.
