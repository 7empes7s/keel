/**
 * Issue #1007: terms of use (agreement), with their files.
 *
 *  - create: a missing agreement is created with its settings and every file
 *    the backup holds (the default one and each language), in one POST, with
 *    the PDF bytes stored by hash beside the snapshot
 *    (engine/collect/agreementFiles.mjs, engine/store/agreementFiles.mjs).
 *    Bytes whose hash does not match the backup are never sent. Graph needs a
 *    file to create an agreement, so a backup without the default file's bytes
 *    (Graph returned none, it was too large, or the store lacks it) holds the
 *    create as a manual step; a missing language is a manual step.
 *  - update: Graph's update takes the display name and whether people must
 *    open the terms before accepting (agreement-update); a difference in the
 *    settings it only takes on create is a manual step. A language the live
 *    agreement lacks is added (agreement-post-files). A PDF that differs from
 *    the backup for a language the agreement has is a manual step: v1.0 has no
 *    route to add a new version of a file.
 *  - who accepted is never recreated: a recreated agreement asks everyone to
 *    accept again, and the dry run and the run say so.
 *  - a recreated agreement has a new id, so every Conditional Access policy
 *    that requires the backed-up one is listed (by name) for a person to point
 *    at the new one. Conditional Access is never written here.
 *  - delete is not registered. Every write sits behind the restore approval
 *    (approvalHeld.mjs, "changes access": an agreement decides who may sign in).
 *
 * Routes follow the Graph v1.0 references and are fixture-tested, not
 * live-qualified: those references list delegated permissions for these
 * routes, so the live capture also shows whether the Restorer's application
 * grant is accepted.
 */
import { sha256Hex } from '../collect/agreementFiles.mjs';
import { createdOnce, withApprovalGate } from './approvalHeld.mjs';
import { defineRecord, outcomeDetail, sameValue } from './recordWriter.mjs';

const AGREEMENTS = '/identityGovernance/termsOfUse/agreements';
const CA_POLICIES = '/identity/conditionalAccess/policies';
const PORTAL = 'the Entra admin center, under Identity Governance, Terms of use';
const CA_PORTAL = 'the Entra admin center, under Protection, Conditional Access';
const DOCS = 'https://learn.microsoft.com/en-us/graph/api';
const TYPE = 'agreement';

// What Graph's update takes (agreement-update); the rest is set on create only.
const UPDATABLE = Object.freeze(['displayName', 'isViewingBeforeAcceptanceRequired']);
const CREATE_ONLY = Object.freeze(['isPerDeviceAcceptanceRequired', 'userReacceptRequiredFrequency', 'termsExpiration', 'files']);
const FILE_FIELDS = Object.freeze(['fileName', 'displayName', 'language', 'isDefault', 'isMajorVersion']);
const SETTING_WORDS = Object.freeze({
  isPerDeviceAcceptanceRequired: 'whether people accept on every device',
  userReacceptRequiredFrequency: 'how often people must accept again',
  termsExpiration: 'when acceptances expire',
});

const lower = (value) => String(value ?? '').toLowerCase();
const list = (value) => (Array.isArray(value) ? value : []);
const step = (requirement, fields, description) => Object.freeze({ kind: 'manual-setting', requirement, fields: Object.freeze(fields), description });
const agreementPath = (id) => `${AGREEMENTS}/${encodeURIComponent(id)}`;
const fileLabel = (file) => `the ${file?.language ?? 'unnamed'} file "${file?.fileName ?? file?.displayName ?? 'unnamed'}"`;
/** The file Graph shows when no language matches: the one marked default, else the first. */
const defaultFile = (files) => files.find((file) => file?.isDefault === true) ?? files[0] ?? null;

/** Why the backup cannot upload this file, or null when its bytes are at hand. */
function missingBytes(file, bytes) {
  if (file?.fileData?.tooLarge) return 'it was too large to back up';
  if (!file?.fileData?.sha256) return 'Graph returned no document for it when the backup was taken';
  if (!bytes) return 'its stored copy could not be found';
  if (sha256Hex(bytes) !== file.fileData.sha256) return 'its stored copy does not match the backup';
  return null;
}

/** The step every recreated agreement leaves: acceptances are never recreated. */
const ACCEPTANCE_STEP = step('acceptances', ['acceptances'], 'Who accepted these terms of use is never recreated: '
  + 'the recreated terms have no acceptances, so everyone they apply to will be asked to accept again the next time they sign in.');

/**
 * Points a backed-up agreement at what a write can send: each file's bytes
 * (checked against its hash) put in the payload, the backup kept as
 * `backupPayload`, and the steps for files that cannot be sent. Returns
 * { resource }, { failed } or { skipped }.
 */
function targetAgreement(resource, verb, ctx = {}) {
  const { naturalKey } = resource;
  const payload = resource.payload;
  if (!payload || typeof payload !== 'object') return { failed: { naturalKey, error: 'the backup holds no terms of use to write' } };
  if (!Array.isArray(payload.files)) {
    const description = 'This backup was taken before KEEL backed up the files of terms of use, so a restore cannot tell which documents they showed. '
      + `Nothing was written: restore from a newer backup, or set up the terms of use by hand in ${PORTAL}.`;
    return { skipped: { naturalKey, reason: `manual: ${description}`, completion: [step('agreementFiles', ['files'], description)] } };
  }
  const stored = ctx.agreementFiles instanceof Map ? ctx.agreementFiles : new Map();
  const steps = [];
  const files = [];
  const withData = payload.files.map((file) => {
    const bytes = stored.get(file?.fileData?.sha256);
    const why = missingBytes(file, bytes);
    if (why) {
      files.push({ file, why });
      return file;
    }
    return { ...file, fileData: { ...file.fileData, data: bytes.toString('base64') } };
  });
  const main = defaultFile(payload.files);
  const mainMissing = files.find(({ file }) => file === main);
  if (verb === 'create' && (!main || mainMissing)) {
    const description = `${main ? `The backup cannot upload ${fileLabel(main)} of these terms of use (${mainMissing.why})` : 'The backup holds no file for these terms of use'}, `
      + `and Graph needs the default file to create them. Nothing was written: recreate the terms of use by hand in ${PORTAL} and upload the document again.`;
    return { skipped: { naturalKey, reason: `manual: ${description}`, completion: [step('agreementFiles', ['files'], description)] } };
  }
  if (files.length > 0) {
    steps.push(step('agreementFiles', ['files'], `${files.map(({ file, why }) => `${fileLabel(file)} (${why})`).join('; ')} `
      + `${files.length === 1 ? 'was' : 'were'} not uploaded. Upload ${files.length === 1 ? 'it' : 'them'} by hand in ${PORTAL}, under Languages.`));
  }
  return { resource: { ...resource, payload: { ...payload, files: withData }, backupPayload: resource.backupPayload ?? payload, agreementSteps: steps } };
}

/** A file as Graph takes it on create or add (agreementFileLocalization), with its bytes. */
const fileBody = (file, { add = false } = {}) => ({
  ...Object.fromEntries(FILE_FIELDS.filter((field) => file?.[field] !== undefined && file[field] !== null && !(add && field === 'isDefault'))
    .map((field) => [field, file[field]])),
  fileData: { data: file.fileData.data },
});

/** The create body: the settings and every file that has its bytes; an update sends neither files nor bytes. */
function agreementBody(body, { verb }) {
  if (verb !== 'create') return body;
  return { ...body, files: list(body.files).filter((file) => typeof file?.fileData?.data === 'string').map((file) => fileBody(file)) };
}

async function readFiles(io, targetId) {
  const read = await io.retryOperation(() => io.writer.read('v1.0', `${agreementPath(targetId)}?$expand=files`));
  if (read?.ok !== true) return { error: `the terms of use files could not be read (${outcomeDetail(read)})` };
  return { files: list(read.body?.files) };
}

/** The Conditional Access policies that require the backed-up agreement, by name: { names } or { error }. */
async function policiesRequiring(io, agreementId) {
  if (!agreementId) return { names: [] };
  const read = await io.retryOperation(() => io.writer.read('v1.0', `${CA_POLICIES}?$select=id,displayName,grantControls`));
  if (read?.ok !== true) return { error: `the Conditional Access policies could not be read to find those that require these terms of use (${outcomeDetail(read)})` };
  const names = list(read.body?.value)
    .filter((policy) => list(policy?.grantControls?.termsOfUse).some((id) => lower(id) === lower(agreementId)))
    .map((policy) => policy.displayName ?? 'a policy with no name').sort();
  return { names };
}

function policyStep(names, displayName) {
  if (names.length === 0) return null;
  return step('conditionalAccessTermsOfUse', ['grantControls.termsOfUse'], `The recreated terms of use "${displayName}" have a new id, and `
    + `${names.length === 1 ? 'the Conditional Access policy' : 'the Conditional Access policies'} ${names.map((name) => `"${name}"`).join(', ')} `
    + `still ${names.length === 1 ? 'requires' : 'require'} the old one. KEEL never changes Conditional Access: edit ${names.length === 1 ? 'it' : 'them'} by hand in ${CA_PORTAL} `
    + 'to require the recreated terms of use, and keep any policy in report-only until it is checked.');
}

/** The settings Graph takes only on create that differ live: a step, or null. */
function createOnlyStep(payload, live) {
  if (!live) return null;
  const differs = Object.keys(SETTING_WORDS).filter((field) => !sameValue(payload?.[field], live?.[field]));
  if (differs.length === 0) return null;
  return step('createOnlySettings', differs, `Graph sets ${differs.map((field) => SETTING_WORDS[field]).join(' and ')} only when terms of use are created, `
    + `so ${differs.length === 1 ? 'it was' : 'they were'} not changed. Set the backup's ${differs.length === 1 ? 'value' : 'values'} by hand in ${PORTAL}.`);
}

/** The files to add (languages live lacks) and the steps for PDFs that differ: { add, steps }. */
function planFiles(payload, liveFiles) {
  const add = [];
  const differs = [];
  const unknown = [];
  for (const file of list(payload.files)) {
    const live = liveFiles.find((candidate) => lower(candidate?.language) === lower(file?.language));
    if (!live) {
      if (typeof file?.fileData?.data === 'string') add.push(file);
      continue;
    }
    const liveData = live.fileData?.data;
    if (typeof liveData !== 'string' || liveData.length === 0) {
      if (file?.fileData?.sha256) unknown.push(file);
      continue;
    }
    if (file?.fileData?.sha256 && sha256Hex(Buffer.from(liveData, 'base64')) !== file.fileData.sha256) differs.push(file);
  }
  const steps = [];
  if (differs.length > 0) {
    steps.push(step('agreementFileVersion', ['files'], `The live PDF of ${differs.map(fileLabel).join(', ')} differs from the backup. `
      + `Graph has no way for KEEL to add a new version of a file, so upload the backed-up document as a new version by hand in ${PORTAL}, under Languages; `
      + 'a major version asks everyone to accept again.'));
  }
  if (unknown.length > 0) {
    steps.push(step('agreementFileVersion', ['files'], `Graph did not return the live PDF of ${unknown.map(fileLabel).join(', ')}, so KEEL cannot tell whether it matches the backup. Check it by hand in ${PORTAL}.`));
  }
  return { add, steps };
}

/** In a dry run: the files an update adds, and the Conditional Access policies a create leaves pointing at the old terms. */
async function agreementPlan(io, { resource, payload, verb, targetId }) {
  const manual = [];
  const changes = {};
  if (verb === 'create') {
    const policies = await policiesRequiring(io, resource.backupPayload?.id ?? payload.id);
    if (policies.error) return { conditionalAccessPolicies: { error: policies.error } };
    if (policies.names.length > 0) {
      changes.conditionalAccessPolicies = policies.names;
      manual.push(policyStep(policies.names, payload.displayName).description);
    }
    changes.files = list(payload.files).filter((file) => typeof file?.fileData?.data === 'string').map((file) => file.language);
  } else if (targetId) {
    const live = await readFiles(io, targetId);
    if (live.error) return { files: { error: live.error } };
    const { add, steps } = planFiles(payload, live.files);
    if (add.length > 0) changes.filesAdded = add.map((file) => file.language);
    manual.push(...steps.map((entry) => entry.description));
  }
  return { ...changes, ...(manual.length > 0 ? { manualSteps: manual } : {}) };
}

/** The steps a dry run can tell without reading: acceptances, files without bytes, create-only settings. */
function agreementPlanSteps({ resource, verb, before }) {
  const steps = [...(resource.agreementSteps ?? [])];
  if (verb === 'create') steps.unshift(ACCEPTANCE_STEP);
  else {
    const settings = createOnlyStep(resource.payload, before);
    if (settings) steps.push(settings);
  }
  return steps;
}

/** After the agreement is created or updated: its files checked (and missing languages added), then the steps. */
async function agreementAfterWrite(io, { resource, payload, verb, targetId, before }) {
  const steps = agreementPlanSteps({ resource, verb, before });
  const live = await readFiles(io, targetId);
  if (live.error) return { error: live.error };
  if (verb === 'create') {
    const sent = list(payload.files).filter((file) => typeof file?.fileData?.data === 'string');
    const absent = sent.filter((file) => !live.files.some((held) => lower(held?.language) === lower(file.language)));
    if (absent.length > 0) return { error: `post-state: ${absent.map(fileLabel).join(', ')} did not read back` };
    const policies = await policiesRequiring(io, resource.backupPayload?.id ?? payload.id);
    if (policies.error) steps.push(step('conditionalAccessTermsOfUse', ['grantControls.termsOfUse'], `${policies.error}. Check by hand in ${CA_PORTAL} which policies require the old terms of use, and point them at the recreated ones.`));
    else if (policies.names.length > 0) steps.push(policyStep(policies.names, payload.displayName));
    return { changes: { files: sent.map((file) => file.language) }, completion: steps };
  }
  const { add, steps: fileSteps } = planFiles(payload, live.files);
  for (const file of add) {
    const result = await io.retryOperation(() => io.writer.write('v1.0', `${agreementPath(targetId)}/files`, { method: 'POST', body: fileBody(file, { add: true }) }));
    if (!result?.ok) return { error: `adding ${fileLabel(file)} failed (${outcomeDetail(result)})` };
  }
  if (add.length > 0) {
    const after = await readFiles(io, targetId);
    if (after.error) return { error: `post-state: ${after.error}` };
    const absent = add.filter((file) => !after.files.some((held) => lower(held?.language) === lower(file.language)));
    if (absent.length > 0) return { error: `post-state: ${absent.map(fileLabel).join(', ')} did not read back` };
  }
  return { changes: add.length > 0 ? { filesAdded: add.map((file) => file.language) } : {}, completion: [...steps, ...fileSteps] };
}

const sameFiles = async (row, payload, io) => {
  const live = await readFiles(io, row.id);
  if (live.error) return false;
  const languages = (files) => list(files).map((file) => lower(file?.language)).sort();
  return sameValue(languages(live.files), languages(payload.files));
};

export const AGREEMENT_RECORD = defineRecord({
  resourceType: TYPE, version: 'v1.0', collection: AGREEMENTS,
  operations: ['create', 'update'], writable: UPDATABLE, createOnly: CREATE_ONLY,
  transform: agreementBody,
  // The files are not on the agreement's own read: afterWrite reads and checks them.
  checkedAfterWrite: ['files'],
  sameField: (field) => (field === 'files' ? true : null),
  refusal: withApprovalGate(),
  // Graph gives an agreement a new id on every create: a second restore from the
  // same backup finds the first one's by name and languages, and never makes a second.
  preflight: createdOnce({
    version: 'v1.0', path: AGREEMENTS, label: 'terms of use',
    matches: (row, payload) => lower(row?.displayName) === lower(payload.displayName),
    same: sameFiles,
  }),
  planChanges: agreementPlan,
  planCompletion: agreementPlanSteps,
  afterWrite: agreementAfterWrite,
  permission: 'Agreement.ReadWrite.All', docs: `${DOCS}/termsofusecontainer-post-agreements?view=graph-rest-1.0`,
});

/** The write of this module: terms of use, with their files' bytes put in first. */
export function agreementDispatch(resource, verb, ctx = {}) {
  if (resource.resourceType !== TYPE) return null;
  if (!AGREEMENT_RECORD.operations.includes(verb)) return { record: AGREEMENT_RECORD, resource };
  const targeted = targetAgreement(resource, verb, ctx);
  if (targeted.failed) return { done: { failed: targeted.failed } };
  if (targeted.skipped) return { done: { skipped: targeted.skipped } };
  return { record: AGREEMENT_RECORD, resource: targeted.resource };
}
