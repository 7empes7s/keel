#!/usr/bin/env node
/**
 * Issue #148: the Entra live-gate checklist, derived at run time.
 *
 *   node tools/qualification/live-gate-plan.mjs              # Markdown checklist for the operator
 *   node tools/qualification/live-gate-plan.mjs --json       # the same plan as JSON
 *   node tools/qualification/live-gate-plan.mjs --summary    # one line per step
 *
 * The list of operations is NEVER hand-kept. It is every row of the operation
 * ledger (engine/coverage/qualification.mjs buildOperationLedger) whose
 * decision is 'supported', plus every supported relationship edge row. A newly
 * registered write (capabilities.mjs) appears here with no edit to this file.
 *
 * What IS kept here is per-type guidance: which disposable fixture to use, which
 * reviewed field to drift and the break-glass precondition. A registered type
 * with no guidance still gets a full step, built from generic text and from the
 * catalogue's blast radius. A type whose blast radius is 'tenant-lockout' and
 * that has no guidance is treated as lockout-sensitive, so it runs last and
 * names the break-glass precondition until someone reviews it.
 *
 * Order: everything that is not lockout-sensitive first (by catalogue blast
 * radius, then batch, then type, then operation); then the lockout-sensitive
 * types (authorization policy, PIM rules, authentication methods, security
 * defaults, Conditional Access, then the Conditional Access enforcement step).
 *
 * Nothing here contacts a tenant. It prints commands for the operator to run on
 * the test tenant, and every command names the test-tenant precondition.
 */
import { pathToFileURL } from 'node:url';

import { CATALOG } from '../tenant-probe/catalog.mjs';
import { CONSTANT_KEY_TYPES, ID_KEY_TYPES } from '../../engine/cir/naturalKey.mjs';
import { buildExpansionInventory, buildOperationLedger } from '../../engine/coverage/qualification.mjs';
import { ENFORCEMENT_STEP } from '../../engine/restore/conditionalAccessEnforcement.mjs';
import { TENANT_POLICY_RECORDS } from '../../engine/restore/tenantPolicyOperations.mjs';

export const LIVE_GATE_PLAN_VERSION = 1;
export const LIVE_GATE_ISSUE = 148;
/** Where committed captures and demotion records go (one pair of files per operation). */
export const ENTRA_LIVE_EVIDENCE_DIR = 'docs/release/qualifications/entra-live';
export const FIXTURE_PREFIX = 'KEEL-RT-148';

const BLAST_RANK = Object.freeze({ cosmetic: 0, 'access-affecting': 1, 'tenant-lockout': 2 });
const OPERATION_RANK = Object.freeze({ create: 0, update: 1, 'restore-soft-deleted': 2, delete: 3, 'edge-add': 4, 'edge-remove': 5 });

const SINGLETON_TYPES = new Set([
  ...CONSTANT_KEY_TYPES,
  ...TENANT_POLICY_RECORDS.filter((entry) => !entry.route.includes('{')).map((entry) => entry.resourceType)
    .filter((type) => type !== 'crossTenantAccessPolicyPartner'),
]);
const TENANT_POLICY_LOCKOUT = new Set(TENANT_POLICY_RECORDS.filter((entry) => entry.lockout).map((entry) => entry.resourceType));

const BREAK_GLASS_COMMON = [
  'Run `node cli/keel-breakglass.mjs report --config "$COLLECTOR"`: every registered break-glass account must read ready. Stop if any is not, or if readiness is unknown.',
  'Marouane keeps a second, separate Global Administrator session signed in to the test tenant for the whole step, and is reachable to undo the change by hand.',
  'Never touch the break-glass accounts, the operator\'s admin account or the Global Reader account.',
];

/**
 * Reviewed per-type guidance. Keys are resource types (or edge capability
 * keys). `kind` is how the capture checks the fixture: 'named-object' (its name
 * starts KEEL-RT- or keel-rehearsal-), 'tenant-setting' (a tenant-wide object
 * that cannot be disposable; the capture needs --allow-tenant-setting) or
 * 'by-reference' (an object with no name of its own that only points at
 * fixtures; the capture needs --allow-by-reference).
 */
export const FIXTURE_GUIDANCE = Object.freeze({
  group: {
    kind: 'named-object', fixture: `security group ${FIXTURE_PREFIX}-group (mail nickname ${FIXTURE_PREFIX}-group), no members`,
    select: `${FIXTURE_PREFIX}-group`, drift: 'change its description',
  },
  'group#member': {
    kind: 'named-object', fixture: `group ${FIXTURE_PREFIX}-group and the existing fixture user keel-rt-20260908-carla as its member`,
    select: `${FIXTURE_PREFIX}-group`, add: 'remove carla from the group after the snapshot', remove: 'add carla to the group after the snapshot (the snapshot has no members)',
  },
  'group#owner': {
    kind: 'named-object', fixture: `group ${FIXTURE_PREFIX}-group and the existing fixture user keel-rt-20260908-carla as its owner`,
    select: `${FIXTURE_PREFIX}-group`, add: 'remove carla as owner after the snapshot', remove: 'add carla as owner after the snapshot (the snapshot has no owners)',
  },
  user: {
    kind: 'named-object', fixture: 'the existing cloud-only fixture user keel-rt-20260908-carla (never a synced user)',
    select: 'carla\'s user principal name', drift: 'change her department, and remove one directly assigned licence if she has one',
  },
  application: {
    kind: 'named-object', fixture: `app registration ${FIXTURE_PREFIX}-app with no secrets, certificates or API permissions`,
    select: `the appId of ${FIXTURE_PREFIX}-app`, drift: 'change its display name to end in -drifted',
    note: 'A recreated app gets a new appId; KEEL lists the credential completion items. Nothing consumes this app.',
  },
  servicePrincipal: {
    kind: 'named-object', fixture: `the enterprise application for ${FIXTURE_PREFIX}-app`,
    select: `the appId of ${FIXTURE_PREFIX}-app`,
    note: 'Create runs after the application create step: delete the enterprise application only, keep the app registration.',
  },
  administrativeUnit: {
    kind: 'named-object', fixture: `administrative unit ${FIXTURE_PREFIX}-unit with no members and no scoped roles`,
    select: `${FIXTURE_PREFIX}-unit`, drift: 'change its description',
  },
  groupSetting: {
    kind: 'tenant-setting', fixture: 'the tenant-wide Group.Unified directory setting',
    select: 'Group.Unified', drift: 'flip EnableGroupCreation and put nothing else back by hand',
    note: 'Delete removes the tenant-wide setting and the restore cannot recreate it (create is not registered); only run delete if decision D-148b allows it, and have its values written down to recreate by hand.',
  },
  roleDefinition: {
    kind: 'named-object', fixture: `custom role ${FIXTURE_PREFIX}-role with one permission (microsoft.directory/users/password/update), assigned to nobody`,
    select: `${FIXTURE_PREFIX}-role`, drift: 'remove its permission and add microsoft.directory/users/basic/update',
    note: 'Needs an Entra ID P1 or P2 licence in the test tenant.',
  },
  roleAssignment: {
    kind: 'by-reference', fixture: `${FIXTURE_PREFIX}-role assigned to keel-rt-20260908-carla at tenant scope`,
    select: 'the assignment key KEEL shows for carla and the fixture role', drift: 'none: update is checked by re-running restore over an unchanged assignment and is captured only if KEEL writes',
  },
  roleEligibilitySchedule: {
    kind: 'by-reference', fixture: `a time-bound PIM eligibility for keel-rt-20260908-carla to ${FIXTURE_PREFIX}-role, ending in 30 days`,
    select: 'the eligibility id KEEL shows for carla and the fixture role',
  },
  namedLocation: {
    kind: 'named-object', fixture: `IP named location ${FIXTURE_PREFIX}-location (203.0.113.0/24, not trusted), referenced by no policy`,
    select: `${FIXTURE_PREFIX}-location`, drift: 'add the range 198.51.100.0/24',
  },
  authenticationStrengthPolicy: {
    kind: 'named-object', fixture: `custom authentication strength ${FIXTURE_PREFIX}-strength (FIDO2 only), referenced by no policy`,
    select: `${FIXTURE_PREFIX}-strength`, drift: 'change its description',
  },
  crossTenantAccessPolicy: { kind: 'tenant-setting', fixture: 'the tenant cross-tenant access policy', select: 'crossTenantAccessPolicy', drift: 'none expected: allowedCloudEndpoints is usually empty; add one cloud only if decision D-148b allows it' },
  crossTenantAccessPolicyConfigurationDefault: {
    kind: 'tenant-setting', fixture: 'the tenant default cross-tenant settings', select: 'crossTenantAccessPolicyConfigurationDefault',
    drift: 'turn inbound trust of MFA from other tenants on or off',
  },
  crossTenantAccessPolicyPartner: {
    kind: 'tenant-setting', fixture: 'a partner entry for a Microsoft-owned tenant id Marouane chooses (decision D-148b)',
    select: 'the partner tenant id (pseudonymized in the evidence)', drift: 'turn its inbound MFA trust on or off',
    note: 'Graph refuses a tenantId that does not exist. Remove the partner entry afterwards.',
  },
  adminConsentRequestPolicy: {
    kind: 'tenant-setting', fixture: 'the tenant admin consent request policy', select: 'adminConsentRequestPolicy',
    drift: 'change requestDurationInDays',
  },
  deviceCompliancePolicy: {
    kind: 'named-object', fixture: `Windows compliance policy ${FIXTURE_PREFIX}-compliance, assigned to group ${FIXTURE_PREFIX}-group only`,
    select: `${FIXTURE_PREFIX}-compliance`, drift: 'lower its minimum password length',
  },
  deviceConfiguration: {
    kind: 'named-object', fixture: `Windows device restriction profile ${FIXTURE_PREFIX}-restrictions, assigned to group ${FIXTURE_PREFIX}-group only`,
    select: `${FIXTURE_PREFIX}-restrictions`, drift: 'block the camera',
  },
  configurationPolicy: {
    kind: 'named-object', fixture: `settings catalog policy ${FIXTURE_PREFIX}-settings (one Defender setting), assigned to group ${FIXTURE_PREFIX}-group only`,
    select: `${FIXTURE_PREFIX}-settings`, drift: 'switch its one setting off',
  },
  authorizationPolicy: {
    kind: 'tenant-setting', lockout: true, fixture: 'the tenant authorization policy', select: 'authorizationPolicy',
    drift: 'change allowInvitesFrom (guest invitations) only; never touch default user role permissions',
    breakGlass: 'The lockout gate must allow the write. Only guest invitation settings change, which no break-glass sign-in depends on.',
  },
  unifiedRoleManagementPolicy: {
    kind: 'tenant-setting', lockout: true, fixture: `the PIM settings policy of ${FIXTURE_PREFIX}-role (never a built-in role's policy)`,
    select: `the PIM policy id of ${FIXTURE_PREFIX}-role`, drift: 'turn off "require MFA on activation"; the restore turns it back on',
    breakGlass: 'No break-glass account is eligible for or assigned the fixture role. KEEL refuses any change that weakens protection.',
  },
  authenticationMethodsPolicy: {
    kind: 'tenant-setting', lockout: true, fixture: 'the tenant authentication methods policy',
    select: 'authenticationMethodsPolicy', drift: 'switch one method the break-glass accounts do not use (for example SMS) on or off; never FIDO2 or the methods they sign in with',
    breakGlass: 'The break-glass readiness report must name the methods each break-glass account signs in with, and none of them is the drifted method. The lockout gate checks readiness under the proposed policy.',
  },
  identitySecurityDefaultsEnforcementPolicy: {
    kind: 'tenant-setting', lockout: true, fixture: 'the tenant security defaults setting', select: 'identitySecurityDefaultsEnforcementPolicy',
    drift: 'only possible when the tenant has no Conditional Access policy turned on; otherwise Entra refuses the change. If so, report this step as blocked (not failed) and do not demote it',
    breakGlass: 'Security defaults force MFA registration for every account: confirm both break-glass accounts have a registered method before the write.',
  },
  conditionalAccessPolicy: {
    kind: 'named-object', lockout: true,
    fixture: `Conditional Access policy ${FIXTURE_PREFIX}-ca: report-only, block access, users = group ${FIXTURE_PREFIX}-ca-users (holding only keel-rt-20260908-carla), excluding every break-glass account, all cloud apps`,
    select: `${FIXTURE_PREFIX}-ca`, drift: 'change its display name to end in -drifted',
    breakGlass: 'The fixture policy targets only the fixture group and excludes every break-glass account. KEEL writes it report-only; the lockout gate must allow it.',
    restoreBefore: 'Turn the fixture policy on (it blocks only carla) BEFORE the snapshot, so the backup has it enabled; after the snapshot delete it (soft delete only). The restore brings it back report-only and leaves the "turn on" item the next step uses.',
  },
});

/** The supported ledger rows, plus edges: the only source of operations. */
export function registeredOperations({ ledger = buildOperationLedger() } = {}) {
  const rows = [
    ...ledger.types.flatMap((type) => type.operations),
    ...ledger.edges,
  ];
  return rows.filter((row) => row.decision === 'supported');
}

function batchOf(resourceType, inventory) {
  if (resourceType.includes('#')) return 'relationship';
  for (const batch of inventory.batches) {
    if (batch.types.some((entry) => entry.resourceType === resourceType)) return batch.id;
  }
  return 'unbatched';
}

function blastRadiusOf(resourceType) {
  const base = resourceType.split('#')[0];
  return CATALOG.find((entry) => entry.type === base)?.blastRadius ?? 'access-affecting';
}

/** The reviewed guidance for a type, or generic guidance derived from the catalogue. */
export function guidanceFor(resourceType) {
  const reviewed = FIXTURE_GUIDANCE[resourceType];
  if (reviewed) {
    const lockout = reviewed.lockout === true || TENANT_POLICY_LOCKOUT.has(resourceType);
    return { ...reviewed, lockout, reviewed: true };
  }
  const singleton = SINGLETON_TYPES.has(resourceType);
  const lockout = TENANT_POLICY_LOCKOUT.has(resourceType) || blastRadiusOf(resourceType) === 'tenant-lockout';
  return {
    reviewed: false,
    kind: singleton ? 'tenant-setting' : ID_KEY_TYPES.has(resourceType) ? 'by-reference' : 'named-object',
    lockout,
    fixture: singleton ? `the tenant's one ${resourceType} object` : `a disposable ${resourceType} named ${FIXTURE_PREFIX}-${resourceType}`,
    select: singleton ? resourceType : `${FIXTURE_PREFIX}-${resourceType}`,
    drift: 'change one field the restore writes (see the type\'s operation record)',
    breakGlass: lockout ? 'Not reviewed for this type yet: treat it as able to lock people out. Get decision D-148a extended to this type before running it.' : null,
    note: 'No reviewed guidance yet for this type: read its roadmap doc before running, and add an entry to FIXTURE_GUIDANCE.',
  };
}

const capture = (resourceType, operation, guidance, key) => {
  const flags = guidance.kind === 'tenant-setting' ? ' --allow-tenant-setting' : guidance.kind === 'by-reference' ? ' --allow-by-reference' : '';
  return `node tools/qualification/entraLive.mjs capture --restore-ref "$A" --resource-type '${resourceType}' --operation ${operation}`
    + ` --fixture '${key}' --target-config "$RESTORER" --build "$B" --out "$OUT"${flags}`;
};

/** The file name stem of one operation's evidence (an edge key's # becomes a dot). */
export const evidenceStem = (resourceType, operation) => `${resourceType.replace('#', '.')}.${operation}`;

function setupFor(resourceType, operation, guidance, key) {
  const restoreRun = [
    'node cli/keel-collect.mjs --config "$COLLECTOR"   # note the snapshot id as S',
    '# now change the tenant as in "Before the restore"',
    `node cli/keel-restore.mjs --snapshot-id "$S" --select '${key}' --collector-config "$COLLECTOR" --target-config "$RESTORER" --persist-artifact "$A" --requested-by keel-operator`,
    '# Marouane approves artifact A in the portal (Restore, review). The requester can never approve it.',
    'node cli/keel-restore.mjs --artifact "$A" --enforce',
  ];
  switch (operation) {
    case 'create':
      return {
        before: guidance.kind === 'tenant-setting'
          ? 'Remove the object (it is recreated from the snapshot).'
          : 'Delete the fixture, then permanently delete it from deleted items, so the restore has to create it.',
        commands: restoreRun,
        cleanup: guidance.kind === 'tenant-setting' ? 'Confirm the recreated object matches the value written down before the run.' : 'Keep the recreated fixture: the next steps use it. It is removed in the end-of-run cleanup.',
      };
    case 'update':
      return {
        before: `Drift the fixture: ${guidance.drift ?? 'change one field the restore writes'}.`,
        commands: restoreRun,
        cleanup: guidance.kind === 'tenant-setting' ? 'None: the restore put the original value back. Read it once to confirm.' : 'Keep the fixture for later steps, or delete it at the end of the run.',
      };
    case 'restore-soft-deleted':
      return {
        before: guidance.restoreBefore ?? 'Delete the fixture (soft delete only: it must stay in deleted items).',
        commands: restoreRun,
        cleanup: 'Keep the fixture for later steps, or delete it and permanently delete it from deleted items at the end.',
      };
    case 'delete':
      return {
        before: 'Take the snapshot BEFORE the fixture exists. Then create the fixture, so the snapshot says it should not exist.',
        commands: [
          'node cli/keel-collect.mjs --config "$COLLECTOR"   # snapshot S, taken before the fixture exists',
          'node cli/keel-baseline-create.mjs --snapshot-id "$S" --supersedes "$BASELINE" --set-by keel-operator --label live-gate-148',
          'node cli/keel-baseline-activate.mjs --baseline-id "$NEW_BASELINE" --config "$COLLECTOR"   # the version the line above printed',
          '# now create the fixture',
          'node cli/keel-drift.mjs detect --config "$COLLECTOR"',
          'node cli/keel-drift.mjs list --config "$COLLECTOR"   # note the drift id D for the fixture',
          'node cli/keel-remediate.mjs --drift-id "$D" --collector-config "$COLLECTOR" --target-config "$RESTORER"   # dry run; note its artifact id as A',
          '# Marouane approves artifact A in the portal (Restore, review).',
          'node cli/keel-restore.mjs --artifact "$A" --enforce',
        ],
        cleanup: 'Re-activate the baseline version that was active before (`node cli/keel-baseline-activate.mjs --baseline-id "$BASELINE"`). Permanently delete the fixture from deleted items if it is there.',
      };
    case 'edge-add':
      return {
        before: guidance.add ?? 'Remove the relationship after the snapshot.',
        commands: restoreRun,
        cleanup: 'Remove the fixture user from the group again.',
      };
    case 'edge-remove':
      return {
        before: guidance.remove ?? 'Add the relationship after the snapshot.',
        commands: restoreRun,
        cleanup: 'None: the restore removed it. Read the group once to confirm.',
      };
    default:
      return { before: 'No reviewed procedure for this operation.', commands: restoreRun, cleanup: 'Remove what the step created.' };
  }
}

function stepFor(row, inventory) {
  const { resourceType, operation } = row;
  const guidance = guidanceFor(resourceType);
  // A delete needs an object the snapshot does not have: a second fixture, so the
  // one the other steps use is never deleted.
  const separate = operation === 'delete' && guidance.kind === 'named-object';
  const select = separate ? `${guidance.select}-delete` : guidance.select;
  // A select that is a description, not a key, stays a placeholder the operator fills in.
  const key = /\s/.test(select) ? `<natural key: ${select}>` : select;
  const setup = setupFor(resourceType, operation, guidance, key);
  const stem = evidenceStem(resourceType, operation);
  return {
    id: `${resourceType}:${operation}`,
    resourceType,
    operation,
    batch: batchOf(resourceType, inventory),
    blastRadius: blastRadiusOf(resourceType),
    claim: row.claim,
    alreadyLive: row.claim === 'live-qualified',
    lockoutSensitive: guidance.lockout,
    reviewedGuidance: guidance.reviewed,
    fixtureKind: guidance.kind,
    testObject: separate ? `a second fixture like the one above (${guidance.fixture}), named ${guidance.select}-delete, created after the snapshot` : guidance.fixture,
    select,
    breakGlass: guidance.lockout ? [...BREAK_GLASS_COMMON, guidance.breakGlass ?? ''].filter(Boolean) : null,
    sharedRunAllowed: !guidance.lockout && operation !== 'delete',
    before: setup.before,
    commands: [...setup.commands, capture(resourceType, operation, guidance, key)],
    cleanup: setup.cleanup,
    evidence: [`$OUT/${stem}.json (the signed record)`, `$OUT/${stem}.capture.json (the pseudonymized journal entry it binds)`],
    promote: `node tools/qualification/entraLive.mjs promote --evidence "$OUT/${stem}.json"`,
    onFailure: `node tools/qualification/entraLive.mjs demote --resource-type '${resourceType}' --operation ${operation} --restore-ref "$A" --reason '<what failed, in plain words>' --out "$OUT"`,
    note: guidance.note ?? null,
  };
}

function enforcementStep() {
  const guidance = guidanceFor('conditionalAccessPolicy');
  return {
    id: `conditionalAccessPolicy:${ENFORCEMENT_STEP}`,
    resourceType: 'conditionalAccessPolicy',
    operation: ENFORCEMENT_STEP,
    batch: 'policy',
    blastRadius: 'tenant-lockout',
    claim: null,
    alreadyLive: false,
    lockoutSensitive: true,
    reviewedGuidance: true,
    fixtureKind: 'named-object',
    testObject: `${FIXTURE_PREFIX}-ca, restored report-only by the restore-soft-deleted step from a snapshot where it was turned on (for carla only)`,
    select: `${FIXTURE_PREFIX}-ca`,
    breakGlass: [...BREAK_GLASS_COMMON, guidance.breakGlass, 'This is the one step that turns a policy ON. It blocks only carla. The lockout gate runs at planning and again at execution.'],
    sharedRunAllowed: false,
    before: 'Run right after the Conditional Access restore-soft-deleted step, whose restore left an open "turn on" item for the policy.',
    commands: [
      `node cli/keel-restore.mjs --enforce-conditional-access "$A" --policy '${FIXTURE_PREFIX}-ca' --persist-artifact "$E" --requested-by keel-operator`,
      '# Marouane approves artifact E in the portal (Restore, review).',
      'node cli/keel-restore.mjs --artifact "$E" --enforce',
      `node tools/qualification/entraLive.mjs capture --restore-ref "$E" --resource-type conditionalAccessPolicy --operation ${ENFORCEMENT_STEP} --fixture '${FIXTURE_PREFIX}-ca' --target-config "$RESTORER" --build "$B" --out "$OUT"`,
    ],
    cleanup: `Delete ${FIXTURE_PREFIX}-ca and permanently delete it from deleted items. Confirm carla can sign in again.`,
    evidence: [`$OUT/conditionalAccessPolicy.${ENFORCEMENT_STEP}.json`, `$OUT/conditionalAccessPolicy.${ENFORCEMENT_STEP}.capture.json`],
    promote: null,
    promoteNote: 'Not a ledger row: turning a policy on is a separate approved step, not a registered capability. The capture is kept with the Conditional Access records as evidence; promote refuses it.',
    onFailure: `node tools/qualification/entraLive.mjs demote --resource-type conditionalAccessPolicy --operation ${ENFORCEMENT_STEP} --restore-ref "$E" --reason '<what failed>' --out "$OUT"`,
    note: 'If the write could not be confirmed, KEEL says "may be ON": turn the policy off by hand at once and report.',
  };
}

// Reviewed types run in FIXTURE_GUIDANCE order (dependencies first: the fixture
// group before the Intune policies assigned to it, the custom role before its
// assignments). An unreviewed type runs after the reviewed ones of its class;
// an unreviewed lockout-sensitive type runs just before Conditional Access.
const GUIDANCE_ORDER = Object.keys(FIXTURE_GUIDANCE);

function sortKey(step) {
  const reviewedIndex = GUIDANCE_ORDER.indexOf(step.resourceType);
  let rank = reviewedIndex;
  if (reviewedIndex < 0) rank = step.lockoutSensitive ? GUIDANCE_ORDER.indexOf('conditionalAccessPolicy') - 0.5 : 1000 + (BLAST_RANK[step.blastRadius] ?? 1);
  const operationRank = step.operation === ENFORCEMENT_STEP ? 2.5 : (OPERATION_RANK[step.operation] ?? 50);
  return [step.lockoutSensitive ? 1 : 0, rank, step.batch, step.resourceType, operationRank];
}

function compare(left, right) {
  const a = sortKey(left);
  const b = sortKey(right);
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] === b[i]) continue;
    return typeof a[i] === 'number' ? a[i] - b[i] : String(a[i]).localeCompare(String(b[i]));
  }
  return 0;
}

/** The full checklist, derived from the ledger now. */
export function buildLiveGatePlan({ ledger = buildOperationLedger(), inventory = buildExpansionInventory() } = {}) {
  const operations = registeredOperations({ ledger });
  const steps = operations.map((row) => stepFor(row, inventory));
  if (operations.some((row) => row.resourceType === 'conditionalAccessPolicy' && row.operation === 'restore-soft-deleted')) {
    steps.push(enforcementStep());
  }
  steps.sort(compare);
  return {
    version: LIVE_GATE_PLAN_VERSION,
    issue: LIVE_GATE_ISSUE,
    ledgerContractVersion: ledger.contractVersion,
    operationCount: operations.length,
    stepCount: steps.length,
    preconditions: [
      'Test tenant only. The capture tool refuses any tenant whose reference is not the test tenant\'s.',
      'Run from your own checkout at the deployed build B (`git -C /opt/keel-live rev-parse HEAD`), never in /opt/keel.',
      'KEEL_QUALIFICATION_HMAC_KEY is set in the environment (signs the records); never print it.',
      'Captures are pseudonymized (#138): no raw tenant id, object id or host leaves the host. The capture tool checks this and refuses otherwise.',
      'Fixtures are only KEEL-RT-* or keel-rehearsal-* objects, or the tenant-wide settings named in decision D-148b.',
    ],
    variables: {
      B: 'the deployed build', COLLECTOR: '/etc/keel/tenant.json', RESTORER: '/etc/keel/restorer.json',
      OUT: 'a fresh evidence directory, e.g. ~/keel-148/<B>', S: 'the snapshot id from keel-collect',
      A: 'a fresh dry-run artifact id (uuidgen) per restore', E: 'a fresh artifact id for the enforcement step',
      BASELINE: 'the id of the baseline active before the run (delete steps only)', NEW_BASELINE: 'the baseline version a delete step creates',
      D: 'a drift id (delete steps only)',
    },
    steps,
    finalCleanup: [
      `Delete every ${FIXTURE_PREFIX}-* object the run created or recreated, and permanently delete each from deleted items.`,
      'Put back any tenant-wide setting to the value written down before the run, and read it once.',
      'Re-activate the baseline that was active before the run, if a delete step changed it.',
      'Check the break-glass readiness report one last time.',
    ],
  };
}

export function renderMarkdown(plan) {
  const lines = [
    `# Live gate #${plan.issue}: Entra writes on the test tenant`,
    '',
    `Generated from the operation ledger: ${plan.operationCount} registered operations, ${plan.stepCount} steps. Do them in this order.`,
    '',
    '## Before you start',
    '',
    ...plan.preconditions.map((line) => `- ${line}`),
    '',
    '## Variables',
    '',
    ...Object.entries(plan.variables).map(([name, meaning]) => `- \`$${name}\`: ${meaning}`),
    '',
  ];
  plan.steps.forEach((step, index) => {
    lines.push(`## ${index + 1}. ${step.resourceType} ${step.operation}${step.lockoutSensitive ? ' (lockout-sensitive)' : ''}`, '');
    if (step.alreadyLive) lines.push('- Already live-qualified: recapture only if the record is older than 30 days.');
    if (!step.reviewedGuidance) lines.push('- **No reviewed guidance for this type yet.** Read its roadmap doc first.');
    lines.push(`- Test object: ${step.testObject}`);
    lines.push(`- Select: ${step.select}`);
    if (step.breakGlass) {
      lines.push('- Break-glass precondition:');
      for (const item of step.breakGlass) lines.push(`  - ${item}`);
    }
    lines.push(`- Before the restore: ${step.before}`);
    lines.push('- Commands:', '', '```sh', ...step.commands, '```', '');
    lines.push(`- Cleanup: ${step.cleanup}`);
    lines.push(`- Evidence: ${step.evidence.join('; ')}`);
    lines.push(step.promote ? `- Promote: \`${step.promote}\`` : `- Promote: none. ${step.promoteNote}`);
    lines.push(`- On failure: \`${step.onFailure}\``);
    if (step.note) lines.push(`- Note: ${step.note}`);
    lines.push('');
  });
  lines.push('## End of run', '', ...plan.finalCleanup.map((line) => `- ${line}`), '');
  return lines.join('\n');
}

export function main({ argv = process.argv.slice(2), out = console } = {}) {
  let plan;
  try {
    plan = buildLiveGatePlan();
  } catch (error) {
    out.error(error.message);
    return 1;
  }
  if (argv.includes('--json')) out.log(JSON.stringify(plan, null, 2));
  else if (argv.includes('--summary')) {
    out.log(`${plan.operationCount} registered operations, ${plan.stepCount} steps`);
    plan.steps.forEach((step, index) => out.log(`${String(index + 1).padStart(2)}. ${step.lockoutSensitive ? '[lockout] ' : ''}${step.resourceType} ${step.operation} (${step.claim ?? 'step'})`));
  } else out.log(renderMarkdown(plan));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
