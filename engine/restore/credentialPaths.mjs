// The credential files a restore or remediation reads with when the server is not told
// otherwise. One source for the portal, the worker and the restore CLI, matching the
// files the deployment host carries (issue #92: the old Restorer default named a file the
// host never had). The Collector is the same registration every collect command reads by
// default (/etc/keel/tenant.json); the host never had the old tenant-target.json.
// A deployment may move either file with the environment variable.
export const DEFAULT_COLLECTOR_CONFIG_PATH = '/etc/keel/tenant.json';
export const DEFAULT_RESTORER_CONFIG_PATH = '/etc/keel/restorer.json';

export function credentialPaths(env = process.env) {
  return {
    collectorConfig: env.KEEL_COLLECTOR_CONFIG_PATH || DEFAULT_COLLECTOR_CONFIG_PATH,
    targetConfig: env.KEEL_RESTORER_CONFIG_PATH || DEFAULT_RESTORER_CONFIG_PATH,
  };
}
