/**
 * The live read gate for the Wave 2 cmdlet workloads and the admin REST workloads (Power
 * Platform): names, the workloads and their declared reads, and the record validator. Kept
 * apart from workloadReadsLive.mjs so tools/release/qualification.mjs can register the gate
 * without an import cycle.
 */
import { FAMILIES as EXCHANGE_EXTENDED } from '../../engine/collect/workloads/exchangeExtended.mjs';
import {
  DISTRIBUTION_GROUP_FAMILIES, EXCHANGE_DISTRIBUTION_GROUPS_WORKLOAD, EXCHANGE_RECIPIENTS_MODULE, EXCHANGE_RECIPIENTS_WORKLOAD, RECIPIENT_FAMILIES,
} from '../../engine/collect/workloads/exchangeRecipients.mjs';
import {
  ACCESS_FAMILIES, DEFAULTS_FAMILIES, EXCHANGE_ORG_ACCESS_WORKLOAD, EXCHANGE_ORG_DEFAULTS_WORKLOAD, EXCHANGE_ORG_POLICIES_MODULE,
} from '../../engine/collect/workloads/exchangeOrgPolicies.mjs';
import { EXCHANGE_ROLE_GROUPS_MODULE, FAMILIES as EXCHANGE_ROLE_GROUPS } from '../../engine/collect/workloads/exchangeRoleGroups.mjs';
import { FAMILIES as MAIL_FLOW } from '../../engine/collect/workloads/mailFlow.mjs';
import { FAMILIES as PURVIEW_EXTENDED } from '../../engine/collect/workloads/purviewExtended.mjs';
import { FAMILIES as RETENTION_DLP } from '../../engine/collect/workloads/purviewRetentionDlp.mjs';
import {
  COLLABORATION_FAMILIES, MEETING_SETTINGS_FAMILIES, TEAMS_COLLABORATION_MODULE, TEAMS_COLLABORATION_WORKLOAD, TEAMS_MEETING_SETTINGS_WORKLOAD,
} from '../../engine/collect/workloads/teamsCollaboration.mjs';
import { FAMILIES as TEAMS_EXTENDED } from '../../engine/collect/workloads/teamsExtended.mjs';
import { FAMILIES as TEAMS_POLICIES } from '../../engine/collect/workloads/teamsPolicies.mjs';
import {
  DEVICE_POLICY_FAMILIES, TEAMS_DEVICE_POLICIES_WORKLOAD, TEAMS_VOICE_NETWORK_MODULE, TEAMS_VOICE_NETWORK_WORKLOAD, VOICE_NETWORK_FAMILIES,
} from '../../engine/collect/workloads/teamsVoiceNetwork.mjs';
import { SHAREPOINT_WORKLOAD, SITE_SHARING_FAMILIES, SITE_SHARING_MODULE } from '../../engine/collect/workloads/sharepoint.mjs';
import {
  FAMILIES as SHAREPOINT_STRUCTURE, SHAREPOINT_STRUCTURE_MODULE, SHAREPOINT_STRUCTURE_WORKLOAD,
} from '../../engine/collect/workloads/sharepointStructure.mjs';
import { FAMILIES as POWER_PLATFORM, POWER_PLATFORM_WORKLOAD } from '../../engine/collect/workloads/powerPlatform.mjs';
import { WORKLOAD_DESCRIPTORS } from '../../engine/collect/workloadContract.mjs';
import { WRITTEN_WORKLOADS } from './workloadWritesAcceptance.mjs';

export const WORKLOAD_READS_LIVE_GATE = 'workload-reads-live-acceptance';
export const WORKLOAD_READS_LIVE_OPERATION = 'workload-reads';
export const WORKLOAD_READS_CREDENTIAL_MODE = 'collector-only';
export const WORKLOAD_READS_TRANSPORT = 'powershell-cmdlet-job';
// Admin REST workloads read through their own read-only transport (GETs of declared shapes only).
export const WORKLOAD_READS_REST_TRANSPORT = 'rest-read-only';

/** The record file for one workload, beside the other live acceptance records. */
export const workloadReadsRecordFile = (workload) => `workload-reads-${workload}-live-acceptance.json`;

/** Each workload's families, as its collector declares them. */
export const READ_FAMILIES = Object.freeze({
  'exchange-mail-flow': MAIL_FLOW,
  'exchange-extended': EXCHANGE_EXTENDED,
  'exchange-role-groups': EXCHANGE_ROLE_GROUPS,
  [EXCHANGE_DISTRIBUTION_GROUPS_WORKLOAD]: DISTRIBUTION_GROUP_FAMILIES,
  [EXCHANGE_RECIPIENTS_WORKLOAD]: RECIPIENT_FAMILIES,
  [EXCHANGE_ORG_ACCESS_WORKLOAD]: ACCESS_FAMILIES,
  [EXCHANGE_ORG_DEFAULTS_WORKLOAD]: DEFAULTS_FAMILIES,
  'teams-org-policies': TEAMS_POLICIES,
  'teams-voice-policies': TEAMS_EXTENDED,
  [TEAMS_VOICE_NETWORK_WORKLOAD]: VOICE_NETWORK_FAMILIES,
  [TEAMS_DEVICE_POLICIES_WORKLOAD]: DEVICE_POLICY_FAMILIES,
  [TEAMS_COLLABORATION_WORKLOAD]: COLLABORATION_FAMILIES,
  [TEAMS_MEETING_SETTINGS_WORKLOAD]: MEETING_SETTINGS_FAMILIES,
  'purview-retention-dlp': RETENTION_DLP,
  'purview-governance': PURVIEW_EXTENDED,
  // Not a written workload: only its per-site sharing read runs through PowerShell.
  [SHAREPOINT_WORKLOAD]: SITE_SHARING_FAMILIES,
  // Read only; its site templates need the sites a capture names (--site).
  [SHAREPOINT_STRUCTURE_WORKLOAD]: SHAREPOINT_STRUCTURE,
  // Admin REST, not PowerShell: see REST_WORKLOADS.
  [POWER_PLATFORM_WORKLOAD]: POWER_PLATFORM,
});

// Workloads read from an admin REST API rather than a PowerShell module. Their proof is bound
// to each read's declared API version (the version the ledger checks), not to a module version.
const REST_WORKLOADS = new Set([POWER_PLATFORM_WORKLOAD]);
export const isRestWorkload = (workload) => REST_WORKLOADS.has(workload);

/** How a workload's reads are sent: the bounded cmdlet job, or the workload's own REST transport. */
export const readTransport = (workload) => (isRestWorkload(workload) ? WORKLOAD_READS_REST_TRANSPORT : WORKLOAD_READS_TRANSPORT);

// Read-only workloads name their module here; a written workload's comes from its writes.
const READ_ONLY_MODULES = Object.freeze({
  [SHAREPOINT_WORKLOAD]: SITE_SHARING_MODULE, 'exchange-role-groups': EXCHANGE_ROLE_GROUPS_MODULE,
  [EXCHANGE_DISTRIBUTION_GROUPS_WORKLOAD]: EXCHANGE_RECIPIENTS_MODULE, [EXCHANGE_RECIPIENTS_WORKLOAD]: EXCHANGE_RECIPIENTS_MODULE,
  [TEAMS_COLLABORATION_WORKLOAD]: TEAMS_COLLABORATION_MODULE, [TEAMS_MEETING_SETTINGS_WORKLOAD]: TEAMS_COLLABORATION_MODULE,
  [SHAREPOINT_STRUCTURE_WORKLOAD]: SHAREPOINT_STRUCTURE_MODULE,
  [TEAMS_VOICE_NETWORK_WORKLOAD]: TEAMS_VOICE_NETWORK_MODULE, [TEAMS_DEVICE_POLICIES_WORKLOAD]: TEAMS_VOICE_NETWORK_MODULE,
  [EXCHANGE_ORG_ACCESS_WORKLOAD]: EXCHANGE_ORG_POLICIES_MODULE, [EXCHANGE_ORG_DEFAULTS_WORKLOAD]: EXCHANGE_ORG_POLICIES_MODULE,
});

/** The PowerShell module a workload's read capture runs in. */
export function readModule(workload) {
  return READ_ONLY_MODULES[workload] ?? WRITTEN_WORKLOADS[workload]?.module ?? null;
}

const MODULE_VERSION_RE = /^\d+\.\d+\.\d+(\.\d+)?$/;
const DESCRIPTORS = new Map(WORKLOAD_DESCRIPTORS.map((descriptor) => [descriptor.id, descriptor]));

/** The API version a REST read is declared at, which its proof must name; null for a cmdlet read. */
export function declaredRestVersion(operationId) {
  const operation = DESCRIPTORS.get(operationId)?.operation;
  return operation?.kind === 'rest' ? operation.version : null;
}

export function knownWorkload(workload) {
  if (!READ_FAMILIES[workload]) throw new Error(`--workload must be one of: ${Object.keys(READ_FAMILIES).join(', ')}`);
  return workload;
}

/**
 * The workload's reads, in the collector's order: [{ family, operationId, cmdlet }] for a
 * cmdlet workload, [{ family, operationId, request }] for a REST one.
 */
export function workloadReads(workload) {
  knownWorkload(workload);
  return Object.entries(READ_FAMILIES[workload]).map(([family, spec]) => {
    const operation = DESCRIPTORS.get(spec.operation)?.operation;
    return operation?.kind === 'rest'
      ? { family, operationId: spec.operation, request: `GET https://${operation.host}${operation.endpoint}` }
      : { family, operationId: spec.operation, cmdlet: spec.cmdlet };
  });
}

/** Offline: what a capture of `workload` would send. */
export function workloadReadsCapturePlan({ workload }) {
  return workloadReads(workload).map((read) => ({ credential: 'collector', ...read }));
}

/** The gate: a signed, live, collector-only record of this workload's declared reads. */
export function validateWorkloadReadsLiveSubject(evidence, { tenantRef, build, runner } = {}) {
  const failures = [];
  if (!runner?.ok) failures.push(`read capture runner proof required (${runner?.reason ?? 'not checked'})`);
  if (evidence.evidenceLevel === 'live-qualified' && (evidence.synthetic !== false || runner?.synthetic)) {
    failures.push('fixture evidence cannot claim live qualification');
  }
  if (!tenantRef || !build) failures.push('read capture expected tenant/build identity required');
  if (build && evidence.build !== build) failures.push(`build mismatch: evidence is '${evidence.build}', required '${build}'`);
  if (evidence.operation !== WORKLOAD_READS_LIVE_OPERATION) failures.push(`operation mismatch: expected '${WORKLOAD_READS_LIVE_OPERATION}'`);
  if (evidence.credentialMode !== WORKLOAD_READS_CREDENTIAL_MODE) failures.push(`credential mode must be '${WORKLOAD_READS_CREDENTIAL_MODE}'`);
  const subject = evidence.subject;
  if (!subject || typeof subject !== 'object') return [...failures, 'subject is missing'];
  if (!READ_FAMILIES[subject.workload]) return [...failures, `unknown workload '${subject.workload ?? 'missing'}'`];
  const rest = isRestWorkload(subject.workload);
  const module = readModule(subject.workload);
  const execution = subject.execution ?? {};
  if (rest) {
    if (execution.transport !== WORKLOAD_READS_REST_TRANSPORT || execution.module !== undefined || execution.moduleVersion !== undefined) {
      failures.push(`${subject.workload} reads run through its own ${WORKLOAD_READS_REST_TRANSPORT} transport, with no PowerShell module`);
    }
  } else {
    if (execution.transport !== WORKLOAD_READS_TRANSPORT || execution.module !== module) {
      failures.push(`cmdlets must run through the bounded ${WORKLOAD_READS_TRANSPORT} transport (${module})`);
    }
    if (typeof execution.moduleVersion !== 'string' || !MODULE_VERSION_RE.test(execution.moduleVersion)) failures.push(`no ${module} module version recorded`);
  }
  if (typeof subject.credentials?.collector !== 'string' || !subject.credentials.collector.trim()) failures.push('no collector credential reference');
  if (Object.keys(subject.credentials ?? {}).some((role) => role !== 'collector')) failures.push('a read capture uses the collector credential only');
  const declared = new Map(workloadReads(subject.workload).map((item) => [item.operationId, item]));
  if (!Array.isArray(subject.reads)) return [...failures, 'the record lists no reads'];
  for (const item of subject.reads) {
    if (!declared.has(item?.operationId) || !DESCRIPTORS.has(item.operationId)) failures.push(`${item?.operationId ?? 'an unnamed read'} is not a declared ${subject.workload} read`);
    else if (declared.get(item.operationId).family !== item.family) failures.push(`${item.operationId} is not read by the ${item.family} family`);
    const version = rest ? declaredRestVersion(item?.operationId) : execution.moduleVersion;
    if (item?.ok === true && (item.status !== 'read' || item.version !== version || item.synthetic !== false)) {
      failures.push(`${item?.operationId}: a read counts only when it answered in full, live, at the ${rest ? 'declared API' : 'recorded module'} version`);
    }
  }
  return failures;
}

/** The reads a verified record proves: one per read that answered. */
export function provenReads(subject) {
  return (subject?.reads ?? []).filter((item) => item.ok === true && item.status === 'read');
}

