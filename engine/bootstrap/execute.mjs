// Task 75. This boundary has no live Microsoft transport. Adapters must
// implement authoritative lookup and idempotent ensure, including partial app/SP
// creation. Unknown lookup results can never be interpreted as absence.
import { existsSync } from 'node:fs';
import { AUTOMATION_KILL_SWITCH_PATH } from '../policy/execute.mjs';
import { planBootstrap } from './plan.mjs';
import { artifactDigest, immutable } from './journal.mjs';
import { assertTokenFree } from '../../tools/tenant-probe/auth.mjs';

const emptyReaders = Object.fromEntries(['Applications', 'ServicePrincipals', 'AppRoleAssignments',
  'RoleAssignments', 'RoleEligibilitySchedules', 'SubscribedSkus'].map(n => [`list${n}`, async () => []]));
const reference = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9:/.@_-]{0,255}$/.test(value);

function checkCredentials(credentials) {
  for (const mode of ['collector', 'restorer']) {
    const credential = credentials?.[mode];
    if (!reference(credential?.credentialRef) || !reference(credential?.identityRef)
      || Object.keys(credential).some(key => !['credentialRef', 'identityRef'].includes(key))) {
      throw new Error('bootstrap: separate reference-only collector/restorer credentials required');
    }
  }
  if (credentials.collector.credentialRef === credentials.restorer.credentialRef
    || credentials.collector.identityRef === credentials.restorer.identityRef) {
    throw new Error('bootstrap: collector and restorer must remain separate');
  }
  assertTokenFree(credentials);
}

// The planner's stable planId intentionally omits observed state; it is not an
// approval digest. Compare the complete least-privilege intent with a fresh
// derivation, then bind the FULL artifact (including observed state) separately.
function intent(plan) {
  return { contractVersion: plan.contractVersion, tenantRef: plan.tenantRef, workloads: plan.workloads,
    identities: plan.identities, steps: plan.steps.map(s => ({ id: s.id, kind: s.kind, identity: s.identity,
      workload: s.workload, name: s.name, requiredScopes: s.requiredScopes ?? null,
      action: s.kind === 'registration' && ['create-registration', 'update-required-access', 'reuse-existing'].includes(s.action)
        ? 'ensure-registration' : s.action,
      resourceAppId: s.resourceAppId ?? null, resolution: s.resolution ?? null, templateId: s.templateId ?? null })) };
}
async function validateIntent(plan) {
  const derived = await planBootstrap({ tenantRef: plan.tenantRef, workloads: plan.workloads, readAdapters: emptyReaders });
  if (artifactDigest(intent(plan)) !== artifactDigest(intent(derived))) throw new Error('bootstrap: plan intent differs from registered least-privilege prerequisites');
}
function prerequisitesValid(value, revision) {
  if (value?.killSwitch !== false) throw new Error('bootstrap: kill switch blocks execution');
  if (value?.allowed !== true || !reference(value?.revision) || (revision && value.revision !== revision)) {
    throw new Error('bootstrap: revoked or changed prerequisites');
  }
}

export async function approveBootstrapPlan({ journal, plan, credentials, adapters, build, qualificationMode = 'live-qualified' }) {
  await journal.authorize();
  await journal.authorize('approve');
  // Detach before awaiting: callers cannot alter what is being approved.
  plan = immutable(structuredClone(plan));
  credentials = immutable(structuredClone(credentials));
  checkCredentials(credentials);
  if (plan.tenantRef !== journal.tenantRef) throw new Error('bootstrap: tenant mismatch');
  if (!reference(build) || !['fixture-tested', 'live-qualified'].includes(qualificationMode)) throw new Error('bootstrap: qualification mode/build required');
  await validateIntent(plan);
  const prerequisites = await adapters.prerequisites({ tenantRef: journal.tenantRef, principalId: journal.principalId, plan, credentials });
  prerequisitesValid(prerequisites);
  return journal.approve({ version: 1, tenantRef: journal.tenantRef, runAs: journal.principalId,
    plan, credentials, prerequisiteRevision: prerequisites.revision, build, qualificationMode, projection: 'identity-v1' });
}

function observation(raw, artifact, step) {
  if (raw?.tenantRef !== artifact.tenantRef || !['absent', 'partial', 'satisfied'].includes(raw?.status)) {
    throw new Error('bootstrap: ambiguous or cross-tenant observation');
  }
  const result = { tenantRef: raw.tenantRef, status: raw.status };
  // Never persist arbitrary adapter payloads or error strings.
  for (const key of ['objectId', 'appId', 'servicePrincipalId']) {
    if (raw[key] !== undefined) {
      if (!reference(raw[key])) throw new Error('bootstrap: invalid observation reference');
      result[key] = raw[key];
    }
  }
  if (step.kind === 'registration' && raw.status === 'satisfied'
    && (!result.objectId || !result.appId || !result.servicePrincipalId)) throw new Error('bootstrap: incomplete registration observation');
  if (result.appId && result.appId !== artifact.credentials[step.identity].identityRef) throw new Error('bootstrap: observed identities must remain separate and match approved identity references');
  return assertTokenFree(result);
}

export async function executeBootstrap({ journal, artifactId, adapters, build, qualificationMode = 'live-qualified', killSwitchPath = AUTOMATION_KILL_SWITCH_PATH }) {
  return journal.exclusive(async () => {
    const artifact = await journal.load(artifactId);
    checkCredentials(artifact.credentials);
    if (artifact.build !== build || artifact.qualificationMode !== qualificationMode) throw new Error('bootstrap: qualification build/mode mismatch');
    await validateIntent(artifact.plan);
    const context = { tenantRef: artifact.tenantRef, principalId: artifact.runAs,
      plan: artifact.plan, credentials: artifact.credentials };
    const guard = async () => {
      if (existsSync(killSwitchPath)) throw new Error('bootstrap: kill switch blocks execution');
      await journal.load(artifactId); // run-as, grant revocation and immutable digest
      prerequisitesValid(await adapters.prerequisites(context), artifact.prerequisiteRevision);
    };
    const observe = async step => {
      await guard();
      const value = observation(await adapters.observe({ ...context, step }), artifact, step);
      await journal.append(artifactId, step.id, 'observed', value);
      return value;
    };
    const qualify = async step => {
      const credentialRef = artifact.credentials.restorer.credentialRef;
      const intentHash = artifactDigest(intent({ ...artifact.plan, steps: [step] }));
      const q = await adapters.qualify({ ...context, step, credentialRef, intentHash });
      if (q?.tenantRef !== artifact.tenantRef || q?.credentialRef !== credentialRef
        || q?.intentHash !== intentHash || q?.operation !== step.action || q?.build !== build || q?.projection !== artifact.projection
        || q?.status !== qualificationMode || !(Date.parse(q?.expiresAt) > Date.now())) {
        throw new Error('bootstrap: operation is not qualified for tenant/credential/build/projection/time');
      }
      return credentialRef;
    };
    try {
      await guard();
      // Manual authorities are checked BEFORE all writes, even when the planner
      // labelled PIM eligibility satisfied. Eligibility is not active authority.
      const manual = artifact.plan.steps.filter(s => ['pim-activation', 'workload-rbac'].includes(s.kind));
      for (const step of manual) {
        if ((await observe(step)).status !== 'satisfied') {
          await journal.append(artifactId, step.id, 'pending-manual', { kind: step.kind });
          return { artifactId, status: 'pending-manual', stepId: step.id };
        }
      }
      for (const step of artifact.plan.steps.filter(s => !manual.includes(s))) {
        await guard();
        // Read the persisted journal before reconciliation, even after a crash.
        const history = await journal.events(artifactId);
        const prior = history.filter(event => event.step_id === step.id);
        await journal.append(artifactId, step.id, 'desired', { intent: intent({ ...artifact.plan, steps: [step] }).steps[0] });
        const observed = await observe(step);
        if (observed.status === 'satisfied') {
          await journal.append(artifactId, step.id, 'verified', observed);
          continue;
        }
        // A previously verified grant that disappears is revocation, never an
        // instruction to silently re-grant it under an old approval.
        if (step.status === 'satisfied' || prior.some(event => event.state === 'verified')) {
          throw new Error('bootstrap: revoked or changed prerequisites');
        }
        if (prior.filter(event => event.state === 'uncertain').length >= 3) throw new Error('bootstrap: retry quota exhausted');
        await guard();
        const credentialRef = await qualify(step);
        await guard();
        try {
          await adapters.ensure({ ...context, step, credentialRef, observed,
            idempotencyKey: `${artifact.tenantRef}:${artifact.plan.planId}:${step.id}` });
        } catch {
          await journal.append(artifactId, step.id, 'uncertain', {});
          throw new Error('bootstrap: uncertain provisioning outcome; resume through observation');
        }
        const verified = await observe(step);
        if (verified.status !== 'satisfied') {
          await journal.append(artifactId, step.id, 'uncertain', {});
          throw new Error('bootstrap: post-write verification failed');
        }
        await journal.append(artifactId, step.id, 'verified', verified);
      }
      // Re-read every outcome before claiming completion, including manual steps.
      for (const step of artifact.plan.steps) {
        if ((await observe(step)).status !== 'satisfied') throw new Error('bootstrap: final verification failed');
      }
      await journal.append(artifactId, null, 'complete', { qualification: qualificationMode });
      return { artifactId, status: 'complete', qualification: qualificationMode };
    } catch (error) {
      // If authorization was revoked, no subsequent journal write is authorized.
      // Previously committed desired/observed events retain the unresolved state.
      await journal.append(artifactId, null, 'stopped', {}).catch(() => {});
      throw error;
    }
  });
}
