/**
 * Live gate fixture guidance (live-gate-plan.mjs FIXTURE_GUIDANCE) for the Entra
 * directory settings and objects of issue #1075. It takes the live gate's
 * FIXTURE_PREFIX, which live-gate-plan.mjs defines. Sign-in identifiers, default
 * cross-tenant capabilities and profile card fields are one setting for the whole
 * tenant: their runs need --allow-tenant-wide-test-writes. A device template and a
 * schema extension have no name field a KEEL-RT- fixture can be checked by, so the
 * operator picks the object (kind 'tenant-setting', captured with --allow-tenant-setting).
 */
export const directorySettingGuidance = (FIXTURE_PREFIX) => ({
  signInIdentifier: {
    kind: 'tenant-setting', fixture: 'the Username sign-in identifier, switched off (only if the tenant is an External ID tenant)',
    select: 'Username', drift: 'turn it on; write the original value down first. Never touch the Email or UPN identifier',
    breakGlass: 'Only the Username identifier, which nobody on the test tenant signs in with; never the identifier the operator signs in with.',
    note: 'Check the dry run lists it under "Changes sign-in", the enforce run writes only after that is approved, and set the original value back right after the run.',
  },
  crossTenantM365Capability: {
    kind: 'tenant-setting', fixture: 'the default crossTenantOpenProfileCard capability, with no group scopes',
    select: 'crossTenantOpenProfileCard', drift: 'switch inboundAccess.isAllowed to the other value; write the original down first',
    note: 'Check the dry run lists it as sharing outside the organization and the enforce run writes only after that is approved; set the original value back right after the run.',
  },
  profileCardProperty: {
    kind: 'tenant-setting', fixture: `profile card field CustomAttribute15 with the label "${FIXTURE_PREFIX}-field"`,
    select: 'CustomAttribute15', drift: `change its label to "${FIXTURE_PREFIX}-other"; for create, delete the field (the attribute itself stays)`,
    note: 'Delete the field again after the run if it was not there before.',
  },
  verifiedIdProfile: {
    kind: 'named-object', fixture: `Verified ID profile ${FIXTURE_PREFIX}-profile, state disabled, used for onboarding only`,
    select: `${FIXTURE_PREFIX}-profile`, drift: 'change its description and priority; for create, delete it and recreate it by hand under the same name with another description (the restore never creates one)',
    breakGlass: 'The fixture profile stays disabled, so nobody proves who they are with it.',
    note: 'Check the dry run lists the priority under "Changes sign-in", the enforce run writes only after that is approved, and its accepted issuer reads back unchanged.',
  },
  lifecyclePolicy: {
    kind: 'named-object', fixture: `agent identity lifecycle policy ${FIXTURE_PREFIX}-policy, switched off, excluding no groups`,
    select: `${FIXTURE_PREFIX}-policy`, drift: 'change its grace period; for create, delete it',
    breakGlass: 'The policy stays off for the whole run: a restore never turns one on. Never turn it on on the test tenant.',
    note: 'Check the recreated policy is off and the restore lists its rules and turning it on as steps.',
  },
  deviceTemplate: {
    kind: 'tenant-setting', fixture: `device template from maker ${FIXTURE_PREFIX}-maker, model ${FIXTURE_PREFIX}-model, with no mutual TLS configuration and no devices`,
    select: `${FIXTURE_PREFIX}-maker ${FIXTURE_PREFIX}-model`, drift: 'delete it (a template cannot be changed, only recreated)',
    note: 'Check the restore lists adding its owners as a step.',
  },
  schemaExtension: {
    kind: 'tenant-setting', fixture: `schema extension named keelrt148courses (Graph adds its own prefix, such as extk9eruy7c_keelrt148courses) on Group, owned by the ${FIXTURE_PREFIX}-app, left In development`,
    select: 'the id Graph gave keelrt148courses', drift: 'delete it (only possible while it is In development)',
    note: 'Check the restore reports the id Graph gave the new extension, and that no group gets values.',
  },
});
