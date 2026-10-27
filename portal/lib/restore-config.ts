import { credentialPaths, queueableCredentialPaths, RestoreSettingsPathError } from "../../engine/restore/credentialPaths.mjs";

export { RestoreSettingsPathError };

// Roadmap task-131: the credential files a restore reads and writes with are server
// configuration, never request fields. The portal shows no path and accepts none; the
// worker receives the server's paths (the same defaults cli/keel-worker.mjs falls back to).
export function restoreCredentialPaths(env: NodeJS.ProcessEnv = process.env) {
  return credentialPaths(env);
}

// Issue #411 follow-up: the paths a queued restore job carries. The worker refuses any
// settings path that is not a .json file under /etc/keel, so a server whose environment
// moves either file elsewhere gets a plain RestoreSettingsPathError here, before a job
// is queued, instead of a job that fails later.
export function queueableRestoreCredentialPaths(env: NodeJS.ProcessEnv = process.env) {
  return queueableCredentialPaths(env);
}
