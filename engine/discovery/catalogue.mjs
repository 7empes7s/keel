/**
 * Wave 1 DISC: what Keel already backs up, so discovery can say which types are
 * catalogued.
 *
 * Graph: every entry in tools/tenant-probe/catalog.mjs, by path (query stripped,
 * case-insensitive, any API version), plus the Graph collections a workload collector
 * reads in full. PowerShell: the Get cmdlets each workload collector allowlists,
 * found by convention (a module exporting `X_MODULE` and an `X_CMDLETS` Set), so a
 * new collector file counts without editing this one.
 */
import { readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

import { CATALOG } from '../../tools/tenant-probe/catalog.mjs';
import { ALIAS_PATHS, SKIPPED_PATHS } from './notGaps.mjs';

// Graph collections read in full by a workload collector rather than a catalogue entry.
export const WORKLOAD_GRAPH_PATHS = Object.freeze({
  '/teams': 'teams-settings',
});

export const catalogPath = (path) => String(path).split('?')[0].replace(/\/+$/, '');
const key = (path) => catalogPath(path).toLowerCase();

/** True when a catalogue path addresses one object's children (`/organization/{org}/branding`). */
export const isUnderItem = (path) => /\{[^}]+\}/.test(path);

/**
 * Map<lowercase path, [{ type, version, source }]> of everything catalogued, from
 * `catalog` (default CATALOG), the workload paths and the alias paths (another path
 * to a catalogued kind, engine/discovery/notGaps.mjs).
 */
export function catalogedGraphPaths({ catalog = CATALOG, workloadPaths = WORKLOAD_GRAPH_PATHS, aliasPaths = ALIAS_PATHS } = {}) {
  const out = new Map();
  const push = (path, entry) => {
    const list = out.get(key(path)) ?? [];
    list.push(entry);
    out.set(key(path), list);
  };
  for (const entry of catalog) {
    if (!isUnderItem(entry.path)) push(entry.path, { type: entry.type, version: entry.version, source: 'catalogue' });
  }
  for (const [path, workload] of Object.entries(workloadPaths)) push(path, { type: workload, version: 'v1.0', source: 'workload' });
  for (const [path, type] of Object.entries(aliasPaths)) {
    if (!out.has(key(path))) push(path, { type, version: null, source: 'alias' });
  }
  return out;
}

/** Map<lowercase path, reason> of readable paths that are not worth backing up. */
export function skippedGraphPaths(skippedPaths = SKIPPED_PATHS) {
  return new Map(Object.entries(skippedPaths).map(([path, reason]) => [key(path), reason]));
}

const workloadsDir = () => join(dirname(fileURLToPath(import.meta.url)), '..', 'collect', 'workloads');

/**
 * Map<module, Set<cmdlet>> of the Get cmdlets the workload collectors run. Each
 * module file is imported once; a file without the convention contributes nothing.
 */
export async function catalogedCmdlets({ dir = workloadsDir(), readdirFn = readdirSync, importFn = (path) => import(pathToFileURL(path).href) } = {}) {
  const out = new Map();
  const files = readdirFn(dir).filter((name) => name.endsWith('.mjs') && !name.endsWith('.test.mjs') && name !== 'registry.mjs').sort();
  for (const file of files) {
    const exports = await importFn(join(dir, file));
    for (const [name, value] of Object.entries(exports)) {
      const match = name.match(/^(.*)_CMDLETS$/);
      if (!match || !(value instanceof Set)) continue;
      const module = exports[`${match[1]}_MODULE`] ?? Object.entries(exports).find(([other, text]) => /_MODULE$/.test(other) && typeof text === 'string')?.[1];
      if (typeof module !== 'string') continue;
      const set = out.get(module) ?? new Set();
      for (const cmdlet of value) if (/^Get-/i.test(cmdlet)) set.add(cmdlet);
      out.set(module, set);
    }
  }
  return out;
}
