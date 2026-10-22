/**
 * The name a saved object is listed under, read from the field Microsoft names it by.
 * Most kinds use displayName (or name, title, ...). A few use other fields, and
 * every list, page and query names objects through this one table, in JavaScript
 * (objectName) and in SQL (objectNameSql), so they all agree.
 */

/** The fields most kinds are named by, best first. */
export const NAME_FIELDS = Object.freeze(['displayName', 'name', 'title', 'userPrincipalName', 'mail', 'subject']);

/**
 * Kinds named by other fields (issue #478), best first. Only these fields count:
 * a branding profile's displayName is the organization name it shows on devices,
 * the same for every profile, so it never names the profile.
 */
export const OWN_NAME_FIELDS = Object.freeze({
  intuneBrandingProfile: Object.freeze(['profileName']),
  groupPolicyUploadedDefinitionFile: Object.freeze(['fileName', 'displayName']),
  // Devices, tokens and connectors Graph saves with no displayName (or an empty one).
  managedDevice: Object.freeze(['deviceName', 'managedDeviceName', 'serialNumber']),
  windowsAutopilotDeviceIdentity: Object.freeze(['displayName', 'serialNumber']),
  deviceManagementExchangeConnector: Object.freeze(['serverName', 'exchangeAlias', 'primarySmtpAddress']),
  vppToken: Object.freeze(['displayName', 'organizationName', 'appleId']),
  depOnboardingSetting: Object.freeze(['tokenName', 'appleIdentifier']),
  enterpriseCodeSigningCertificate: Object.freeze(['subjectName', 'subject', 'issuerName']),
});

/** Kinds named after the two apps they link. */
export const RELATIONSHIP_KINDS = Object.freeze(['mobileAppRelationship']);
const UNNAMED_APP = 'an app with no name';

/** The fields a kind is named by. */
export const nameFieldsFor = (resourceType) => (RELATIONSHIP_KINDS.includes(resourceType)
  ? ['sourceDisplayName', 'targetDisplayName']
  : OWN_NAME_FIELDS[resourceType] ?? NAME_FIELDS);

const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);

/**
 * "Company Portal needs .NET runtime": an app dependency or supersedence, named by
 * its apps in the direction it points. targetType 'parent' means the target is the
 * app that depends on (or replaces) the source.
 */
function relationshipName(payload) {
  const source = text(payload.sourceDisplayName);
  const target = text(payload.targetDisplayName);
  if (!source && !target) return null;
  const verb = /supersedence/i.test(String(payload['@odata.type'] ?? '')) ? 'replaces' : 'needs';
  const [first, second] = payload.targetType === 'parent' ? [target, source] : [source, target];
  return `${first ?? UNNAMED_APP} ${verb} ${second ?? UNNAMED_APP}`;
}

/**
 * The object's own name, or null. `skip` drops values that are not names (the
 * portal skips values that hold an object id).
 * @param {unknown} payload
 * @param {string | null | undefined} resourceType
 * @param {{ skip?: (value: string) => boolean }} [options]
 * @returns {string | null}
 */
export function objectName(payload, resourceType, { skip = () => false } = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (RELATIONSHIP_KINDS.includes(resourceType)) return relationshipName(payload);
  for (const field of OWN_NAME_FIELDS[resourceType] ?? NAME_FIELDS) {
    const value = text(payload[field]);
    if (value && !skip(value)) return value;
  }
  return null;
}

const sqlText = (payload, field) => `NULLIF(btrim(${payload}->>'${field}'), '')`;
const coalesce = (payload, fields) => `COALESCE(${fields.map((field) => sqlText(payload, field)).join(', ')})`;

function relationshipSql(payload) {
  const source = sqlText(payload, 'sourceDisplayName');
  const target = sqlText(payload, 'targetDisplayName');
  const verb = `CASE WHEN ${payload}->>'@odata.type' ILIKE '%supersedence%' THEN ' replaces ' ELSE ' needs ' END`;
  const pair = (first, second) => `COALESCE(${first}, '${UNNAMED_APP}') || ${verb} || COALESCE(${second}, '${UNNAMED_APP}')`;
  return `CASE WHEN ${source} IS NULL AND ${target} IS NULL THEN NULL
    WHEN ${payload}->>'targetType' = 'parent' THEN ${pair(target, source)}
    ELSE ${pair(source, target)} END`;
}

/**
 * objectName as a SQL expression: `payload` is a jsonb expression (rv.payload) and
 * `type` the expression holding its kind (rv.resource_type).
 */
export function objectNameSql(payload, type) {
  const own = Object.entries(OWN_NAME_FIELDS).map(([kind, fields]) => `WHEN '${kind}' THEN ${coalesce(payload, fields)}`);
  const relationships = RELATIONSHIP_KINDS.map((kind) => `WHEN '${kind}' THEN ${relationshipSql(payload)}`);
  return `(CASE ${type} ${[...own, ...relationships].join(' ')} ELSE ${coalesce(payload, NAME_FIELDS)} END)`;
}
