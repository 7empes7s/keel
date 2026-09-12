import { DESCRIPTORS } from '../collect/descriptors.mjs';

export function fullSuccessfulCoverageDigest() {
  return Object.fromEntries(
    DESCRIPTORS.map(({ type }) => [type, { outcome: 'complete', itemCount: 0 }]),
  );
}
