/**
 * The Engage writer (issue #681): a small app registration of its own that holds
 * Community.ReadWrite.All and nothing else, for Viva Engage community restores.
 *
 * Why a separate app: Viva Engage's front proxy refuses a request whose headers are
 * too large, and an app-only token carries every role the app holds. Measured live
 * (Q224, 2026-10-29): the Restorer's token (5326 bytes, 64 Graph roles) gets the
 * proxy's HTML 400 on every /employeeExperience call, the Collector's (4496 bytes)
 * gets 200. The Restorer only grows, so Engage writes sign in as this app instead.
 *
 * Its settings file has the Restorer's shape (tenantId, clientId, certPath, keyPath)
 * and lives at /etc/keel/engage-writer.json unless KEEL_ENGAGE_WRITER_CONFIG_PATH
 * moves it. When the file is missing, Engage writes keep using the Restorer, as
 * before, and the run says so.
 */
import { readConfigFile } from '../config/configFile.mjs';

export const ENGAGE_WRITER_IDENTITY = 'engage-writer';
export const DEFAULT_ENGAGE_WRITER_CONFIG_PATH = '/etc/keel/engage-writer.json';
// Everything the Engage writer may hold: it signs in for these writes only.
export const ENGAGE_WRITER_SCOPES = Object.freeze(['Community.ReadWrite.All']);
// The restore types it writes.
export const ENGAGE_RESOURCE_TYPES = Object.freeze(['engageCommunity']);

const ENGAGE_PATH = /^\/(?:v1\.0|beta)\/employeeExperience(?:\/|\?|$)/;

/** True for a Graph URL under /employeeExperience (Viva Engage). */
export function isEngageUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.host === 'graph.microsoft.com' && ENGAGE_PATH.test(parsed.pathname);
  } catch {
    return false;
  }
}

export function engageWriterConfigPath(env = process.env) {
  return env.KEEL_ENGAGE_WRITER_CONFIG_PATH || DEFAULT_ENGAGE_WRITER_CONFIG_PATH;
}

/** True when a restore touches a type the Engage writer writes. */
export function needsEngageWriter(resourceTypes) {
  return [...resourceTypes].some((type) => ENGAGE_RESOURCE_TYPES.includes(type));
}

/**
 * The Engage writer's settings, or null when the file is missing. A file that is
 * there but broken, names another tenant, or reuses the Collector's or Restorer's
 * app or certificate stops the run with a plain sentence.
 */
export function readEngageWriterConfig({ path = engageWriterConfigPath(), readFile, collectorConfig, targetConfig }) {
  let config;
  try {
    config = readConfigFile(path, { readFile, what: 'Engage writer settings' });
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  }
  if (typeof config.clientId !== 'string' || config.clientId.length === 0) {
    throw new Error(`The Engage writer settings file (${path}) names no clientId. Fix the file on the Keel server, then try again.`);
  }
  if (config.tenantId !== targetConfig?.tenantId) {
    throw new Error(`The Engage writer settings file (${path}) names another tenant than the Restorer. Fix the file on the Keel server, then try again.`);
  }
  for (const other of [collectorConfig, targetConfig].filter(Boolean)) {
    if (config.clientId === other.clientId || config.certPath === other.certPath || config.keyPath === other.keyPath) {
      throw new Error(`The Engage writer settings file (${path}) must name its own app and certificate, not the Collector's or the Restorer's. Fix the file on the Keel server, then try again.`);
    }
  }
  return config;
}

/**
 * The token function a restore's GraphWriter signs in with. Every request uses the
 * Restorer's token, except Viva Engage requests when an Engage writer is set up:
 * those use the Engage writer's. Both tokens are fetched before any write, so a
 * broken credential stops the run before it changes anything.
 *
 * Returns { tokenFor(url), engage: 'engage-writer' | 'restorer' | 'not-needed' }.
 */
export async function restoreWriterTokens({
  getTokenFn, targetConfig, collectorConfig = null, resourceTypes = [], readFile, path = engageWriterConfigPath(), logger = null,
}) {
  const { accessToken: restorerToken } = await getTokenFn(targetConfig);
  if (!needsEngageWriter(resourceTypes)) return { tokenFor: async () => restorerToken, engage: 'not-needed' };
  const engageConfig = readEngageWriterConfig({ path, readFile, collectorConfig, targetConfig });
  if (!engageConfig) {
    logger?.log?.(`Viva Engage writes: no Engage writer settings file (${path}), so they use the Restorer; Viva Engage may refuse its sign-in (issue #681)`);
    return { tokenFor: async () => restorerToken, engage: 'restorer' };
  }
  const { accessToken: engageToken } = await getTokenFn(engageConfig);
  logger?.log?.('Viva Engage writes: signed in as the Engage writer');
  return { tokenFor: async (url) => (isEngageUrl(url) ? engageToken : restorerToken), engage: ENGAGE_WRITER_IDENTITY };
}
