# Trust settings named by an OMA-URI or a template definition (2026-10-30)

The trust-field rule reads key names, and the settings catalog fix (`trustSettingIds`) reads
`settingDefinitionId` values. Two more Intune shapes name a setting by a value neither check
read:

- custom (OMA-URI) profiles keep every setting under `omaSettings[]` and say which one it is
  only in `omaUri`, such as `./Device/Vendor/MSFT/RootCATrustedCertificates/...`;
- administrative templates name each setting by a GUID definition id; only the definition's
  display name and category path (from `$expand=definition`) say what it is.

| Mistake | Rule now |
| --- | --- |
| A trusted root certificate or web sign-in setting in a custom profile was written from the backup. | `omaTrustRefusal` (in `intuneWriteRefusal`) checks every `omaUri` with `isTrustSettingName`. The custom settings are written as one list, so the whole profile is a manual step when the backup or, on update, the live profile holds one. |
| An admin template's authentication server list or zone assignment was written. | `groupPolicyRefusal` checks each setting's display name and category; a setting the backup does not describe is manual too, since it cannot be checked. On update the template's preflight reads the live settings and is manual when one is a trust setting (the restore would remove it). |
| Each new value-named shape needs its own reader. | When a payload names its settings by a value, add the value to the trust check in the same change that makes it restorable (`namedTrustSettings.mjs`). Each skip carries a `manual-setting` / `trustFields` completion item. |
