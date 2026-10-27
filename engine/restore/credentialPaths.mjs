import { resolve } from 'node:path';

// The credential files a restore or remediation reads with when the server is not told
// otherwise. One source for the portal, the worker and the restore CLI, matching the
// files the deployment host carries (issue #92: the old Restorer default named a file the
// host never had). The Collector is the same registration every collect command reads by
// default (/etc/keel/tenant.json); the host never had the old tenant-target.json.
// A deployment may move either file with the environment variable, but the worker only
// accepts a .json file under /etc/keel for restore and remediate jobs (issue #411).
export const DEFAULT_COLLECTOR_CONFIG_PATH = '/etc/keel/tenant.json';
export const DEFAULT_RESTORER_CONFIG_PATH = '/etc/keel/restorer.json';

export function credentialPaths(env = process.env) {
  return {
    collectorConfig: env.KEEL_COLLECTOR_CONFIG_PATH || DEFAULT_COLLECTOR_CONFIG_PATH,
    targetConfig: env.KEEL_RESTORER_CONFIG_PATH || DEFAULT_RESTORER_CONFIG_PATH,
  };
}

// Issue #411: a restore or remediate job's settings paths are files the child reads as
// root, so the worker only accepts a .json file under /etc/keel, where only the operator
// writes. The path is resolved first, so `..` cannot step out, and /etc/keel also holds
// keys and env files, so only a `.json` name is accepted. The worker and the portal share
// this one rule, so the portal never queues a job the worker will refuse.
export const KEEL_CONFIG_DIR = '/etc/keel/';

export function isKeelConfigPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) return false;
  const resolved = resolve('/', value);
  return resolved.startsWith(KEEL_CONFIG_DIR) && resolved.endsWith('.json');
}

export function requireKeelConfigPath(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  if (!isKeelConfigPath(value)) throw new Error(`${label} must be a .json file under ${KEEL_CONFIG_DIR}`);
  return resolve('/', value);
}

// A server whose environment moves a settings file out of /etc/keel. Said in plain
// words, naming the setting to fix but never the path itself.
export class RestoreSettingsPathError extends Error {
  constructor(variable) {
    super(`Keel's restore settings file must be a .json file in /etc/keel. Ask whoever runs the Keel server to fix ${variable}.`);
    this.name = 'RestoreSettingsPathError';
    this.variable = variable;
  }
}

/** The server's two settings paths, or a RestoreSettingsPathError when the worker would refuse either. */
export function queueableCredentialPaths(env = process.env) {
  const paths = credentialPaths(env);
  if (!isKeelConfigPath(paths.collectorConfig)) throw new RestoreSettingsPathError('KEEL_COLLECTOR_CONFIG_PATH');
  if (!isKeelConfigPath(paths.targetConfig)) throw new RestoreSettingsPathError('KEEL_RESTORER_CONFIG_PATH');
  return { collectorConfig: resolve('/', paths.collectorConfig), targetConfig: resolve('/', paths.targetConfig) };
}
