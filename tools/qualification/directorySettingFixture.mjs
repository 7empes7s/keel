/**
 * Issue #1075: fixtures for the operations harness (operations.mjs) for the
 * Entra directory settings and objects written by
 * engine/restore/directorySettingOperations.mjs and directoryObjectOperations.mjs,
 * in the shapes the Graph reference gives (beta for the kinds the backup reads
 * from beta, v1.0 for schema extensions and profile card fields).
 */
const PROFILES = '/identity/verifiedId/profiles';
const PROFILE_CARDS = '/admin/people/profileCardProperties';

// A Verified ID profile as Graph beta returns it (resources/verifiedidprofile).
const FIXTURE_PROFILE = Object.freeze({
  '@odata.type': '#microsoft.graph.verifiedIdProfile', name: 'Fixture profile', description: 'Fixture identity check',
  state: 'enabled', priority: 1, verifierDid: 'did:web:fixture.example',
  verifiedIdProfileConfiguration: {
    methodType: 'identityVerificationPartner', type: 'VerifiedIdentity', acceptedIssuer: 'did:web:issuer.fixture.example',
    claimBindingSource: 'directory', claimBindings: [{ sourceAttribute: 'givenName', verifiedIdClaim: 'firstName' }],
  },
  faceCheckConfiguration: { isEnabled: true, sourcePhotoClaimName: 'portrait' },
  verifiedIdUsageConfigurations: [{ isEnabledForTestOnly: false, purpose: 'recovery' }],
});

export const DIRECTORY_SETTING_PAYLOADS = Object.freeze({
  // resources/signinidentifierbase: Graph names an identifier by its name.
  signInIdentifier: { '@odata.type': '#microsoft.graph.emailSignInIdentifier', name: 'Email', isEnabled: true },
  // resources/m365capabilitybase, named by its capability.
  crossTenantM365Capability: {
    '@odata.type': '#microsoft.graph.crossTenantMailTipsLimited', name: 'crossTenantMailTipsLimited', lastModifiedDateTime: '2026-01-01T00:00:00Z',
    inboundAccess: { isAllowed: false, resourceScopes: { included: [], excluded: [] } },
  },
  // resources/profilecardproperty, named by its directory field.
  profileCardProperty: {
    directoryPropertyName: 'CustomAttribute1', isVisible: true,
    annotations: [{ displayName: 'Cost center', localizations: [{ languageTag: 'fr-FR', displayName: 'Centre de coût' }] }],
  },
  verifiedIdProfile: FIXTURE_PROFILE,
  // resources/identitygovernance-lifecyclepolicy (the agent identity kind).
  lifecyclePolicy: {
    '@odata.type': '#microsoft.graph.identityGovernance.agentIdentityLifecyclePolicy', displayName: 'Fixture lifecycle policy',
    description: 'Disable agents without a sponsor', isEnabled: true, policySource: 'userCreated', versionNumber: 3, gracePeriodInDays: 14,
    scope: null, enforcementAction: { '@odata.type': '#microsoft.graph.identityGovernance.disableOnlyEnforcementAction' },
    notificationSchedule: { offsetsAfterNonComplianceInDays: [14, 7, 1] },
  },
  // resources/devicetemplate.
  deviceTemplate: {
    '@odata.type': '#microsoft.graph.deviceTemplate', deviceAuthority: 'Fixture Retail', manufacturer: 'Fixture Cameras', model: 'FC-1',
    operatingSystem: 'Linux', mutualTlsOauthConfigurationId: null, mutualTlsOauthConfigurationTenantId: null, deletedDateTime: null,
  },
  // resources/schemaextension, under a verified domain name so Graph keeps its id.
  schemaExtension: {
    id: 'fixture_courses', description: 'Fixture training courses', owner: 'fixture-owner-app', status: 'Available', targetTypes: ['Group'],
    properties: [{ name: 'courseId', type: 'Integer' }, { name: 'courseName', type: 'String' }],
  },
});

export const DIRECTORY_SETTING_SEEDS = Object.freeze({
  // A profile is never POSTed, so its create updates the live one with the backup's name.
  verifiedIdProfile: (graph) => graph.objects.set(`${PROFILES}/fixture-live-profile`, { ...FIXTURE_PROFILE, id: 'fixture-live-profile', description: 'Drifted' }),
  // A schema extension is created only for an owner app that is in the target.
  schemaExtension: (graph) => graph.objects.set("/applications(appId='fixture-owner-app')", { id: 'fixture-owner-object', appId: 'fixture-owner-app' }),
});

// A profile is found by name, a policy or template create looks for one made before, and
// the default capabilities are read back as a list.
export const DIRECTORY_SETTING_LISTED = Object.freeze([PROFILES, '/identityGovernance/lifecycleWorkflows/lifecyclePolicies', '/templates/deviceTemplates',
  '/policies/crossTenantAccessPolicy/default/m365Capabilities']);

/**
 * Creates Graph files under the name the body gives: a profile card field
 * under its directory field, and a schema extension under its id (its
 * verified domain name). Null for every other write.
 */
export function directorySettingWrite(objects, path, method, body) {
  if (method !== 'POST') return null;
  const key = path === PROFILE_CARDS ? body?.directoryPropertyName : path === '/schemaExtensions' ? body?.id : null;
  if (!key) return null;
  const created = path === '/schemaExtensions' ? { ...body, status: 'InDevelopment' } : { ...body };
  objects.set(`${path}/${key}`, created);
  return { ok: true, status: 201, body: created };
}
