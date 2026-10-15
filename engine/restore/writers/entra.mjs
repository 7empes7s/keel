/** Writer fragment: ENTRA (Wave 2). See ./registry.mjs for the entry shape. */
import { ENTRA_HANDLER, ENTRA_WRITE_OPERATIONS } from '../../coverage/capabilities.d/entra.mjs';
import { DIRECTORY_POLICY_RECORDS, applyDirectoryPolicyWrite } from '../directoryPolicyOperations.mjs';

// Directory policies and delegated consents (directoryPolicyOperations.mjs).
export default Object.keys(DIRECTORY_POLICY_RECORDS).map((resourceType) => ({
  resourceType, verbs: [...ENTRA_WRITE_OPERATIONS], handler: ENTRA_HANDLER, apply: applyDirectoryPolicyWrite,
}));
