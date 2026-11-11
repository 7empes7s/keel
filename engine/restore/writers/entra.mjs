/** Writer fragment: ENTRA (Wave 2). See ./registry.mjs for the entry shape. */
import {
  DIRECTORY_OBJECT_HANDLER, DIRECTORY_SETTING_HANDLER, ENTRA_HANDLER, ENTRA_WRITE_OPERATIONS, SIGN_IN_EXTENSION_HANDLER, SIGN_IN_HANDLER,
} from '../../coverage/capabilities.d/entra.mjs';
import { DIRECTORY_OBJECT_RECORDS, applyDirectoryObjectWrite } from '../directoryObjectOperations.mjs';
import { DIRECTORY_POLICY_RECORDS, applyDirectoryPolicyWrite } from '../directoryPolicyOperations.mjs';
import { DIRECTORY_SETTING_RECORDS, applyDirectorySettingWrite } from '../directorySettingOperations.mjs';
import { SIGN_IN_EXTENSION_RECORDS, applySignInExtensionWrite } from '../signInExtensionOperations.mjs';
import { SIGN_IN_SETTING_RECORDS, applySignInSettingWrite } from '../signInSettingsOperations.mjs';

export default [
  // Directory policies and delegated consents (directoryPolicyOperations.mjs).
  ...Object.keys(DIRECTORY_POLICY_RECORDS).map((resourceType) => ({
    resourceType, verbs: [...ENTRA_WRITE_OPERATIONS], handler: ENTRA_HANDLER, apply: applyDirectoryPolicyWrite,
  })),
  // Issue #994: authentication contexts and staged rollout (signInSettingsOperations.mjs).
  ...Object.values(SIGN_IN_SETTING_RECORDS).map((entry) => ({
    resourceType: entry.resourceType, verbs: [...entry.operations], handler: SIGN_IN_HANDLER, apply: applySignInSettingWrite,
  })),
  // Issue #1072: custom authentication extensions and their listeners (signInExtensionOperations.mjs).
  ...Object.values(SIGN_IN_EXTENSION_RECORDS).map((entry) => ({
    resourceType: entry.resourceType, verbs: [...entry.operations], handler: SIGN_IN_EXTENSION_HANDLER, apply: applySignInExtensionWrite,
  })),
  // Issue #1075: directory settings and objects (directorySettingOperations.mjs, directoryObjectOperations.mjs).
  ...Object.values(DIRECTORY_SETTING_RECORDS).map((entry) => ({
    resourceType: entry.resourceType, verbs: [...entry.operations], handler: DIRECTORY_SETTING_HANDLER, apply: applyDirectorySettingWrite,
  })),
  ...Object.values(DIRECTORY_OBJECT_RECORDS).map((entry) => ({
    resourceType: entry.resourceType, verbs: [...entry.operations], handler: DIRECTORY_OBJECT_HANDLER, apply: applyDirectoryObjectWrite,
  })),
];
