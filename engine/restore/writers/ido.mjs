/**
 * Writer fragment: IDO (Wave 2). See ./registry.mjs for the entry shape.
 *
 * Identity objects (engine/restore/identityObjectOperations.mjs) and the Wave 2
 * Intune records (engine/restore/intuneOperations.mjs). Each pair's capability
 * is in engine/coverage/capabilities.d/ido.mjs and names the same handler.
 */
import { IDENTITY_RECORDS, applyIdentityObjectWrite } from '../identityObjectOperations.mjs';
import { INTUNE_EXTENDED_RECORDS, applyIntuneExtendedWrite } from '../intuneOperations.mjs';

export const IDENTITY_HANDLER = 'engine/restore/identityObjectOperations.mjs#applyIdentityObjectWrite';
export const INTUNE_HANDLER = 'engine/restore/intuneOperations.mjs#applyIntuneExtendedWrite';

export default [
  ...Object.values(IDENTITY_RECORDS).map((record) => ({
    resourceType: record.resourceType, verbs: [...record.operations], handler: IDENTITY_HANDLER, apply: applyIdentityObjectWrite,
  })),
  { resourceType: 'user', verbs: ['create'], handler: IDENTITY_HANDLER, apply: applyIdentityObjectWrite },
  ...Object.values(INTUNE_EXTENDED_RECORDS).map((record) => ({
    resourceType: record.resourceType, verbs: [...record.operations], handler: INTUNE_HANDLER, apply: applyIntuneExtendedWrite,
  })),
];
