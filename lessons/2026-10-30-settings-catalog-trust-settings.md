# Settings catalog trust settings slipped past the key-name check (2026-10-30)

The trust-field rule (`isTrustField` in `writeDeclarations.mjs`) looks at field names. A
settings catalog policy, a settings catalog compliance policy and a reusable settings group
hold every setting under the same keys (`settings[].settingInstance`), and say which setting
it is only in the `settingDefinitionId` value. A trusted root certificate, an Apple
certificate or single sign-on payload, or an Edge sign-in setting was written from the
backup because no key name ever said "certificate" or "sign-in".

| Mistake | Rule now |
| --- | --- |
| The trust check read key names only. | Where a payload names a setting by a value, check the value too. `trustSettingIds()` reads every `settingDefinitionId` at any depth against `TRUST_SETTING_PATTERN` (the field pattern plus federation, single sign-on and certificate payload names). |
| Dropping a trust field from the body was assumed to be safe. | These policies are written whole (PUT), so leaving a setting out deletes it. `trustSettingRefusal()` makes the whole write a manual step when the backup holds a trust setting, or on update when the live policy does. It runs in all three refusals (`intuneWriteRefusal`, `compliancePolicyRefusal`, `reusableSettingRefusal`). |
