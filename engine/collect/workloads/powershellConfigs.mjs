/**
 * Issue #542: which certificate config each PowerShell family connects with.
 *
 * Exchange Online and Security & Compliance refuse a certificate sign-in that names
 * no `organization` ("Organization cannot be null for certificate based connections").
 * The Graph configs (/etc/keel/tenant.json, /etc/keel/restorer.json) have none, so
 * every PowerShell connection must use its family's own file, named in the workload
 * scope file (/etc/keel/workload-scope.json):
 *
 *   "powershellConfigs":         { "exchange": "/etc/keel/exchange-collector.json", ... }
 *   "powershellRestorerConfigs": { "exchange": "/etc/keel/exchange-restorer.json", ... }   (optional)
 *
 * The collect, the restore dry run, the restore promotion and the Discovery cmdlet
 * listing all resolve their config here, so they connect the same way. A restorer
 * family left out of powershellRestorerConfigs uses the collector file's
 * `-restorer.json` sibling when it exists (exchange-collector.json gives
 * exchange-restorer.json). A family with no file uses the caller's default.
 */
import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { readConfigFile, SCOPE_LISTED_FIX } from '../../config/configFile.mjs';
import { WORKLOAD_COLLECTORS } from './registry.mjs';

export const DEFAULT_SCOPE_PATH = '/etc/keel/workload-scope.json';
const CONFIG_DIR = '/etc/keel/';

// Which PowerShell config family each PowerShell workload connects with.
export const POWERSHELL_FAMILY = Object.freeze(Object.fromEntries(WORKLOAD_COLLECTORS
  .filter((entry) => entry.powershellFamily).map((entry) => [entry.workload, entry.powershellFamily])));
export const POWERSHELL_FAMILIES = Object.freeze([...new Set(Object.values(POWERSHELL_FAMILY))]);

const FAMILY_NAMES = { exchange: 'Exchange', onedrive: 'OneDrive', purview: 'Purview' };

/**
 * One family's settings file, read for a role. A missing or broken file fails closed
 * with a plain sentence (engine/config/configFile.mjs), never a raw ENOENT or JSON error.
 */
function readFamilyConfig(path, { family, role, readFile, fix = SCOPE_LISTED_FIX }) {
  return readConfigFile(path, { readFile, what: `${FAMILY_NAMES[family] ?? family} ${role} settings`, fix });
}

// A restorer file found beside the collector file is not listed in the scope file.
const SIBLING_FIX = 'Fix the file on the Keel server, or name the right one in workload-scope.json.';

function checkPathMap(paths, key) {
  if (paths === null || typeof paths !== 'object' || Array.isArray(paths)) throw new Error(`${key} must be an object`);
  for (const [family, path] of Object.entries(paths)) {
    if (!POWERSHELL_FAMILIES.includes(family)) throw new Error(`${key}.${family} is not a PowerShell family (${POWERSHELL_FAMILIES.join(', ')})`);
    if (typeof path !== 'string' || !resolve(path).startsWith(CONFIG_DIR) || resolve(path) !== path) {
      throw new Error(`${key}.${family} must be an absolute path under ${CONFIG_DIR}`);
    }
  }
}

/**
 * The collector config path per family, from the scope file. Throws on an unknown
 * family, a path outside /etc/keel, or a file that names another tenant, so a
 * misconfigured host fails the run loudly instead of connecting somewhere else.
 */
export function powershellConfigPaths(scope, { config, readFile }) {
  const paths = scope?.powershellConfigs ?? {};
  checkPathMap(paths, 'powershellConfigs');
  for (const [family, path] of Object.entries(paths)) {
    const { tenantId } = readFamilyConfig(path, { family, role: 'collector', readFile });
    if (tenantId !== undefined && tenantId !== config.tenantId) {
      throw new Error(`powershellConfigs.${family} names another tenant than the tenant config: refusing to collect`);
    }
  }
  return { ...paths };
}

/** The workload scope file, or {} when the host has none. */
export function readWorkloadScope({ path = DEFAULT_SCOPE_PATH, readFile, exists = existsSync }) {
  return exists(path) ? readConfigFile(path, { readFile, what: 'workload scope' }) : {};
}

/** exchange-collector.json -> exchange-restorer.json, beside it; null for any other name. */
export function restorerSibling(collectorPath) {
  const name = basename(collectorPath);
  return name.endsWith('-collector.json') ? join(dirname(collectorPath), `${name.slice(0, -'-collector.json'.length)}-restorer.json`) : null;
}

/**
 * The config path one PowerShell family connects with for a role, or null when the
 * scope names none (the caller then uses its own default).
 *   role 'collector': powershellConfigs[family].
 *   role 'restorer':  powershellRestorerConfigs[family], else the collector file's
 *                     -restorer.json sibling when it exists.
 * Every file it returns is under /etc/keel and names `tenantId` (a collector file may
 * leave it out, as the collect allows; a restorer file must name it). A restorer file
 * must not share the app or certificate of any family's collector file or of any
 * `separateFrom` config (the Graph collector).
 */
export function familyConfigPath(family, { role, scope = {}, tenantId, readFile, exists = existsSync, separateFrom = [] }) {
  if (!family) return null;
  if (role !== 'collector' && role !== 'restorer') throw new Error(`unknown role ${role}`);
  const collectors = scope.powershellConfigs ?? {};
  const restorers = scope.powershellRestorerConfigs ?? {};
  checkPathMap(collectors, 'powershellConfigs');
  checkPathMap(restorers, 'powershellRestorerConfigs');
  const collectorPath = collectors[family] ?? null;
  let path = collectorPath;
  let fix = SCOPE_LISTED_FIX;
  if (role === 'restorer') {
    const sibling = collectorPath ? restorerSibling(collectorPath) : null;
    path = restorers[family] ?? (sibling && exists(sibling) ? sibling : null);
    if (!restorers[family]) fix = SIBLING_FIX;
  }
  if (!path) return null;
  // Every family's collector file, not only this family's: a restorer is never a collector registration.
  const collectorFiles = [...new Set(Object.values(collectors))];
  if (role === 'restorer' && collectorFiles.includes(path)) {
    throw new Error(`the ${family} PowerShell restorer config is the collector registration: restore requires a separate Restorer`);
  }
  const config = readFamilyConfig(path, { family, role, readFile, fix });
  if (role === 'restorer' && config.tenantId === undefined) {
    throw new Error(`the ${family} PowerShell restorer config (${path}) names no tenantId: add the tenant's id to it`);
  }
  if (config.tenantId !== undefined && config.tenantId !== tenantId) {
    throw new Error(`the ${family} PowerShell ${role} config names another tenant than this restore: refusing to connect`);
  }
  if (role === 'restorer') {
    const collectorFamily = (file) => Object.keys(collectors).find((name) => collectors[name] === file);
    const others = [
      ...collectorFiles.map((file) => readFamilyConfig(file, { family: collectorFamily(file), role: 'collector', readFile })),
      ...separateFrom,
    ];
    const shares = (other) => ['clientId', 'certPath', 'keyPath'].some((key) => config[key] && config[key] === other?.[key]);
    if (others.some(shares)) {
      throw new Error(`the ${family} PowerShell restorer config is the collector registration: restore requires a separate Restorer`);
    }
  }
  return path;
}

/** The config path a workload's PowerShell connects with, or null (see familyConfigPath). */
export function workloadPowershellConfigPath(workload, options) {
  return familyConfigPath(POWERSHELL_FAMILY[workload] ?? null, options);
}
