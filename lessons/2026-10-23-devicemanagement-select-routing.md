# The Intune tenant settings read was fixed by guessing, twice (2026-10-23)

`deviceManagementSettings` (Intune tenant settings) failed every hourly Tier 1
backup with HTTP 400 "No OData route exists that match template ~/singleton with
http verb GET for request /StatelessOnboardingService/deviceManagement". #447
dropped the fields that looked foreign from the `$select` and kept
`id,settings,intuneBrand,managedDeviceCleanupSettings`. Graph still sent that read
to the onboarding backend, so the fix shipped and the failure stayed for another day.

| Mistake | Rule now |
| --- | --- |
| A `$select` on `/deviceManagement` was narrowed by guessing which fields belong to one backend. Graph serves this singleton from several Intune backends and routes a read naming fields of more than one to a backend that has no GET for it. | Read a field of `/deviceManagement` (or any other singleton Graph splits across backends) one per request with catalogue `selectEach` and restore record `readEach`. Never combine its fields in one `$select`. |
| The fix was declared done on fixtures that answered any `$select`. | A fix for a live Graph error stays open until the next live run of that type is green. Check the type's row on the Job page after the deploy. |
