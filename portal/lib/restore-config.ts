// Roadmap task-131: the credential files a restore reads and writes with are server
// configuration, never request fields. The portal shows no path and accepts none; the
// worker receives the server's paths (the same defaults cli/keel-worker.mjs falls back to).
export function restoreCredentialPaths(env: NodeJS.ProcessEnv = process.env) {
  return {
    collectorConfig: env.KEEL_COLLECTOR_CONFIG_PATH || "/etc/keel/tenant-target.json",
    targetConfig: env.KEEL_RESTORER_CONFIG_PATH || "/etc/keel/restorer-target.json",
  };
}
