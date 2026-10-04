import { credentialPaths } from "../../engine/restore/credentialPaths.mjs";

// Roadmap task-131: the credential files a restore reads and writes with are server
// configuration, never request fields. The portal shows no path and accepts none; the
// worker receives the server's paths (the same defaults cli/keel-worker.mjs falls back to).
export function restoreCredentialPaths(env: NodeJS.ProcessEnv = process.env) {
  return credentialPaths(env);
}
