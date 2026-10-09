/**
 * Reference resolvability analysis.
 *
 * This module produces the number the M1 go/no-go decision rests on: of every
 * GUID a tenant's configuration carries, what fraction can be re-pointed when
 * the configuration is rebuilt in a different tenant.
 *
 * A naive "is this GUID one of the objects I collected?" test is badly wrong,
 * and wrong in the direction that manufactures alarm. Microsoft-global
 * identifiers — permission ids, licence SKUs, service plans, built-in role
 * templates — are identical in every tenant and need no remapping at all.
 * Counting them as unresolvable inflates the failure estimate with references
 * that were never at risk. The first run against a real tenant reported 54.1%
 * unresolvable, almost all of it this artefact.
 *
 * So references are classified into five kinds, and only the last is a
 * cross-tenant restore risk:
 *
 *   identity        the object's own id, or a child element's id — not a reference
 *   nonReference    a GUID-shaped string in a name field — not a reference
 *   resolvable      points at a tenant object we can re-materialise by natural key
 *   globalConstant  a Microsoft-defined id, identical in every tenant
 *   foreignTenant   an external tenant's id, preserved verbatim by design
 *   unresolvable    points at something in this tenant we cannot name  ← the risk
 */

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The literal all-zero GUID is Graph's "no target" sentinel — e.g.
 * excludeTarget.id when a policy excludes no principal. It points at nothing,
 * so it is not a reference and cannot dangle. Deliberately NOT a wildcard on
 * the last digit: 00000000-0000-0000-0000-000000000001 is a different,
 * separately-verified reserved value (see WELL_KNOWN below), not "no target".
 */
const SENTINEL = /^0{8}-0{4}-0{4}-0{4}-0{12}$/;

/** Array indices carry no meaning for classification: foo[3].bar -> foo.bar */
const normalisePath = (p) => p.replace(/\[\d+\]/g, '');

/**
 * Field paths whose values are defined by Microsoft, not by the tenant.
 *
 * These are asserted from the Graph schema, not proven by observation: proving
 * that a value is genuinely tenant-independent requires seeing the same id in a
 * second tenant. Until the probe has run against two tenants, every entry here
 * is a documented assumption rather than a measurement.
 */
const GLOBAL_CONSTANT_FIELDS = [
  /(^|\.)skuId$/,
  /(^|\.)servicePlanId$/,
  /(^|\.)roleTemplateId$/,
  /(^|\.)templateId$/,
  // Permission ids are defined by the resource application, not the tenant:
  // the same id means the same permission in every tenant. (Ids published by
  // THIS tenant's apps resolve through the index before this rule is reached.)
  /^requiredResourceAccess\.resourceAccess\.id$/,
  /(^|\.)builtInStandardId$/,
  // Roadmap task-149: the authorization policy's guest role is one of three
  // Microsoft-defined role template ids (User, Guest User, Restricted Guest
  // User), the same in every tenant.
  /^guestUserRoleId$/,
  // Gallery application templates are published by Microsoft, not the tenant.
  /(^|\.)applicationTemplateId$/,
  // FIDO2 keyRestrictions.aaGuids list FIDO Alliance authenticator model ids
  // (e.g. a YubiKey's AAGUID), defined by the FIDO Alliance, not the tenant.
  /(^|\.)aaGuids?$/i,
  // NOTE what is deliberately absent:
  //  - grantControls.authenticationStrength.id — only the three BUILT-IN
  //    strengths are global (WELL_KNOWN); custom strengths are tenant objects
  //    and must resolve through the index or report as unresolvable.
  //  - allowedPasskeyProfiles — the built-in default profile is WELL_KNOWN
  //    (0000...0001); any other id there is a tenant-created custom profile.
];

/**
 * Server-assigned fields. Graph rejects them on write, so they cannot fail to
 * restore — they are not settings at all. Counting them as unresolvable
 * references reports a risk that does not exist.
 */
const READ_ONLY_FIELDS = [
  /(^|\.)createdByAppId$/,
  /(^|\.)subscriptionIds$/,
  /(^|\.)appDisplayName$/,
  /(^|\.)publisherName$/,
];

/** Identifiers belonging to a different tenant, correct to preserve verbatim. */
const FOREIGN_TENANT_FIELDS = [
  /(^|\.)tenantId$/,
  /(^|\.)appOwnerOrganizationId$/,
  /(^|\.)homeTenantId$/,
];

/** Fields that hold names or free text, where a GUID match is coincidence. */
const NON_REFERENCE_FIELDS = [
  /(^|\.)mailNickname$/,
  /(^|\.)displayName$/,
  /(^|\.)description$/,
  /(^|\.)userPrincipalName$/,
  /(^|\.)value$/,
  /(^|\.)name$/,
];

/**
 * Ids of child elements owned by the parent object. They are identity, not
 * reference: they travel with the parent and are regenerated on write.
 */
const CHILD_IDENTITY_FIELDS = [
  /^(includes|excludes)\.id$/,
  /^authenticationMethodConfigurations\.id$/,
  /^servicePlans\.servicePlanId$/,
  /^verifiedDomains\.\w+$/,
  // Permissions and credentials an app or service principal publishes are its
  // own; they resolve to itself and must not be counted as outbound references.
  /^(appRoles|oauth2PermissionScopes|oauth2Permissions)\.id$/,
  /^api\.oauth2PermissionScopes\.id$/,
  /^(passwordCredentials|keyCredentials)\.(keyId|customKeyIdentifier)$/,
];

/**
 * App/object ids that are identical in every tenant by construction, for
 * tenants where the SP was not collected: first-party Microsoft apps, the
 * built-in authentication strengths, and the third-party mail clients named
 * in Microsoft's managed consent policies (their app registrations are global).
 */
const WELL_KNOWN = new Map([
  ['00000003-0000-0000-c000-000000000000', 'Microsoft Graph'],
  ['00000002-0000-0000-c000-000000000000', 'Azure AD Graph'],
  ['00000003-0000-0ff1-ce00-000000000000', 'SharePoint Online'],
  ['00000002-0000-0ff1-ce00-000000000000', 'Exchange Online'],
  ['cc15fd57-2c6c-4117-a88c-83b1d56b4bbe', 'Microsoft Teams Services'],
  ['00000012-0000-0000-c000-000000000000', 'Azure Rights Management'],
  ['797f4846-ba00-4fd7-ba43-dac1f8f63013', 'Windows Azure Service Management API'],
  ['0000000a-0000-0000-c000-000000000000', 'Microsoft Intune'],
  ['fc780465-2017-40d4-a0c5-307022471b92', 'Microsoft Intune Enrollment'],
  // Confirmed live 2026-09-03: the API's own response names this id
  // "Default passkey profile" inside authenticationMethodsPolicy — a built-in
  // FIDO2 profile, not a tenant-created object.
  ['00000000-0000-0000-0000-000000000001', 'Default passkey profile (built-in)'],
  // The three built-in authentication strengths — documented Microsoft-global
  // ids. CUSTOM authentication strengths are tenant objects with tenant-random
  // ids; they must resolve through the index or report as unresolvable.
  ['00000000-0000-0000-0000-000000000002', 'Multifactor authentication (built-in strength)'],
  ['00000000-0000-0000-0000-000000000003', 'Passwordless MFA (built-in strength)'],
  ['00000000-0000-0000-0000-000000000004', 'Phishing-resistant MFA (built-in strength)'],
  // Apps named in Microsoft's managed consent policies ("Manage app consent
  // policies", Microsoft Learn) — the same app id in every tenant, so a
  // permissionGrantPolicy listing them restores verbatim.
  ['fb78d390-0c51-40cd-8e17-fdbfab77341b', 'Exchange Online PowerShell'],
  ['f8d98a96-0999-43f5-8af3-69971c7bb423', 'Apple Mail'],
  ['b50c1dbd-1855-4e54-b07c-d3c3029e93d3', 'Spark Email'],
  ['e9a7fea1-1cc0-4cd9-a31b-9137ca5deedd', 'eM Client'],
  ['8acd33ea-7197-4a96-bc33-d7cc7101262f', 'Samsung Email for Android'],
  ['2cee05de-2b8f-45a2-8289-2a06ca32c4c8', 'Android Mail'],
  ['9e5f94bc-e8a4-4e73-b8be-63364c29d753', 'Thunderbird'],
]);

const matches = (patterns, path) => patterns.some((re) => re.test(path));

/**
 * Which fields carry an object's OWN identity, per type. Not every object is
 * identified by `id`: a subscribed SKU is identified by its skuId, and a
 * directory role by its role template. Treating those as outbound references
 * counts an object as pointing at itself.
 */
const OWN_IDENTITY_FIELDS = {
  subscribedSku: ['id', 'skuId'],
  directoryRole: ['id', 'roleTemplateId', 'templateId'],
  roleDefinition: ['id', 'templateId'],
  __default: ['id', 'appId'],
};

export function ownIdentifiers(type, obj) {
  const fields = OWN_IDENTITY_FIELDS[type] ?? OWN_IDENTITY_FIELDS.__default;
  return new Set(
    fields
      .map((f) => obj?.[f])
      .filter((v) => typeof v === 'string')
      .map((v) => v.toLowerCase()),
  );
}

/** Natural key per type — the tenant-independent identity of an object. */
export function naturalKey(type, obj) {
  switch (type) {
    case 'user':
      return obj.userPrincipalName ?? obj.id;
    case 'group':
      return obj.mailNickname ?? obj.displayName ?? obj.id;
    case 'application':
    case 'servicePrincipal':
      return obj.appId ?? obj.displayName ?? obj.id;
    case 'domain':
      return obj.id;
    case 'subscribedSku':
      return obj.skuPartNumber ?? obj.id;
    case 'roleDefinition':
    case 'directoryRole':
      return obj.roleTemplateId ?? obj.templateId ?? obj.displayName ?? obj.id;
    default:
      return obj.displayName ?? obj.name ?? obj.id;
  }
}

/** Index kinds whose ids are a Microsoft-published catalog: the same GUID in
 * every tenant, preserved verbatim rather than remapped to a natural key. */
const CATALOG_KINDS = new Set(['roleTemplate', 'settingTemplate']);

/**
 * Build every resolution target the tenant offers.
 *
 * Beyond top-level objects this indexes the identifiers that live *inside*
 * objects and are referenced from elsewhere — chiefly the permission ids a
 * service principal publishes in appRoles and oauth2PermissionScopes, which is
 * what an application's requiredResourceAccess actually points at. Without
 * them, every delegated and application permission in the tenant looks like a
 * dangling reference.
 */
export function buildIndex(collected) {
  const index = new Map();
  const add = (guid, entry) => {
    if (typeof guid === 'string' && GUID.test(guid) && !index.has(guid.toLowerCase())) {
      index.set(guid.toLowerCase(), entry);
    }
  };

  for (const [type, objects] of collected) {
    for (const obj of objects) {
      // Built-in role templates are a Microsoft-defined catalog: the same id
      // means the same role in every tenant. Indexed distinctly from ordinary
      // objects so classify() can report them as verbatim, not remapped. The
      // same is true of directory setting templates (e.g. Group.Unified),
      // whose ids are also identical across tenants.
      if (type === 'directoryRoleTemplate' || type === 'directorySettingTemplate') {
        const kind = type === 'directoryRoleTemplate' ? 'roleTemplate' : 'settingTemplate';
        add(obj?.id, { type, key: naturalKey(type, obj), kind });
        continue;
      }

      add(obj?.id, { type, key: naturalKey(type, obj), kind: 'object' });
      if (obj?.appId) add(obj.appId, { type, key: naturalKey(type, obj), kind: 'object' });

      // Permissions published by a service principal, referenced by apps.
      if (type === 'servicePrincipal') {
        const sp = obj.appId ?? obj.id;
        for (const role of obj.appRoles ?? []) {
          add(role.id, { type: 'appRole', key: `${sp}/role:${role.value}`, kind: 'permission' });
        }
        for (const scope of obj.oauth2PermissionScopes ?? []) {
          add(scope.id, { type: 'oauth2Scope', key: `${sp}/scope:${scope.value}`, kind: 'permission' });
        }
      }

      // Licence identifiers, referenced from users and the organization.
      if (type === 'subscribedSku') {
        add(obj.skuId, { type: 'subscribedSku', key: obj.skuPartNumber, kind: 'sku' });
        for (const plan of obj.servicePlans ?? []) {
          add(plan.servicePlanId, {
            type: 'servicePlan',
            key: plan.servicePlanName,
            kind: 'servicePlan',
          });
        }
      }

      if (obj?.roleTemplateId) {
        add(obj.roleTemplateId, {
          type: 'roleTemplate',
          key: obj.displayName ?? obj.roleTemplateId,
          kind: 'roleTemplate',
        });
      }
    }
  }
  return index;
}

/** Recursively yield every GUID-shaped string with its JSON path. */
export function* walkGuids(node, path = '') {
  if (typeof node === 'string') {
    if (GUID.test(node)) yield { path, guid: node.toLowerCase() };
    return;
  }
  if (Array.isArray(node)) {
    for (const [i, v] of node.entries()) yield* walkGuids(v, `${path}[${i}]`);
    return;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      yield* walkGuids(v, path ? `${path}.${k}` : k);
    }
  }
}

/**
 * Classify one GUID occurrence. Order matters: identity and non-reference
 * checks come first so they are never counted as references at all; read-only
 * fields are excluded next because server-assigned values cannot be written
 * and so are never a restore risk, even when the target is one we collected;
 * and index resolution comes before the remaining field-path rules so an id
 * we can actually name is never written off as an opaque constant.
 */
export function classify({ path, guid, ownIds, index }) {
  const p = normalisePath(path);

  if (SENTINEL.test(guid)) return { klass: 'nonReference' };
  if (ownIds.has(guid)) return { klass: 'identity' };
  if (matches(CHILD_IDENTITY_FIELDS, p)) return { klass: 'identity' };
  if (matches(NON_REFERENCE_FIELDS, p)) return { klass: 'nonReference' };
  if (matches(READ_ONLY_FIELDS, p)) return { klass: 'readOnly' };

  const hit = index.get(guid);
  if (hit) {
    // Catalog ids (built-in role/setting templates) are the same GUID in every
    // tenant — preserved verbatim, not remapped to a different value.
    const klass = CATALOG_KINDS.has(hit.kind) ? 'globalConstant' : 'resolvable';
    return { klass, kind: hit.kind, key: hit.key };
  }
  if (WELL_KNOWN.has(guid)) return { klass: 'globalConstant', key: WELL_KNOWN.get(guid) };
  if (matches(GLOBAL_CONSTANT_FIELDS, p)) return { klass: 'globalConstant', key: null };
  if (matches(FOREIGN_TENANT_FIELDS, p)) return { klass: 'foreignTenant' };

  return { klass: 'unresolvable' };
}

/**
 * @param collected Map<type, object[]>
 */
export function analyseReferences(collected) {
  const index = buildIndex(collected);

  const summary = {
    indexedTargets: index.size,
    indexedByKind: {},
    identity: 0,
    nonReference: 0,
    totalReferences: 0,
    resolvable: 0,
    globalConstant: 0,
    foreignTenant: 0,
    readOnly: 0,
    unresolvable: 0,
    resolvableByKind: {},
    byType: {},
    unresolvedSamples: [],
  };

  for (const entry of index.values()) {
    summary.indexedByKind[entry.kind] = (summary.indexedByKind[entry.kind] ?? 0) + 1;
  }

  for (const [type, objects] of collected) {
    const perType = { total: 0, resolvable: 0, globalConstant: 0, foreignTenant: 0, readOnly: 0, unresolvable: 0, unresolvedFields: {} };

    for (const obj of objects) {
      const ownIds = ownIdentifiers(type, obj);

      for (const { path, guid } of walkGuids(obj)) {
        const c = classify({ path, guid, ownIds, index });

        if (c.klass === 'identity') {
          summary.identity++;
          continue;
        }
        if (c.klass === 'nonReference') {
          summary.nonReference++;
          continue;
        }

        summary.totalReferences++;
        perType.total++;
        summary[c.klass]++;
        perType[c.klass]++;

        if (c.klass === 'resolvable') {
          summary.resolvableByKind[c.kind] = (summary.resolvableByKind[c.kind] ?? 0) + 1;
        } else if (c.klass === 'unresolvable') {
          const p = normalisePath(path);
          perType.unresolvedFields[p] = (perType.unresolvedFields[p] ?? 0) + 1;
          if (summary.unresolvedSamples.length < 60) {
            summary.unresolvedSamples.push({ type, field: p, guid });
          }
        }
      }
    }

    if (perType.total > 0) summary.byType[type] = perType;
  }

  return summary;
}
