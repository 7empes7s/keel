import { applyWave } from '../restore/applyEngine.mjs';
import { phaseOneResources } from '../restore/wavePlanner.mjs';

/** Evaluate the real apply guards in dry-run mode. No writer, governor or journal
 * is supplied: an accidental attempt to mutate fails closed. Future creates get
 * symbolic IDs only after passing their wave, for later reference resolution. */
export async function previewApplyPlan({
  resources, waves, deletionWaves, patches, existingTargetIds,
  deletionGuardOptions, signInPathGate, targetTenant, lockoutGate = null,
}) {
  const appliedIds = new Map();
  const refusals = [];
  for (const [index, keys] of [...waves, ...deletionWaves].entries()) {
    const selected = resources.filter((resource) => keys.includes(resource.naturalKey));
    const wave = index < waves.length ? phaseOneResources(selected, patches) : selected;
    try {
      const result = await applyWave(null, null, wave, {
        mode: 'dry-run', targetTenant, existingTargetIds, appliedIds,
        deletionGuardOptions, signInPathGate, lockoutGate,
      });
      refusals.push(...result.skipped, ...result.failed.map(({ naturalKey, error }) => ({
        naturalKey, reason: error,
      })));
      for (const { naturalKey, targetId } of result.applied) {
        if (targetId) appliedIds.set(naturalKey, targetId);
        else if (wave.find((resource) => resource.naturalKey === naturalKey)?.verb === 'create') {
          appliedIds.set(naturalKey, `preview:${naturalKey}`);
        }
      }
    } catch (error) {
      // Missing/incomplete safety evidence is a refusal, never a green preview.
      refusals.push(...keys.map((naturalKey) => ({ naturalKey, reason: error.message })));
    }
  }
  return refusals;
}
