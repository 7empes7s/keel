/**
 * Reference resolvability analysis.
 *
 * This is the measurement that decides whether the CIR design in spec §6 is
 * viable. Every GUID a resource carries is either resolvable to a natural key
 * we can re-materialise in a different tenant, or it is not. The unresolvable
 * fraction is the honest upper bound on cross-tenant restore fidelity, and it
 * is precisely the class of failure that produced CoreView's 6,422 errors.
 */

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * First-party Microsoft identifiers are identical in every tenant, so they need
 * no remapping. Treating them as unresolvable would overstate the problem.
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
  ['62e90394-69f5-4237-9190-012177145e10', 'Global Administrator (role template)'],
]);

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

/** Recursively yield every GUID-shaped string with its JSON path. */
function* walkGuids(node, path = '') {
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
 * @param collected Map<type, object[]>
 */
export function analyseReferences(collected) {
  // Index every object we saw, by id, so references can be resolved.
  const index = new Map();
  for (const [type, objects] of collected) {
    for (const obj of objects) {
      if (typeof obj?.id === 'string' && GUID.test(obj.id)) {
        index.set(obj.id.toLowerCase(), { type, key: naturalKey(type, obj) });
      }
      // Service principals are referenced by appId as often as by objectId.
      if (typeof obj?.appId === 'string' && GUID.test(obj.appId)) {
        index.set(obj.appId.toLowerCase(), { type, key: naturalKey(type, obj) });
      }
    }
  }

  const summary = {
    indexedObjects: index.size,
    totalReferences: 0,
    selfReferences: 0,
    resolvable: 0,
    wellKnown: 0,
    unresolvable: 0,
    byType: {},
    unresolvedSamples: [],
  };

  for (const [type, objects] of collected) {
    const perType = { total: 0, resolvable: 0, wellKnown: 0, unresolvable: 0, unresolvedFields: {} };

    for (const obj of objects) {
      const ownIds = new Set(
        [obj?.id, obj?.appId].filter((v) => typeof v === 'string').map((v) => v.toLowerCase()),
      );

      for (const { path, guid } of walkGuids(obj)) {
        if (ownIds.has(guid)) {
          summary.selfReferences++;
          continue;
        }
        summary.totalReferences++;
        perType.total++;

        if (index.has(guid)) {
          summary.resolvable++;
          perType.resolvable++;
        } else if (WELL_KNOWN.has(guid)) {
          summary.wellKnown++;
          perType.wellKnown++;
        } else {
          summary.unresolvable++;
          perType.unresolvable++;
          perType.unresolvedFields[path] = (perType.unresolvedFields[path] ?? 0) + 1;
          if (summary.unresolvedSamples.length < 40) {
            summary.unresolvedSamples.push({ type, field: path, guid });
          }
        }
      }
    }

    if (perType.total > 0) summary.byType[type] = perType;
  }

  return summary;
}
