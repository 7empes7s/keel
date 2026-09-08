#!/usr/bin/env node
/**
 * Enterprise coverage fixtures.
 *
 * Creates realistic, INERT configuration in the live tenant so that the Phase 3
 * descriptors are exercised against non-empty data instead of against nothing.
 *
 * Three rules govern everything in this file:
 *
 * 1. Nothing is ever ASSIGNED. Every policy is created without assignments and
 *    without becoming an organisation default, so none of it sits in any user's
 *    sign-in or enrolment path. An unassigned claims-mapping or token-lifetime
 *    policy is inert by construction — it only takes effect once attached to a
 *    service principal, which this file never does.
 * 2. The operator's access is gated on EVIDENCE, not assertion. Everything that
 *    can stand between the operator and a successful sign-in — Conditional Access
 *    policies, the authentication methods policy, security defaults, their own
 *    account, their directory roles — is read before and after the writes and
 *    must be identical. Any difference triggers immediate rollback. The reads use
 *    the collector credential, which holds no write scopes, so the evidence is
 *    gathered by an identity that could not have caused the change it checks for.
 * 3. Every created object id is written to a manifest before the next object is
 *    created, so `--cleanup` can remove exactly what was made even if the run
 *    dies halfway.
 *
 * Deliberately NOT created, because each one can touch authentication,
 * privilege or enrolment even when it looks passive:
 *   conditionalAccessPolicy          — the one object that can lock an operator out
 *   certificateBasedAuthConfiguration — tenant-wide authentication configuration
 *   featureRolloutPolicy             — can roll out sign-in features to users
 *   oauth2PermissionGrant            — grants API permissions
 *   roleEligibilitySchedule          — PIM privilege
 *   deviceEnrollmentConfiguration    — enrolment behaviour, and a default exists
 *
 * Not creatable through Graph at all, so absent from the plan rather than failing
 * in it: directoryRoleTemplate and groupSettingTemplates are Microsoft-defined,
 * and managedDevice requires a real device to enrol.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getToken } from '../tenant-probe/auth.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MANIFEST = process.env.KEEL_FIXTURE_MANIFEST ?? join(__dirname, 'manifest.json');
/**
 * The tenant already holds a synthetic enterprise from the live round-trip
 * rehearsal — KEEL-RT-20260908 users, groups and Conditional Access policies.
 * These fixtures extend that same scenario rather than starting a parallel one,
 * so everything synthetic carries one prefix and can be found and removed by it.
 */
const SCENARIO_PREFIX = 'KEEL-RT-20260908';
const OPERATOR_ID = '8dab2722-f4f9-443a-bd67-63782a46dfd0'; // marouane.defili@techinsiderbytes.com
const OPERATOR_UPN = 'marouane.defili@techinsiderbytes.com';

const GRAPH = 'https://graph.microsoft.com';

let token = null;
async function headers() {
  if (!token) {
    const cfg = JSON.parse(readFileSync('/etc/keel/restorer.json', 'utf8'));
    token = (await getToken(cfg)).accessToken;
  }
  return {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    'accept-language': 'en-US',
  };
}

async function graph(method, path, body) {
  const res = await fetch(GRAPH + path, {
    method,
    headers: await headers(),
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, ok: res.ok, body: parsed };
}

/* ---------------------------------------------------------------- safety --- */

/**
 * Refuse any payload that names the operator or carries an assignment. This is a
 * guard against a future edit to the plan below, not against the plan as written
 * — which is exactly when a guard earns its place.
 */
function assertInert(name, payload) {
  const serialised = JSON.stringify(payload);
  if (serialised.includes(OPERATOR_ID) || serialised.toLowerCase().includes(OPERATOR_UPN)) {
    throw new Error(`refusing ${name}: payload references the operator account`);
  }
  for (const key of ['assignments', 'appliesTo', 'includeUsers', 'includeGroups', 'targets']) {
    if (payload[key] !== undefined) {
      throw new Error(`refusing ${name}: payload carries "${key}" — fixtures must stay unassigned`);
    }
  }
  if (payload.isOrganizationDefault === true) {
    throw new Error(`refusing ${name}: payload would become an organisation default`);
  }
}

/**
 * The sign-in-path snapshot.
 *
 * The product's own §10.3 gate (`evaluatePromotion`) cannot be used here: the
 * Conditional Access evaluate API returns 403 AccessDenied for an application
 * credential, and that gate has never run against real Graph — its only test
 * uses a stub writer, so it has never met a 403. Recorded as a separate defect.
 *
 * So this proves the invariant directly instead of predicting it. Everything
 * that can stand between the operator and a successful sign-in is read before
 * and after the writes, and the two must be identical: Conditional Access
 * policies, the authentication methods policy, security defaults, the operator's
 * own account, and their directory role assignments.
 *
 * Read with the COLLECTOR credential, which holds no write scopes at all — the
 * evidence is gathered by an identity that could not have caused the change it
 * is checking for.
 */
async function signInPathSnapshot() {
  const cfg = JSON.parse(readFileSync('/etc/keel/tenant.json', 'utf8'));
  const readToken = (await getToken(cfg)).accessToken;
  const read = async (path) => {
    const res = await fetch(GRAPH + path, {
      headers: { authorization: `Bearer ${readToken}`, 'accept-language': 'en-US' },
    });
    if (!res.ok) {
      throw new Error(`sign-in path read failed (${res.status}) for ${path}`);
    }
    const body = await res.json();
    return body.value ?? body;
  };

  const [caPolicies, authMethods, securityDefaults, operator, roles] = await Promise.all([
    read('/v1.0/identity/conditionalAccess/policies'),
    read('/v1.0/policies/authenticationMethodsPolicy'),
    read('/v1.0/policies/identitySecurityDefaultsEnforcementPolicy'),
    read(`/v1.0/users/${OPERATOR_ID}?$select=id,userPrincipalName,accountEnabled,userType`),
    read(`/v1.0/users/${OPERATOR_ID}/transitiveMemberOf/microsoft.graph.directoryRole?$select=id,displayName`),
  ]);

  return {
    conditionalAccess: (caPolicies ?? []).map((p) => ({
      id: p.id,
      displayName: p.displayName,
      state: p.state,
      grantControls: p.grantControls ?? null,
      conditions: p.conditions ?? null,
    })).sort((a, b) => a.id.localeCompare(b.id)),
    authenticationMethods: authMethods,
    securityDefaults: { isEnabled: securityDefaults?.isEnabled ?? null },
    operator,
    directoryRoles: (roles ?? []).map((r) => r.id).sort(),
  };
}

function diffSignInPath(before, after) {
  const differences = [];
  for (const key of Object.keys(before)) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) differences.push(key);
  }
  return differences;
}

async function operatorSignInCheck(label) {
  const snapshot = await signInPathSnapshot();
  console.log(
    `  [${label}] CA policies: ${snapshot.conditionalAccess.length} | ` +
      `security defaults: ${snapshot.securityDefaults.isEnabled} | ` +
      `operator enabled: ${snapshot.operator.accountEnabled} | ` +
      `directory roles: ${snapshot.directoryRoles.length}`,
  );
  return snapshot;
}

/* -------------------------------------------------------------- manifest --- */

function readManifest() {
  if (!existsSync(MANIFEST)) return { created: [] };
  return JSON.parse(readFileSync(MANIFEST, 'utf8'));
}

function recordCreated(entry) {
  const manifest = readManifest();
  manifest.created.push({ ...entry, at: new Date().toISOString() });
  mkdirSync(dirname(MANIFEST), { recursive: true });
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
}

/* --------------------------------------------------------------- fixtures --- */

/**
 * Realistic for an enterprise of this shape, so that canonicalisation, natural
 * keys and fidelity are exercised on plausible payloads rather than on stubs.
 * `deletePath` is how cleanup removes it; `collection` is the POST target.
 */
const FIXTURES = [
  // --- Intune: device classification and terms -----------------------------
  {
    type: 'deviceCategory',
    collection: '/v1.0/deviceManagement/deviceCategories',
    payload: { displayName: 'Corporate Laptops', description: 'Standard-issue Windows fleet' },
  },
  {
    type: 'deviceCategory',
    collection: '/v1.0/deviceManagement/deviceCategories',
    payload: { displayName: 'Field Tablets', description: 'Shared devices used on customer sites' },
  },
  {
    type: 'deviceCategory',
    collection: '/v1.0/deviceManagement/deviceCategories',
    payload: { displayName: 'Executive Mobile', description: 'Named-user phones, tier 1 handling' },
  },
  {
    type: 'termsAndConditions',
    collection: '/beta/deviceManagement/termsAndConditions',
    payload: {
      displayName: 'Acceptable Use Policy 2026',
      description: 'Annual acceptable use terms presented at enrolment',
      title: 'Acceptable Use Policy',
      bodyText:
        'Company devices are provided for business use. Report loss or theft to IT immediately.',
      acceptanceStatement: 'I have read and accept the Acceptable Use Policy.',
      version: 1,
    },
  },
  {
    type: 'windowsAutopilotDeploymentProfile',
    collection: '/beta/deviceManagement/windowsAutopilotDeploymentProfiles',
    payload: {
      '@odata.type': '#microsoft.graph.azureADWindowsAutopilotDeploymentProfile',
      displayName: 'Corporate Standard — Autopilot',
      description: 'User-driven Entra join for standard-issue laptops',
      language: 'en-GB',
      outOfBoxExperienceSettings: {
        hidePrivacySettings: true,
        hideEULA: true,
        userType: 'standard',
        deviceUsageType: 'singleUser',
        skipKeyboardSelectionPage: false,
        hideEscapeLink: true,
      },
      enrollmentStatusScreenSettings: {
        hideInstallationProgress: false,
        allowDeviceUseBeforeProfileAndAppInstallComplete: false,
        blockDeviceSetupRetryByUser: false,
      },
      extractHardwareHash: true,
      deviceNameTemplate: 'CORP-%SERIAL%',
    },
  },

  // --- Intune: application management --------------------------------------
  {
    type: 'managedAppPolicy',
    collection: '/v1.0/deviceAppManagement/managedAppPolicies',
    payload: {
      '@odata.type': '#microsoft.graph.iosManagedAppProtection',
      displayName: 'Mobile Data Protection — iOS',
      description: 'Prevents corporate data leaving managed applications',
      saveAsBlocked: true,
      contactSyncBlocked: true,
      printBlocked: true,
      allowedInboundDataTransferSources: 'managedApps',
      allowedOutboundDataTransferDestinations: 'managedApps',
      allowedOutboundClipboardSharingLevel: 'managedAppsWithPasteIn',
      pinRequired: true,
      maximumPinRetries: 5,
    },
  },
  {
    type: 'targetedManagedAppConfiguration',
    collection: '/v1.0/deviceAppManagement/targetedManagedAppConfigurations',
    payload: {
      displayName: 'Managed Browser Configuration',
      description: 'Homepage and bookmark defaults for the managed browser',
      customSettings: [
        { name: 'com.microsoft.intune.mam.managedbrowser.homepage', value: 'https://intranet.example.com' },
        { name: 'com.microsoft.intune.mam.managedbrowser.bookmarks', value: 'IT Helpdesk|https://helpdesk.example.com' },
      ],
    },
  },

  // --- Entra: application-scoped policies, all unassigned -------------------
  {
    type: 'claimsMappingPolicy',
    collection: '/v1.0/policies/claimsMappingPolicies',
    payload: {
      displayName: 'SAML Claims — HR SaaS',
      definition: [
        JSON.stringify({
          ClaimsMappingPolicy: {
            Version: 1,
            IncludeBasicClaimSet: 'true',
            ClaimsSchema: [
              { Source: 'user', ID: 'employeeid', SamlClaimType: 'https://schemas.example.com/claims/employeeid' },
            ],
          },
        }),
      ],
    },
  },
  {
    type: 'homeRealmDiscoveryPolicy',
    collection: '/v1.0/policies/homeRealmDiscoveryPolicies',
    payload: {
      displayName: 'Home Realm Discovery — Partner Portal',
      definition: [JSON.stringify({ HomeRealmDiscoveryPolicy: { AccelerateToFederatedDomain: false } })],
    },
  },
  {
    type: 'tokenIssuancePolicy',
    collection: '/v1.0/policies/tokenIssuancePolicies',
    payload: {
      displayName: 'SAML Token Issuance — Legacy Finance App',
      definition: [
        JSON.stringify({
          TokenIssuancePolicy: { Version: 1, SigningAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256', TokenResponseSigningPolicy: 'TokenOnly' },
        }),
      ],
    },
  },
  {
    type: 'tokenLifetimePolicy',
    collection: '/v1.0/policies/tokenLifetimePolicies',
    payload: {
      displayName: 'Extended Session — Shop Floor Kiosk',
      definition: [JSON.stringify({ TokenLifetimePolicy: { Version: 1, AccessTokenLifetime: '08:00:00' } })],
    },
  },
  {
    type: 'activityBasedTimeoutPolicy',
    collection: '/v1.0/policies/activityBasedTimeoutPolicies',
    payload: {
      displayName: 'Idle Timeout — Shared Workstations',
      definition: [
        JSON.stringify({ ActivityBasedTimeoutPolicy: { Version: 1, ApplicationPolicies: [{ ApplicationId: 'default', WebSessionIdleTimeout: '02:00:00' }] } }),
      ],
      isOrganizationDefault: false,
    },
  },

  // --- Entra: conditional access context (referenced by nothing) ------------
  {
    type: 'authenticationContextClassReference',
    collection: '/v1.0/identity/conditionalAccess/authenticationContextClassReferences',
    payload: {
      id: 'c25',
      displayName: 'Finance — Payment Approval',
      description: 'Step-up context for payment approval flows',
      isAvailable: true,
    },
    idIsClientSupplied: true,
  },

  // --- Identity governance --------------------------------------------------
  {
    type: 'connectedOrganization',
    collection: '/v1.0/identityGovernance/entitlementManagement/connectedOrganizations',
    payload: {
      displayName: 'Northwind Logistics (Supplier)',
      description: 'External supplier organisation for guest access reviews',
      state: 'configured',
    },
  },
];

/* ------------------------------------------------------------------- run --- */

async function create() {
  console.log('KEEL enterprise coverage fixtures\n');

  console.log('Pre-flight:');
  const before = await operatorSignInCheck('before');
  if (before.operator.accountEnabled !== true) {
    throw new Error('operator account is not enabled before any write — refusing to proceed');
  }

  // The access package needs a catalog to live in; create one first so the
  // accessPackage fixture has a parent.
  console.log('\nCreating fixtures:');
  const catalog = await graph('POST', '/v1.0/identityGovernance/entitlementManagement/catalogs', {
    displayName: `${SCENARIO_PREFIX} Finance Systems`,
    description: 'Access packages for finance line-of-business systems',
    isExternallyVisible: false,
  });
  if (catalog.ok) {
    recordCreated({
      type: 'accessPackageCatalog',
      id: catalog.body.id,
      deletePath: `/v1.0/identityGovernance/entitlementManagement/catalogs/${catalog.body.id}`,
    });
    console.log(`  ok   accessPackageCatalog        ${catalog.body.id}`);

    const pkg = await graph('POST', '/v1.0/identityGovernance/entitlementManagement/accessPackages', {
      displayName: `${SCENARIO_PREFIX} Finance — Quarterly Close Access`,
      description: 'Time-bound access to close-period finance systems',
      isHidden: false,
      catalog: { id: catalog.body.id },
    });
    if (pkg.ok) {
      recordCreated({
        type: 'accessPackage',
        id: pkg.body.id,
        deletePath: `/v1.0/identityGovernance/entitlementManagement/accessPackages/${pkg.body.id}`,
      });
      console.log(`  ok   accessPackage               ${pkg.body.id}`);
    } else {
      console.log(`  FAIL accessPackage               ${pkg.status} ${pkg.body?.error?.code ?? ''}`);
    }
  } else {
    console.log(`  FAIL accessPackageCatalog        ${catalog.status} ${catalog.body?.error?.code ?? ''}`);
  }

  for (const fixture of FIXTURES) {
    assertInert(fixture.type, fixture.payload);
    // Carry the scenario prefix so every synthetic object in this tenant is
    // findable and removable by one string, alongside the rehearsal's own.
    const payload = fixture.payload.displayName
      ? { ...fixture.payload, displayName: `${SCENARIO_PREFIX} ${fixture.payload.displayName}` }
      : fixture.payload;
    // Types with a client-supplied id are upserted with PATCH; POSTing to the
    // collection returns 405 for these (measured on authenticationContextClassReference).
    const res = fixture.idIsClientSupplied
      ? await graph('PATCH', `${fixture.collection}/${fixture.payload.id}`, payload)
      : await graph('POST', fixture.collection, payload);
    if (res.ok) {
      const id = fixture.idIsClientSupplied ? fixture.payload.id : res.body?.id;
      recordCreated({
        type: fixture.type,
        id,
        deletePath: `${fixture.collection}/${id}`,
      });
      console.log(`  ok   ${fixture.type.padEnd(28)} ${id}`);
    } else {
      console.log(
        `  FAIL ${fixture.type.padEnd(28)} ${res.status} ${res.body?.error?.code ?? ''} ${(res.body?.error?.message ?? '').slice(0, 90)}`,
      );
    }
  }

  console.log('\nPost-flight:');
  const after = await operatorSignInCheck('after');
  const changed = diffSignInPath(before, after);
  if (changed.length > 0) {
    console.error(`\nSIGN-IN PATH CHANGED (${changed.join(', ')}) — rolling back now`);
    await cleanup();
    throw new Error(`rolled back: fixtures altered the sign-in path (${changed.join(', ')})`);
  }

  const manifest = readManifest();
  console.log(`\n${manifest.created.length} object(s) created. Manifest: ${MANIFEST}`);
  console.log(
    'Sign-in path byte-identical before and after: Conditional Access policies, authentication\n' +
      'methods policy, security defaults, the operator account and its directory roles all unchanged.',
  );
}

async function cleanup() {
  const manifest = readManifest();
  if (manifest.created.length === 0) {
    console.log('manifest is empty — nothing to clean up');
    return;
  }
  console.log(`Deleting ${manifest.created.length} object(s):`);
  const survivors = [];
  // Reverse order so a child (access package) goes before its parent (catalog).
  for (const entry of [...manifest.created].reverse()) {
    const res = await graph('DELETE', entry.deletePath);
    const gone = res.ok || res.status === 404;
    console.log(`  ${gone ? 'ok  ' : 'FAIL'} ${entry.type.padEnd(28)} ${entry.id} (${res.status})`);
    if (!gone) survivors.push(entry);
  }
  writeFileSync(MANIFEST, JSON.stringify({ created: survivors }, null, 2));
  console.log(
    survivors.length === 0
      ? '\nAll fixtures removed; manifest is empty.'
      : `\n${survivors.length} object(s) survived deletion and remain in the manifest.`,
  );
}

const mode = process.argv[2];
if (mode === '--cleanup') {
  await cleanup();
} else if (mode === '--create') {
  await create();
} else if (mode === '--check') {
  // Read-only: exercises the sign-in-path gate without writing anything.
  const snapshot = await operatorSignInCheck('check');
  console.log(JSON.stringify(snapshot, null, 2).slice(0, 1200));
} else {
  console.log('usage: fixtures.mjs --create | --cleanup | --check');
  process.exit(2);
}
