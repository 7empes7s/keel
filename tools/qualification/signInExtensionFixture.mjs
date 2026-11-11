/**
 * Issue #1072: custom authentication extension and listener fixtures for the
 * operations harness (operations.mjs), in the shape the Graph v1.0 list reads
 * return.
 */
const EXTENSIONS = '/identity/customAuthenticationExtensions';

// A token issuance extension as Graph v1.0 returns it.
const FIXTURE_EXTENSION = Object.freeze({
  '@odata.type': '#microsoft.graph.onTokenIssuanceStartCustomExtension', displayName: 'Fixture extension', description: 'Fixture claims',
  endpointConfiguration: { '@odata.type': '#microsoft.graph.httpRequestEndpoint', targetUrl: 'https://fixture.example/api/claims' },
  authenticationConfiguration: { '@odata.type': '#microsoft.graph.azureAdTokenAuthentication', resourceId: 'api://fixture.example/fixture-app' },
  clientConfiguration: { timeoutInMilliseconds: 2000, maximumRetries: 1 },
  claimsForTokenConfiguration: [{ claimIdInApiResponse: 'FixtureClaim' }],
});

export const SIGN_IN_EXTENSION_PAYLOADS = Object.freeze({
  // The listener's handler expands the extension, as the list read returns it.
  customAuthenticationExtension: FIXTURE_EXTENSION,
  authenticationEventListener: {
    '@odata.type': '#microsoft.graph.onTokenIssuanceStartListener', displayName: 'Fixture listener', priority: 500,
    conditions: { applications: { includeApplications: [{ appId: 'fixture-app' }] } },
    handler: { '@odata.type': '#microsoft.graph.onTokenIssuanceStartCustomExtensionHandler', configuration: null, customExtension: { ...FIXTURE_EXTENSION, id: 'fixture-source-extension' } },
  },
});

export const SIGN_IN_EXTENSION_SEEDS = Object.freeze({
  // An extension is never POSTed, so its create updates the live one with
  // the backup's name; a listener points at that live extension.
  customAuthenticationExtension: (graph) => graph.objects.set(`${EXTENSIONS}/fixture-live-extension`, { ...FIXTURE_EXTENSION, id: 'fixture-live-extension', description: 'Drifted' }),
  authenticationEventListener: (graph) => graph.objects.set(`${EXTENSIONS}/fixture-live-extension`, { ...FIXTURE_EXTENSION, id: 'fixture-live-extension' }),
});

// An extension is found by name, and a listener create looks for one calling the same extension.
export const SIGN_IN_EXTENSION_LISTED = Object.freeze([EXTENSIONS, '/identity/authenticationEventListeners']);
