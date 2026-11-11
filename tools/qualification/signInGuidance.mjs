/**
 * Live gate fixture guidance (live-gate-plan.mjs FIXTURE_GUIDANCE) for guest
 * sign-up user flows and their attributes (issue #995), API connectors (issue
 * #1008), and custom authentication extensions and their listeners (issue
 * #1072). It takes the live gate's FIXTURE_PREFIX, which live-gate-plan.mjs defines.
 */
export const signInGuidance = (FIXTURE_PREFIX) => ({
  // Issue #995: a guest sign-up user flow and one custom attribute it asks for.
  identityUserFlowAttribute: {
    kind: 'named-object', fixture: `custom user flow attribute ${FIXTURE_PREFIX}Attr (data type string, description "${FIXTURE_PREFIX} fixture")`,
    select: `${FIXTURE_PREFIX}Attr`, drift: 'change its description; for create, delete it (it has no users yet)',
    note: 'Check a backup whose data type differs is reported as a manual step and nothing is deleted.',
  },
  b2xIdentityUserFlow: {
    kind: 'named-object', fixture: `self-service sign-up user flow B2X_1_${FIXTURE_PREFIX}-flow with Email one-time passcode, asking for ${FIXTURE_PREFIX}Attr and Display Name, no API connector`,
    select: `B2X_1_${FIXTURE_PREFIX}-flow`,
    drift: `delete the flow: the restore recreates it with its identity providers and attributes in order; then take ${FIXTURE_PREFIX}Attr off the flow and turn one language off: the restore puts both back`,
    breakGlass: 'The fixture flow is not added to any app, so nobody can sign up through it.',
    note: 'Check the dry run lists the flow under "Changes access" and the enforce run writes only after that is approved; a provider that is not set up in the tenant is reported as a manual step.',
  },
  // Issue #1008.
  identityApiConnector: {
    kind: 'named-object', fixture: `API connector ${FIXTURE_PREFIX}-connector calling https://keel-rt.invalid/api/signup with basic authentication (any throwaway username and password), on no user flow`,
    select: `${FIXTURE_PREFIX}-connector`, drift: 'change its target URL to https://keel-rt.invalid/api/other; for create, delete it',
    breakGlass: 'The fixture connector is on no user flow and calls an address that does not exist, so nobody signs up through it.',
    note: 'Check the dry run lists the name and URL under "Changes access" and the enforce run writes only after that is approved; check the recreated connector has a placeholder username starting keel-placeholder- and the restore lists setting the real password as a step. Nothing is added to a user flow.',
  },
  // Issue #1072.
  customAuthenticationExtension: {
    kind: 'named-object', fixture: `token issuance custom authentication extension ${FIXTURE_PREFIX}-claims calling https://keel-rt.invalid/api/claims (app ID URI of ${FIXTURE_PREFIX}-app), returning one claim FixtureClaim, called by no listener`,
    select: `${FIXTURE_PREFIX}-claims`, drift: 'change its description and add a second token claim; for create, delete it and recreate it by hand under the same name with another description (the restore never creates one)',
    breakGlass: 'The fixture extension is called by no listener, and its address does not exist, so no sign-in calls it.',
    note: 'Check the dry run lists the token claims under "Changes sign-in", the enforce run writes only after that is approved, and the endpoint, its app ID URI and timeouts read back unchanged.',
  },
  authenticationEventListener: {
    kind: 'named-object', fixture: `token issuance listener for ${FIXTURE_PREFIX}-app calling ${FIXTURE_PREFIX}-claims, priority 500`,
    select: `the listener calling ${FIXTURE_PREFIX}-claims`, drift: 'change its priority to 400; for create, delete it',
    breakGlass: `Only ${FIXTURE_PREFIX}-app, which nothing signs in to, calls the extension; never add a listener for another app or for all apps.`,
    note: 'Check the dry run lists the apps, extension and priority under "Changes sign-in", the enforce run writes only after that is approved, and the recreated handler names the live extension; with the extension deleted first, the restore holds the listener with "recreate the extension first".',
  },
});
