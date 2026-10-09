/**
 * Roadmap task-149: restore of the tenant-wide Entra security policies.
 *
 * These are singletons (one object per tenant) plus the per-partner
 * cross-tenant settings. Before this module every one of them was collected
 * but its restore decision was "research-needed", so a bad change to guest
 * access, the authentication methods policy, security defaults or B2B trust
 * could be seen but not rolled back.
 *
 * Each operation is an explicit record. A record names its exact route and
 * method (PATCH, or PUT for the admin consent request policy), its least
 * privileged permission and the fields it may write. Nothing outside those
 * fields is ever sent: the body is built from the record's allowlist, never
 * from the snapshot payload as a whole.
 *
 * Three types can lock every user out of the tenant when they are written
 * wrongly: the authentication methods policy, security defaults and the
 * authorization policy. Their records are `lockout: true`, and applyWave
 * writes them only when the caller supplies a lockout gate that allows the
 * write (engine/safety/lockoutGate.mjs: the registered break-glass accounts
 * must stay ready under the PROPOSED policy). Without a gate they are skipped,
 * never written.
 *
 * The restore sign-in path gate (signInPathGate.mjs) treats any change to the
 * authentication methods policy or security defaults as a failure. A write
 * here that read back exactly as intended reports the section it changed
 * (`signInPathSection`), and applyWave excludes only those sections from the
 * comparison. Every other section (Conditional Access, protected accounts,
 * their role assignments) must still be unchanged.
 *
 * The capability registry (capabilities.mjs) holds the claims; this module
 * never raises one.
 *
 * Documentation note: learn.microsoft.com is not reachable from the build
 * container, so the routes, permissions and fields below are declarations to
 * confirm against the current Graph v1.0 reference before any live
 * qualification (see docs/roadmap/tenant-policy-fidelity.md).
 */
import { isDeepStrictEqual } from 'node:util';

import { capabilityFor, isSupportedClaim } from '../coverage/capabilities.mjs';

export const TENANT_POLICY_OPERATIONS_CONTRACT_VERSION = 1;

const DOCS = 'https://learn.microsoft.com/en-us/graph/api';
const PARTNERS = '/policies/crossTenantAccessPolicy/partners';

const CROSS_TENANT_SETTINGS = Object.freeze([
  'automaticUserConsentSettings', 'b2bCollaborationInbound', 'b2bCollaborationOutbound',
  'b2bDirectConnectInbound', 'b2bDirectConnectOutbound', 'inboundTrust', 'tenantRestrictions',
]);

const record = (fields) => Object.freeze({ ...fields, writableFields: Object.freeze(fields.writableFields) });

/** The operation records. */
export const TENANT_POLICY_RECORDS = Object.freeze([
  record({
    resourceType: 'authorizationPolicy',
    operation: 'update',
    route: '/policies/authorizationPolicy',
    method: 'PATCH',
    permission: 'Policy.ReadWrite.Authorization',
    docs: `${DOCS}/authorizationpolicy-update?view=graph-rest-1.0`,
    lockout: true,
    signInPathSection: null,
    writableFields: [
      'allowEmailVerifiedUsersToJoinOrganization', 'allowInvitesFrom', 'allowUserConsentForRiskyApps',
      'allowedToSignUpEmailBasedSubscriptions', 'allowedToUseSSPR', 'blockMsolPowerShell',
      'defaultUserRolePermissions', 'guestUserRoleId',
    ],
  }),
  record({
    resourceType: 'authenticationMethodsPolicy',
    operation: 'update',
    route: '/policies/authenticationMethodsPolicy',
    method: 'PATCH',
    permission: 'Policy.ReadWrite.AuthenticationMethod',
    docs: `${DOCS}/authenticationmethodspolicy-update?view=graph-rest-1.0`,
    lockout: true,
    signInPathSection: 'authenticationMethodsPolicy',
    // Each method (FIDO2, Authenticator, SMS, ...) is its own sub-resource,
    // written one PATCH at a time; see methodConfigurationWrites().
    methodConfigurations: true,
    writableFields: ['registrationEnforcement', 'reportSuspiciousActivitySettings', 'systemCredentialPreferences'],
  }),
  record({
    resourceType: 'identitySecurityDefaultsEnforcementPolicy',
    operation: 'update',
    route: '/policies/identitySecurityDefaultsEnforcementPolicy',
    method: 'PATCH',
    permission: 'Policy.ReadWrite.SecurityDefaults',
    docs: `${DOCS}/identitysecuritydefaultsenforcementpolicy-update?view=graph-rest-1.0`,
    lockout: true,
    signInPathSection: 'securityDefaults',
    writableFields: ['isEnabled'],
  }),
  record({
    resourceType: 'crossTenantAccessPolicy',
    operation: 'update',
    route: '/policies/crossTenantAccessPolicy',
    method: 'PATCH',
    permission: 'Policy.ReadWrite.CrossTenantAccess',
    docs: `${DOCS}/crosstenantaccesspolicy-update?view=graph-rest-1.0`,
    lockout: false,
    signInPathSection: null,
    writableFields: ['allowedCloudEndpoints'],
  }),
  record({
    resourceType: 'crossTenantAccessPolicyConfigurationDefault',
    operation: 'update',
    route: '/policies/crossTenantAccessPolicy/default',
    method: 'PATCH',
    permission: 'Policy.ReadWrite.CrossTenantAccess',
    docs: `${DOCS}/crosstenantaccesspolicyconfigurationdefault-update?view=graph-rest-1.0`,
    lockout: false,
    signInPathSection: null,
    writableFields: [...CROSS_TENANT_SETTINGS, 'invitationRedemptionIdentityProviderConfiguration'],
  }),
  record({
    resourceType: 'crossTenantAccessPolicyPartner',
    operation: 'create',
    route: PARTNERS,
    method: 'POST',
    permission: 'Policy.ReadWrite.CrossTenantAccess',
    docs: `${DOCS}/crosstenantaccesspolicy-post-partners?view=graph-rest-1.0`,
    lockout: false,
    signInPathSection: null,
    // tenantId names the partner and is sent on create only.
    writableFields: ['tenantId', ...CROSS_TENANT_SETTINGS],
  }),
  record({
    resourceType: 'crossTenantAccessPolicyPartner',
    operation: 'update',
    route: `${PARTNERS}/{tenantId}`,
    method: 'PATCH',
    permission: 'Policy.ReadWrite.CrossTenantAccess',
    docs: `${DOCS}/crosstenantaccesspolicyconfigurationpartner-update?view=graph-rest-1.0`,
    lockout: false,
    signInPathSection: null,
    writableFields: [...CROSS_TENANT_SETTINGS],
  }),
  record({
    resourceType: 'adminConsentRequestPolicy',
    operation: 'update',
    route: '/policies/adminConsentRequestPolicy',
    // PUT replaces the whole policy, so the body always carries every writable field.
    method: 'PUT',
    permission: 'Policy.ReadWrite.ConsentRequest',
    docs: `${DOCS}/adminconsentrequestpolicy-update?view=graph-rest-1.0`,
    lockout: false,
    signInPathSection: null,
    writableFields: ['isEnabled', 'notifyReviewers', 'remindersEnabled', 'requestDurationInDays', 'reviewers'],
  }),
]);

const GOVERNED_TYPES = new Set(TENANT_POLICY_RECORDS.map((entry) => entry.resourceType));

/** The registry write path of each governed type (capabilities.mjs registers these). */
export const TENANT_POLICY_PATHS = Object.freeze(Object.fromEntries([...GOVERNED_TYPES].map((type) => [
  type, type === 'crossTenantAccessPolicyPartner' ? PARTNERS : TENANT_POLICY_RECORDS.find((entry) => entry.resourceType === type).route,
])));

/**
 * The @odata.type each method configuration must carry on its PATCH. The
 * snapshot's canonical payload drops @odata annotations, so it is restored
 * from this table. A method id outside it is refused, never guessed.
 */
export const METHOD_CONFIGURATION_TYPES = Object.freeze({
  email: '#microsoft.graph.emailAuthenticationMethodConfiguration',
  fido2: '#microsoft.graph.fido2AuthenticationMethodConfiguration',
  hardwareoath: '#microsoft.graph.hardwareOathAuthenticationMethodConfiguration',
  microsoftauthenticator: '#microsoft.graph.microsoftAuthenticatorAuthenticationMethodConfiguration',
  sms: '#microsoft.graph.smsAuthenticationMethodConfiguration',
  softwareoath: '#microsoft.graph.softwareOathAuthenticationMethodConfiguration',
  temporaryaccesspass: '#microsoft.graph.temporaryAccessPassAuthenticationMethodConfiguration',
  voice: '#microsoft.graph.voiceAuthenticationMethodConfiguration',
  x509certificate: '#microsoft.graph.x509CertificateAuthenticationMethodConfiguration',
});

const METHOD_CONFIGURATIONS = '/policies/authenticationMethodsPolicy/authenticationMethodConfigurations';

export function isTenantPolicyGoverned(resourceType) {
  return GOVERNED_TYPES.has(resourceType);
}

export function tenantPolicyRecordFor(resourceType, operation) {
  return TENANT_POLICY_RECORDS.find((entry) => entry.resourceType === resourceType && entry.operation === operation) ?? null;
}

function refusal(outcome, reason) {
  return Object.freeze({ outcome, reason });
}

function partnerTenantId(resource) {
  const id = resource.payload?.tenantId ?? resource.live?.payload?.tenantId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/** The exact Graph path one write of `resource` goes to. */
export function tenantPolicyRoute(entry, resource) {
  if (!entry.route.includes('{tenantId}')) return entry.route;
  const tenantId = partnerTenantId(resource);
  if (!tenantId) throw new Error(`${resource.naturalKey}: a partner write needs the partner's tenantId`);
  return entry.route.replace('{tenantId}', encodeURIComponent(tenantId));
}

/**
 * The write-time gate applyWave runs for a governed type, before the journal
 * or the writer. Returns null when the write may proceed, otherwise
 * { outcome, reason }: a lockout-sensitive write without an allowing lockout
 * gate is 'skipped' (it is withheld, not broken); every other refusal is
 * 'failed'.
 *
 * `lockoutGate.evaluate({ resourceType, desired })` returns
 * { allowed, reason }; see engine/safety/lockoutGate.mjs.
 */
export function tenantPolicyWriteRefusal(resource, verb, { lockoutGate = null } = {}) {
  if (!isTenantPolicyGoverned(resource.resourceType)) return null;
  const entry = tenantPolicyRecordFor(resource.resourceType, verb);
  if (!entry) return refusal('failed', `no tenant policy operation record covers ${resource.resourceType} ${verb}`);
  if (!isSupportedClaim(capabilityFor(resource.resourceType, verb).claim)) {
    return refusal('failed', `${resource.resourceType} ${verb} is not a registered write capability`);
  }
  if (!resource.payload || typeof resource.payload !== 'object') {
    return refusal('failed', `${resource.resourceType} ${verb}: the snapshot holds no policy to restore`);
  }
  if (verb === 'update' && (!resource.live?.payload || (resource.live.state !== undefined && resource.live.state !== 'present'))) {
    return refusal('failed', `dependency: no live ${resource.resourceType} was observed, so the update cannot be checked against it`);
  }
  if (resource.resourceType === 'crossTenantAccessPolicyPartner' && !partnerTenantId(resource)) {
    return refusal('failed', 'dependency: the partner configuration names no tenantId');
  }
  if (entry.methodConfigurations) {
    const unknown = (resource.payload.authenticationMethodConfigurations ?? [])
      .map((config) => config?.id)
      .filter((id) => typeof id !== 'string' || !METHOD_CONFIGURATION_TYPES[id.toLowerCase()]);
    if (unknown.length > 0) {
      return refusal('failed', `unsupported: authentication method configuration ${unknown.join(', ')} has no known type, so it cannot be written`);
    }
    const liveIds = new Set((resource.live.payload.authenticationMethodConfigurations ?? []).map((config) => String(config?.id ?? '').toLowerCase()));
    const missing = (resource.payload.authenticationMethodConfigurations ?? []).filter((config) => !liveIds.has(config.id.toLowerCase()));
    if (missing.length > 0) {
      return refusal('failed', `dependency: method ${missing.map((config) => config.id).join(', ')} does not exist in the live policy and cannot be created`);
    }
  }
  if (entry.lockout) {
    if (!lockoutGate || typeof lockoutGate.evaluate !== 'function') {
      return refusal('skipped', `tenant-lockout policy: ${resource.resourceType} is written only behind the break-glass lockout gate, and none was supplied`);
    }
    const verdict = lockoutGate.evaluate({ resourceType: resource.resourceType, desired: resource.payload });
    if (verdict?.allowed !== true) {
      return refusal('skipped', `tenant-lockout policy: ${resource.resourceType} withheld by the break-glass lockout gate — ${verdict?.reason ?? 'no verdict'}`);
    }
  }
  return null;
}

/** Order-insensitive, null-insensitive normal form used for comparison only. */
export function comparable(value) {
  if (Array.isArray(value)) {
    return value.map(comparable).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (key.includes('@odata.')) continue;
      if (value[key] === null || value[key] === undefined) continue;
      out[key] = comparable(value[key]);
    }
    return out;
  }
  return value;
}

function sameValue(left, right) {
  return isDeepStrictEqual(comparable(left ?? null) ?? null, comparable(right ?? null) ?? null);
}

/** The writable fields whose desired value differs from the live one. */
export function changedFields(entry, desired, live) {
  return entry.writableFields.filter((field) => Object.hasOwn(desired ?? {}, field) && !sameValue(desired[field], live?.[field]));
}

function withoutAnnotations(value) {
  if (Array.isArray(value)) return value.map(withoutAnnotations);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !key.includes('@odata.'))
      .map(([key, item]) => [key, withoutAnnotations(item)]));
  }
  return value;
}

/**
 * The root write: method, path and body, or null when nothing at the root
 * changed. A PATCH carries only the changed writable fields; a PUT carries
 * every writable field the snapshot holds; a create carries every writable
 * field the snapshot holds.
 */
export function tenantPolicyRootWrite(entry, resource, desired) {
  const live = resource.live?.payload ?? null;
  const fields = entry.method === 'PATCH' ? changedFields(entry, desired, live)
    : entry.writableFields.filter((field) => Object.hasOwn(desired, field));
  if (entry.method === 'PATCH' && fields.length === 0) return null;
  if (entry.method === 'PUT' && changedFields(entry, desired, live).length === 0) return null;
  const body = Object.fromEntries(fields.map((field) => [field, withoutAnnotations(desired[field])]));
  return { method: entry.method, path: tenantPolicyRoute(entry, resource), body, fields };
}

/**
 * One PATCH per authentication method whose configuration differs from the
 * live one. The body is the snapshot configuration without its id or any
 * annotation, plus the @odata.type Graph requires.
 */
export function methodConfigurationWrites(resource, desired) {
  const live = resource.live?.payload?.authenticationMethodConfigurations ?? [];
  const writes = [];
  for (const config of desired.authenticationMethodConfigurations ?? []) {
    const current = live.find((entry) => String(entry?.id ?? '').toLowerCase() === config.id.toLowerCase());
    const { id, ...rest } = withoutAnnotations(config);
    if (current && sameValue(rest, withoutId(current))) continue;
    writes.push({
      method: 'PATCH',
      path: `${METHOD_CONFIGURATIONS}/${encodeURIComponent(id)}`,
      body: { '@odata.type': METHOD_CONFIGURATION_TYPES[id.toLowerCase()], ...rest },
      methodId: id,
    });
  }
  return writes;
}

function withoutId(value) {
  const { id: _id, ...rest } = withoutAnnotations(value ?? {});
  return rest;
}

/**
 * After the writes, every written field (and every written method
 * configuration) must read back as desired. Returns the reason, or null.
 */
export function tenantPolicyPostStateRefusal(entry, desired, live, { fields = [], methods = [] } = {}) {
  const wrong = fields.filter((field) => !sameValue(desired[field], live?.[field]));
  for (const id of methods) {
    const want = (desired.authenticationMethodConfigurations ?? []).find((config) => config.id.toLowerCase() === id.toLowerCase());
    const got = (live?.authenticationMethodConfigurations ?? []).find((config) => String(config?.id ?? '').toLowerCase() === id.toLowerCase());
    if (!got || !sameValue(withoutId(want), withoutId(got))) wrong.push(`authenticationMethodConfigurations[${id}]`);
  }
  return wrong.length > 0 ? `post-state: ${wrong.join(', ')} did not read back as written` : null;
}

/** The family ledger: every record with its claim. No coverage percentage. */
export function buildTenantPolicyLedger() {
  return Object.freeze({
    contractVersion: TENANT_POLICY_OPERATIONS_CONTRACT_VERSION,
    operations: Object.freeze(TENANT_POLICY_RECORDS.map((entry) => Object.freeze({
      resourceType: entry.resourceType,
      operation: entry.operation,
      route: `${entry.method} ${entry.route}`,
      permission: entry.permission,
      writableFields: entry.writableFields,
      lockout: entry.lockout,
      claim: capabilityFor(entry.resourceType, entry.operation).claim,
    }))),
  });
}
