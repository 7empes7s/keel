import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";

import { CONSTANT_KEY_TYPES, ID_KEY_TYPES } from "../../engine/cir/naturalKey.mjs";
import { objectName, OWN_NAME_FIELDS, RELATIONSHIP_KINDS } from "../../engine/cir/objectName.mjs";
import { createIsolatedTestDatabase } from "../../engine/test/dbTestHelper.mjs";
import { schemaSql } from "../../engine/store/loadSchema.mjs";
import { CATALOG } from "../../tools/tenant-probe/catalog.mjs";

import { DERIVED_NAME_TYPES, derivedName, type IdNames, referencedIds } from "@/lib/app-names";
import { changeLabel } from "@/lib/changes-view";
import { holdsObjectId, namedSubject } from "@/lib/job-names";
import { resourceLabel } from "@/lib/presentation";
import { savedNames } from "@/lib/saved-names";

// No setting reads "Unnamed …". Every kind Keel backs up is named one of five ways,
// and this file is the audit of which: a new kind fails the first test until it is
// placed in one of them (and, when it carries no name of its own, given a rule in
// lib/app-names.ts with a fixture below).

// Kinds whose saved copy carries displayName, name or another field the name
// lookups read (lib/saved-names.ts NAME_FIELDS).
const NAMED_BY_FIELD = new Set([
  "organization", "directorySettingTemplate", "groupSetting", "user", "group", "administrativeUnit", "contact",
  "application", "servicePrincipal", "identityProvider", "directoryRole", "roleDefinition", "directoryRoleTemplate",
  "unifiedRoleManagementPolicy", "conditionalAccessPolicy", "authenticationStrengthPolicy", "namedLocation",
  "authenticationContextClassReference", "authenticationMethodsPolicy", "authorizationPolicy", "crossTenantAccessPolicy",
  "permissionGrantPolicy", "activityBasedTimeoutPolicy", "claimsMappingPolicy", "homeRealmDiscoveryPolicy",
  "tokenIssuancePolicy", "tokenLifetimePolicy", "featureRolloutPolicy", "accessReviewScheduleDefinition", "accessPackage",
  "connectedOrganization", "deviceConfiguration", "deviceCompliancePolicy", "configurationPolicy",
  "deviceEnrollmentConfiguration", "deviceManagementRoleDefinition", "deviceCategory", "termsAndConditions",
  "windowsAutopilotDeploymentProfile", "deviceManagementIntent", "mobileApp", "managedAppPolicy",
  "targetedManagedAppConfiguration", "mobileAppConfiguration", "lifecycleWorkflow", "lifecycleWorkflowCustomTaskExtension",
  "customSecurityAttributeDefinition", "accessPackageCatalog", "accessPackageAssignmentPolicy", "agreement",
  "appManagementPolicy", "identityApiConnector", "deviceManagementScript", "deviceShellScript", "deviceHealthScript",
  "deviceComplianceScript", "assignmentFilter", "roleScopeTag", "windowsFeatureUpdateProfile", "windowsQualityUpdateProfile",
  "windowsDriverUpdateProfile", "groupPolicyConfiguration", "groupPolicyUploadedDefinitionFile",
  "notificationMessageTemplate", "deviceManagementRoleAssignment", "deviceManagementPartner", "complianceManagementPartner",
  "remoteAssistancePartner", "mobileAppCategory", "customAuthenticationExtension", "deviceManagementCompliancePolicy",
  "deviceManagementReusablePolicySetting", "policySet", "managedDeviceCleanupRule", "windowsQualityUpdatePolicy",
  "operationApprovalPolicy", "deviceCustomAttributeShellScript", "b2bManagementPolicy", "servicePrincipalCreationPolicy",
  "identityUserFlowAttribute", "externalDomainFederation", "exchangeRoleDefinition", "exchangeCustomAppScope",
  "defenderRoleDefinition", "defenderCustomAppScope", "androidDeviceOwnerEnrollmentProfile",
  "androidForWorkEnrollmentProfile", "appleUserInitiatedEnrollmentProfile", "deviceManagementDerivedCredentialSettings",
  "microsoftTunnelConfiguration", "iosLobAppProvisioningConfiguration", "managedEBook", "managedEBookCategory",
  "cartToClassAssociation", "windowsManagedAppProtection", "userExperienceAnalyticsBaseline", "externalConnection",
  "simulationAutomation", "attackSimulation", "hardwareConfiguration", "certificateBasedApplicationConfiguration",
  "verifiedIdProfile", "externalOriginResourceConnector", "roleManagementCustomExtension", "securityZone",
]);

// Kinds keyed by a value that reads as a name: a domain, a licence's part number, an
// attribute set or user flow its admin named.
const NAMED_BY_KEY: Record<string, string> = {
  domain: "contoso.example",
  subscribedSku: "SPE_E5",
  attributeSet: "Engineering",
  b2xIdentityUserFlow: "B2X_1_PartnerSignUp",
  sharedEmailDomain: "contoso.example",
  schemaExtension: "contoso_employeeBadge",
};

// Kinds named by a field other than displayName (engine/cir/objectName.mjs), each with
// a saved copy in the shape Graph returns and the name it reads by.
const OWN_FIELD_FIXTURES: Record<string, { payload: Record<string, unknown>; name: string }> = {
  intuneBrandingProfile: { payload: { profileName: "Sales devices", displayName: "Contoso IT" }, name: "Sales devices" },
  groupPolicyUploadedDefinitionFile: { payload: { fileName: "chrome.admx" }, name: "chrome.admx" },
  mobileAppRelationship: { payload: { sourceDisplayName: "Company Portal", targetDisplayName: "Authenticator", targetType: "child" }, name: "Company Portal needs Authenticator" },
  managedDevice: { payload: { deviceName: "KEEL-RT-LAPTOP-01" }, name: "KEEL-RT-LAPTOP-01" },
  windowsAutopilotDeviceIdentity: { payload: { displayName: "", serialNumber: "PF3ABC12" }, name: "PF3ABC12" },
  deviceManagementExchangeConnector: { payload: { serverName: "outlook.office365.com" }, name: "outlook.office365.com" },
  vppToken: { payload: { organizationName: "Contoso Ltd", appleId: "vpp@contoso.example" }, name: "Contoso Ltd" },
  depOnboardingSetting: { payload: { tokenName: "Contoso DEP" }, name: "Contoso DEP" },
  enterpriseCodeSigningCertificate: { payload: { subjectName: "CN=Contoso Code Signing" }, name: "CN=Contoso Code Signing" },
};
const NAMED_BY_OWN_FIELD = new Set<string>([...Object.keys(OWN_NAME_FIELDS), ...RELATIONSHIP_KINDS]);

const DERIVED = new Set<string>(DERIVED_NAME_TYPES);

const id = (n: number) => `7c1e0000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ADA = id(1);
const HELPDESK = id(2);
const KEEL_APP = id(3);
const GLOBAL_ADMIN = "62e90394-69f5-4237-9190-012177145e10";
const EXO_ROLE = id(4);
const DEFENDER_ROLE = id(5);
const PARIS_AU = id(6);
const MAIL_SCOPE = id(7);
const PACKAGE = id(8);
const PARTNER_TENANT = id(9);
const ROLE_GROUP_ID = id(10);
const CATALOG_ROLE = id(11);
const PIM_GROUP = id(12);
const KEEL_APP_ID = id(13);

const NAMES: IdNames = {
  ids: {
    [ADA]: "Ada Lovelace", [HELPDESK]: "Helpdesk", [KEEL_APP]: "Keel Restorer", [KEEL_APP_ID]: "Keel Restorer",
    [GLOBAL_ADMIN]: "Global Administrator", [EXO_ROLE]: "Mail Recipients", [DEFENDER_ROLE]: "Security Operator",
    [PARIS_AU]: "Paris office", [MAIL_SCOPE]: "Finance mailboxes", [PACKAGE]: "Sales access",
    [PARTNER_TENANT]: "Fabrikam", [CATALOG_ROLE]: "Catalog owner", [PIM_GROUP]: "Tier 0 admins",
  },
  roles: {},
};

// One saved copy per kind with no name of its own, in the shape Graph returns, and
// the name it reads by.
const FIXTURES: Record<string, { key: string; payload: Record<string, unknown>; name: string }> = {
  oauth2PermissionGrant: {
    key: "l5eW7x0ga0-WDOntXzHateQDNpSH5-lPk9HjD3Sarjk",
    payload: { clientId: KEEL_APP, resourceId: KEEL_APP, consentType: "AllPrincipals" },
    name: "Keel Restorer to Keel Restorer",
  },
  appRoleGrant: { key: `edge:appRoleGrant:${KEEL_APP}:${KEEL_APP}:${id(99)}`, payload: {}, name: "Keel Restorer can use Keel Restorer" },
  applicationOwnership: { key: `edge:appOwner:${KEEL_APP}:${ADA}`, payload: {}, name: "Ada Lovelace as owner of Keel Restorer" },
  servicePrincipalOwnership: { key: `edge:servicePrincipalOwner:${KEEL_APP}:${ADA}`, payload: {}, name: "Ada Lovelace as owner of Keel Restorer" },
  synchronizationJob: {
    key: "AD2AADProvisioning.6f3c2b1a9d8e4f7081726354a5b6c7d8.0a1b2c3d4e5f60718293a4b5c6d7e8f9",
    payload: { servicePrincipalId: KEEL_APP }, name: "Keel Restorer provisioning",
  },
  sharepointSiteAppGrant: { key: `sharepoint:site-app-grant:site-1:${KEEL_APP_ID}`, payload: { applications: [{ id: KEEL_APP_ID }] }, name: "Keel Restorer" },
  roleAssignment: {
    key: `roleAssignment:unknown:${GLOBAL_ADMIN}@unknown:${ADA}@/`,
    payload: { id: id(20), roleDefinitionId: GLOBAL_ADMIN, principalId: ADA, directoryScopeId: "/" },
    name: "Global Administrator → Ada Lovelace",
  },
  roleAssignmentSchedule: {
    key: id(21),
    payload: { id: id(21), roleDefinitionId: GLOBAL_ADMIN, principalId: HELPDESK, directoryScopeId: `/administrativeUnits/${PARIS_AU}`, appScopeId: null },
    name: "Global Administrator → Helpdesk (scope: Paris office)",
  },
  roleEligibilitySchedule: {
    key: id(22),
    payload: { id: id(22), roleDefinitionId: GLOBAL_ADMIN, principalId: ADA, directoryScopeId: "/" },
    name: "Global Administrator → Ada Lovelace",
  },
  exchangeRoleAssignment: {
    key: id(23),
    payload: { id: id(23), roleDefinitionId: EXO_ROLE, principalId: "/RoleGroups/Organization Management", directoryScopeId: "/", appScopeId: null },
    name: "Mail Recipients → Organization Management",
  },
  defenderRoleAssignment: {
    key: id(24),
    payload: { id: id(24), roleDefinitionId: DEFENDER_ROLE, principalIds: [ADA, HELPDESK], appScopeIds: [] },
    name: "Security Operator → Ada Lovelace, Helpdesk",
  },
  entitlementManagementRoleAssignment: {
    key: id(25),
    payload: { id: id(25), roleDefinitionId: CATALOG_ROLE, principalId: ADA, appScopeId: `/AccessPackageCatalog/${id(26)}` },
    name: "Catalog owner → Ada Lovelace (scope: part of the tenant)",
  },
  unifiedRoleManagementPolicyAssignment: {
    key: id(27),
    payload: { id: id(27), policyId: id(28), roleDefinitionId: GLOBAL_ADMIN, scopeId: "/", scopeType: "DirectoryRole" },
    name: "Activation settings for Global Administrator",
  },
  accessPackageAssignment: {
    key: id(29),
    payload: { id: id(29), target: { objectId: ADA, displayName: "Ada Lovelace" }, accessPackage: { id: PACKAGE, displayName: "Sales access" } },
    name: "Ada Lovelace → Sales access",
  },
  accessPackageResourceRoleScope: {
    key: id(30),
    payload: { id: id(30), accessPackageId: PACKAGE, role: { displayName: "Member", originSystem: "AadGroup" }, scope: { displayName: "Root" } },
    name: "Member in Sales access",
  },
  crossTenantAccessPolicyPartner: { key: PARTNER_TENANT, payload: { tenantId: PARTNER_TENANT, inboundTrust: null }, name: "Fabrikam" },
  crossTenantIdentitySyncPolicyPartner: { key: PARTNER_TENANT, payload: { tenantId: PARTNER_TENANT }, name: "Fabrikam" },
  authenticationEventListener: {
    key: id(31),
    payload: {
      "@odata.type": "#microsoft.graph.onTokenIssuanceStartListener",
      conditions: { applications: { includeApplications: [{ appId: KEEL_APP_ID }] } },
    },
    name: "Token issuance start for Keel Restorer",
  },
  groupLifecyclePolicy: { key: id(32), payload: { id: id(32), groupLifetimeInDays: 180, managedGroupTypes: "Selected" }, name: "Groups expire after 180 days (selected groups)" },
  organizationalBrandingLocalization: { key: "fr-FR", payload: { id: "fr-FR", signInPageText: "Bonjour" }, name: "Language fr-FR" },
  permissionGrantPreApprovalPolicy: {
    key: id(33), payload: { id: id(33), conditions: [{ scopeType: "group", sensitivityLabels: {} }] }, name: "Pre-approved permissions for group",
  },
  mobileThreatDefenseConnector: { key: id(34), payload: { id: id(34), partnerState: "enabled" }, name: "Mobile threat defense connector (enabled)" },
  microsoftTunnelHealthThreshold: { key: "cpuUsage", payload: { id: "cpuUsage", healthyThreshold: 50 }, name: "Tunnel health: cpu usage" },
  deviceTemplate: { key: id(42), payload: { id: id(42), manufacturer: "Contoso", model: "Sensor 2" }, name: "Contoso Sensor 2" },
  signInIdentifier: { key: id(43), payload: { id: "email", isEnabled: true }, name: "Email" },
  crossTenantM365Capability: { key: id(44), payload: { id: "calendarSharing" }, name: "Calendar sharing" },
  lifecyclePolicy: { key: id(45), payload: { id: id(45), "@odata.type": "#microsoft.graph.inactiveUsersPolicy" }, name: "Inactive users policy" },
  privilegedAccessGroupResource: { key: PIM_GROUP, payload: { id: PIM_GROUP }, name: "Tier 0 admins" },
};

const catalogKinds = [...new Set((CATALOG as { type: string }[]).map((entry) => entry.type))];
const constantKinds = CONSTANT_KEY_TYPES as Set<string>;

test("every kind Keel backs up has a way to be named", () => {
  const unplaced = catalogKinds.filter((type) => !constantKinds.has(type) && !NAMED_BY_FIELD.has(type)
    && !(type in NAMED_BY_KEY) && !DERIVED.has(type) && !NAMED_BY_OWN_FIELD.has(type));
  assert.deepEqual(unplaced, [], "place each new kind in NAMED_BY_FIELD, NAMED_BY_KEY, engine/cir/objectName.mjs or lib/app-names.ts");
  // A kind keyed by its Graph id (or by ids, like a role assignment) shows that id
  // when nothing else names it, so it must carry a name field or have a rule.
  const idKeyed = [...(ID_KEY_TYPES as Set<string>), "roleAssignment", "crossTenantAccessPolicyPartner"];
  const bare = idKeyed.filter((type) => !NAMED_BY_FIELD.has(type) && !DERIVED.has(type) && !(type in NAMED_BY_KEY) && !NAMED_BY_OWN_FIELD.has(type));
  assert.deepEqual(bare, []);
});

test("every kind named by another field reads by it", () => {
  assert.deepEqual([...NAMED_BY_OWN_FIELD].filter((type) => !OWN_FIELD_FIXTURES[type]), [], "add a fixture for each kind in objectName.mjs");
  for (const [type, fixture] of Object.entries(OWN_FIELD_FIXTURES)) {
    assert.equal(objectName(fixture.payload, type), fixture.name, type);
    assert.equal(DERIVED.has(type), false, `${type}: named in objectName.mjs, so it needs no rule in lib/app-names.ts`);
  }
});

test("every kind with no name of its own reads by a name built from its fields", () => {
  const missing = [...DERIVED].filter((type) => !FIXTURES[type]);
  assert.deepEqual(missing, [], "add a fixture for each named kind");
  for (const [type, fixture] of Object.entries(FIXTURES)) {
    const name = derivedName(type, fixture.key, fixture.payload, NAMES);
    assert.equal(name, fixture.name, type);
    const names = { [fixture.key]: { name, resourceType: type } };
    for (const label of [namedSubject(fixture.key, names, type), changeLabel({ naturalKey: fixture.key, resourceType: type, name }), resourceLabel(`${type}:${fixture.key}`, name)]) {
      assert.equal(label.includes("Unnamed"), false, `${type}: ${label}`);
      assert.equal(holdsObjectId(label), false, `${type}: ${label}`);
    }
  }
});

test("a role assignment names who and what even when one side is not backed up", () => {
  const exo = FIXTURES.exchangeRoleAssignment.payload;
  assert.equal(derivedName("exchangeRoleAssignment", "k", { ...exo, principalId: `/RoleGroups/${ROLE_GROUP_ID}` }, NAMES), "Mail Recipients → an Exchange role group");
  assert.equal(derivedName("exchangeRoleAssignment", "k", { ...exo, principalId: `/ServicePrincipals/${KEEL_APP}`, appScopeId: MAIL_SCOPE }, NAMES),
    "Mail Recipients → Keel Restorer (scope: Finance mailboxes)");
  assert.equal(derivedName("roleAssignment", "k", { roleDefinitionId: id(98), principalId: ADA, directoryScopeId: "/" }, NAMES),
    "an admin role Keel has no name for → Ada Lovelace");
  // Nothing it points to is known: no name rather than one made of placeholders.
  assert.equal(derivedName("roleAssignment", "k", { roleDefinitionId: id(98), principalId: id(97) }, NAMES), null);
  assert.deepEqual(referencedIds("exchangeRoleAssignment", "k", { ...exo, principalId: `/ServicePrincipals/${KEEL_APP}`, appScopeId: MAIL_SCOPE }).ids,
    [EXO_ROLE, KEEL_APP, MAIL_SCOPE]);
});

test("kinds keyed by their own name, or held once per tenant, read by it", () => {
  for (const [type, key] of Object.entries(NAMED_BY_KEY)) {
    const label = namedSubject(`${type}:${key}`, {}, type);
    assert.equal(label.includes("Unnamed"), false, `${type}: ${label}`);
  }
  for (const type of catalogKinds.filter((entry) => constantKinds.has(entry))) {
    const label = resourceLabel(type);
    assert.equal(label.includes("Unnamed"), false, `${type}: ${label}`);
  }
});

interface TestClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

const TENANT = "unnamed-kinds-test";
const ROWS: { key: string; type: string; payload: Record<string, unknown> }[] = [
  { key: "ada@contoso.example", type: "user", payload: { id: ADA, displayName: "Ada Lovelace" } },
  { key: "helpdesk", type: "group", payload: { id: HELPDESK, displayName: "Helpdesk" } },
  { key: id(50), type: "servicePrincipal", payload: { id: KEEL_APP, appId: KEEL_APP_ID, displayName: "Keel Restorer" } },
  // A built-in role is matched by its template id.
  { key: GLOBAL_ADMIN, type: "roleDefinition", payload: { id: id(51), templateId: GLOBAL_ADMIN, displayName: "Global Administrator" } },
  { key: EXO_ROLE, type: "exchangeRoleDefinition", payload: { id: EXO_ROLE, displayName: "Mail Recipients", isBuiltIn: true } },
  { key: MAIL_SCOPE, type: "exchangeCustomAppScope", payload: { id: MAIL_SCOPE, displayName: "Finance mailboxes" } },
  { key: "Paris office", type: "administrativeUnit", payload: { id: PARIS_AU, displayName: "Paris office" } },
  { key: `${PARTNER_TENANT}`, type: "crossTenantIdentitySyncPolicyPartner", payload: { tenantId: PARTNER_TENANT, displayName: "Fabrikam" } },
  { key: id(23), type: "exchangeRoleAssignment", payload: { id: id(23), roleDefinitionId: EXO_ROLE, principalId: `/ServicePrincipals/${KEEL_APP}`, appScopeId: MAIL_SCOPE } },
  { key: id(21), type: "roleAssignmentSchedule", payload: FIXTURES.roleAssignmentSchedule.payload },
  { key: `roleAssignment:unknown:${GLOBAL_ADMIN}@unknown:${ADA}@/`, type: "roleAssignment", payload: FIXTURES.roleAssignment.payload },
  { key: `partner:${PARTNER_TENANT}`, type: "crossTenantAccessPolicyPartner", payload: { tenantId: PARTNER_TENANT } },
];

let database: { url: string; connect(): Promise<TestClient>; cleanup(): Promise<void> };
let client: TestClient;

before(async () => {
  if (!process.env.KEEL_DB_TEST_URL) {
    const env = readFileSync("/etc/keel/db.env", "utf8");
    for (const line of env.split("\n")) {
      const match = /^KEEL_DB_TEST_URL=(.*)$/.exec(line.trim());
      if (match) process.env.KEEL_DB_TEST_URL = match[1];
    }
  }
  database = (await createIsolatedTestDatabase(import.meta.url)) as typeof database;
  const admin = await database.connect();
  try {
    await admin.query(schemaSql());
  } finally {
    await admin.end();
  }
  client = await database.connect();
  const { rows } = await client.query(
    "INSERT INTO snapshot (tenant_ref, status, started_at, completed_at) VALUES ($1, 'complete', $2, $2) RETURNING id",
    [TENANT, "2026-10-22T01:00:00Z"],
  );
  for (const row of ROWS) {
    await client.query(
      `INSERT INTO resource_version (snapshot_id, natural_key, resource_type, payload, payload_hash, criticality, blast_radius, fidelity, provenance)
       VALUES ($1, $2, $3, $4, $5, 'critical', 'access-affecting', 'full', '{}')`,
      [rows[0].id, row.key, row.type, JSON.stringify(row.payload), JSON.stringify(row.payload)],
    );
  }
});

after(async () => {
  await client?.end();
  await database?.cleanup();
});

test("saved role assignments and partners read by the names their backup holds", async () => {
  const keys = [id(23), id(21), `roleAssignment:unknown:${GLOBAL_ADMIN}@unknown:${ADA}@/`, `partner:${PARTNER_TENANT}`];
  const names = await savedNames(client, TENANT, keys);
  const labels = keys.map((key) => namedSubject(key, names));
  assert.deepEqual(labels, [
    "Mail Recipients → Keel Restorer (scope: Finance mailboxes) (Exchange role assignment)",
    "Global Administrator → Helpdesk (scope: Paris office) (role assignment schedule)",
    "Global Administrator → Ada Lovelace (role assignment)",
    "Fabrikam (cross-tenant access partner)",
  ]);
});

test("an Exchange role assignment names its role group from the newest usable role group read", async () => {
  const read = async (outcome: string, at: string, name: string | null) => {
    const { rows: [run] } = await client.query(
      `INSERT INTO workload_collection (tenant_ref, workload, outcome, observed_from, observed_to, digest)
       VALUES ($1, 'exchange-role-groups', $2, $3, $3, '{}') RETURNING id`,
      [TENANT, outcome, at],
    );
    if (name) {
      await client.query(
        `INSERT INTO workload_observation (collection_id, resource_key, fields, field_coverage) VALUES ($1, $2, $3, '{}')`,
        [run.id, `role-group:${ROLE_GROUP_ID}`, JSON.stringify({ identity: ROLE_GROUP_ID, kind: "roleGroup", Name: name, ExchangeObjectId: ROLE_GROUP_ID })],
      );
    }
  };
  await read("complete", "2026-10-21T01:00:00Z", "Old name");
  await read("complete", "2026-10-22T01:00:00Z", "Recipient Management");
  // A later run that read nothing does not hide the last good read.
  await read("disabled", "2026-10-22T02:00:00Z", null);
  // Nor does a partial run whose read answered no groups at all.
  await read("partial", "2026-10-22T03:00:00Z", null);
  const { rows: [snapshot] } = await client.query("SELECT id FROM snapshot WHERE tenant_ref = $1", [TENANT]);
  const payload = { id: id(24), roleDefinitionId: EXO_ROLE, principalId: `/RoleGroups/${ROLE_GROUP_ID}`, directoryScopeId: "/" };
  await client.query(
    `INSERT INTO resource_version (snapshot_id, natural_key, resource_type, payload, payload_hash, criticality, blast_radius, fidelity, provenance)
     VALUES ($1, $2, 'exchangeRoleAssignment', $3, $4, 'critical', 'access-affecting', 'full', '{}')`,
    [snapshot.id, id(24), JSON.stringify(payload), JSON.stringify(payload)],
  );
  const names = await savedNames(client, TENANT, [id(24)]);
  assert.equal(namedSubject(id(24), names), "Mail Recipients → Recipient Management (Exchange role assignment)");
});
