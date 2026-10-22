/**
 * Wave 1 DISC: walk every readable Graph type and PowerShell Get cmdlet, count what
 * each holds, and report it as catalogued, uncatalogued or unreadable.
 *
 * Rules:
 *  - Read only. Every Graph request goes through engine/discovery/transport.mjs,
 *    which refuses anything but a GET to Microsoft Graph. PowerShell cmdlets are
 *    listed, never run: an uncatalogued Get cmdlet may read mail or traces.
 *  - Counts only. A response body is read for its count and dropped; nothing a type
 *    holds is stored.
 *  - Unknown is not zero. A refused or failed read is `unreadable` with the HTTP
 *    status, the reason and the grant it most likely needs. A 401/403 for a grant the
 *    app already holds is `refused-with-grant`, with no grant hint. A count that stopped at
 *    the page cap is a lower bound (`objectsExact: false`). A PowerShell module whose
 *    command list was not supplied is `not-listed`.
 *  - Not every readable path is a gap. A readable path that holds logs, reports,
 *    runtime state or a Microsoft-published catalogue is `skipped` with the reason
 *    (engine/discovery/notGaps.mjs); another path to a backed-up kind is catalogued.
 */
import { catalogPath, catalogedCmdlets, catalogedGraphPaths, isUnderItem, skippedGraphPaths } from './catalogue.mjs';
import { missingGrant } from './grants.mjs';
import { discoverablePaths, parseMetadata } from './metadata.mjs';
import { CATALOG } from '../../tools/tenant-probe/catalog.mjs';

export const GRAPH_VERSIONS = Object.freeze(['v1.0', 'beta']);
export const DEFAULT_PAGE_CAP = 5;
export const DEFAULT_CONCURRENCY = 4;
export const DEFAULT_MAX_PATHS = 5000;
export const STATUSES = Object.freeze(['catalogued', 'uncatalogued', 'skipped', 'unreadable', 'not-listed']);
export const REASONS = Object.freeze(['missing-grant', 'refused-with-grant', 'not-licensed', 'not-listable', 'error', 'too-large']);

// The containers content backup works through, counted from their Graph collections.
export const CONTAINERS = Object.freeze([
  { name: 'users', path: '/users' },
  { name: 'groups', path: '/groups' },
  { name: 'teams', path: '/teams' },
  { name: 'sites', path: '/sites/getAllSites' },
]);

const MAX_REASON = 300;
const clip = (text) => (typeof text === 'string' && text ? text.slice(0, MAX_REASON) : null);

function graphError(response) {
  const error = response.json?.error;
  return { code: error?.code ?? null, message: clip(error?.message ?? response.text ?? null) };
}

/** The reason category of a failed read. */
export function failureReason(status, { code, message } = {}) {
  const text = `${code ?? ''} ${message ?? ''}`;
  if (status === 401 || status === 403) return /licen[cs]/i.test(text) ? 'not-licensed' : 'missing-grant';
  if (/licen[cs]|subscription|not (been )?provisioned|SPO license/i.test(text)) return 'not-licensed';
  if ([400, 404, 405, 409, 501].includes(status)) return 'not-listable';
  return 'error';
}

/**
 * Reads one discovered path. A collection is counted with $count when Graph gives
 * one, else by walking pages up to `pageCap`; a single object counts as one.
 * Returns { readable, objects, objectsExact, httpStatus, reason, message, grant }.
 * `heldGrants` is the app's granted roles (null when unknown): a refusal for a grant it
 * holds is `refused-with-grant` and carries no grant.
 */
export async function probePath(graph, version, entry, { pageCap = DEFAULT_PAGE_CAP, heldGrants = null } = {}) {
  const fail = (response) => {
    const { code, message } = graphError(response);
    let reason = response.tooLarge ? 'too-large' : failureReason(response.status, { code, message });
    let grant = reason === 'missing-grant' ? missingGrant(entry.path, message, heldGrants) : null;
    if (grant?.held) {
      reason = 'refused-with-grant';
      grant = null;
    }
    return { readable: false, objects: null, objectsExact: null, httpStatus: response.status, reason, message: code ? `${code}: ${message ?? ''}`.trim() : message, grant };
  };
  if (!entry.collection) {
    const response = await graph.get(entry.path, { version });
    if (response.status !== 200 || response.tooLarge) return fail(response);
    return { readable: true, objects: 1, objectsExact: true, httpStatus: 200, reason: null, message: null, grant: null };
  }

  const ok = (objects, objectsExact) => ({ readable: true, objects, objectsExact, httpStatus: 200, reason: null, message: null, grant: null });
  let response = await graph.get(`${entry.path}?$count=true&$top=1`, { version, headers: { ConsistencyLevel: 'eventual' } });
  // Not every collection takes $count or $top; ask again plainly before calling it unreadable.
  let plain = false;
  if (response.status === 400) {
    response = await graph.get(entry.path, { version });
    plain = true;
  }
  if (response.status !== 200 || response.tooLarge) return fail(response);
  if (!Array.isArray(response.json?.value)) return ok(null, false);
  const counted = Number(response.json['@odata.count']);
  if (Number.isSafeInteger(counted) && counted >= 0) return ok(counted, true);
  let next = response.json['@odata.nextLink'] ?? null;
  if (!next) return ok(response.json.value.length, true);
  // No count and more than one page: walk full pages up to the cap.
  let objects = 0;
  next = plain ? next : `${entry.path}?$top=999`;
  if (plain) objects = response.json.value.length;
  for (let page = plain ? 1 : 0; next && page < pageCap; page++) {
    const more = await graph.get(next, { version });
    if (more.status !== 200 || !Array.isArray(more.json?.value)) return ok(objects, false);
    objects += more.json.value.length;
    next = more.json['@odata.nextLink'] ?? null;
  }
  return ok(objects, !next);
}

async function pool(items, limit, worker) {
  const out = new Array(items.length);
  let index = 0;
  const run = async () => {
    while (index < items.length) {
      const mine = index++;
      out[mine] = await worker(items[mine], mine);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, run));
  return out;
}

/**
 * Discovers one Graph version from its $metadata text. Returns
 * { source: { source, version, status, error, paths }, items: [...] }.
 */
export async function discoverGraphVersion(graph, version, metadataText, {
  catalogued = catalogedGraphPaths(), skipped = skippedGraphPaths(), pageCap = DEFAULT_PAGE_CAP, concurrency = DEFAULT_CONCURRENCY,
  maxPaths = DEFAULT_MAX_PATHS, heldGrants = null,
} = {}) {
  const source = `graph:${version}`;
  let paths;
  let metadataVersion = null;
  try {
    const parsed = parseMetadata(metadataText);
    metadataVersion = parsed.version;
    paths = discoverablePaths(parsed);
  } catch (error) {
    return { source: { source, status: 'unknown', error: clip(String(error?.message ?? error)), metadataVersion, paths: 0 }, items: [] };
  }
  const total = paths.length;
  const truncated = total > maxPaths;
  if (truncated) paths = paths.slice(0, maxPaths);
  const items = await pool(paths, concurrency, async (entry) => {
    let probe;
    try {
      probe = await probePath(graph, version, entry, { pageCap, heldGrants });
    } catch (error) {
      if (error?.name === 'DiscoveryWriteRefused') throw error;
      probe = { readable: false, objects: null, objectsExact: null, httpStatus: null, reason: 'error', message: clip(String(error?.message ?? error)), grant: null };
    }
    const lookup = catalogPath(entry.path).toLowerCase();
    const catalogTypes = (catalogued.get(lookup) ?? []).map((item) => item.type);
    const skipReason = catalogTypes.length ? null : skipped.get(lookup) ?? null;
    let status = 'unreadable';
    if (probe.readable) status = catalogTypes.length ? 'catalogued' : skipReason ? 'skipped' : 'uncatalogued';
    return {
      source, name: entry.path, kind: entry.kind, entityType: entry.entityType, status, catalogTypes,
      objects: probe.objects, objectsExact: probe.objectsExact, httpStatus: probe.httpStatus,
      reason: status === 'skipped' ? skipReason : probe.reason, message: probe.message, missingGrant: probe.grant?.grant ?? null, grantSource: probe.grant?.source ?? null,
    };
  });
  return {
    source: { source, status: truncated ? 'partial' : 'complete', error: truncated ? `stopped at ${maxPaths} of ${total} paths` : null, metadataVersion, paths: items.length },
    items,
  };
}

/** A module's source error when nobody tried to list it (the run was given no list). */
export const NO_COMMAND_LIST = 'no command list was supplied for this module';

/**
 * Classifies each PowerShell module's Get cmdlets. `commands` is
 * { [module]: [cmdletName, ...] } as listed on the host (Get-Command -Module M -Verb Get);
 * a module Keel collects from that is missing from it is reported `not-listed`, with
 * `errors[module]` (why the host could not list it) as the source's error when known.
 */
export function discoverPowerShell(commands, cataloguedCmdlets, errors = {}) {
  const items = [];
  const sources = [];
  const modules = new Set([...cataloguedCmdlets.keys(), ...Object.keys(commands ?? {})]);
  for (const module of [...modules].sort()) {
    const source = `powershell:${module}`;
    const known = cataloguedCmdlets.get(module) ?? new Set();
    const knownLower = new Map([...known].map((name) => [name.toLowerCase(), name]));
    const listed = Array.isArray(commands?.[module]) ? commands[module] : null;
    if (!listed) {
      const why = typeof errors?.[module] === 'string' && errors[module] ? clip(errors[module]) : NO_COMMAND_LIST;
      sources.push({ source, status: 'unknown', error: why, metadataVersion: null, paths: 0 });
      for (const cmdlet of [...known].sort()) {
        items.push({ source, name: cmdlet, kind: 'cmdlet', entityType: null, status: 'not-listed', catalogTypes: [module], objects: null, objectsExact: null, httpStatus: null, reason: null, message: 'not in a supplied command list', missingGrant: null, grantSource: null });
      }
      continue;
    }
    const names = [...new Set(listed.filter((name) => typeof name === 'string' && /^Get-[A-Za-z0-9]+$/.test(name)))].sort();
    sources.push({ source, status: 'complete', error: null, metadataVersion: null, paths: names.length });
    for (const cmdlet of names) {
      const catalogued = knownLower.has(cmdlet.toLowerCase());
      items.push({ source, name: cmdlet, kind: 'cmdlet', entityType: null, status: catalogued ? 'catalogued' : 'uncatalogued', catalogTypes: catalogued ? [module] : [], objects: null, objectsExact: null, httpStatus: null, reason: null, message: null, missingGrant: null, grantSource: null });
    }
  }
  return { sources, items };
}

/**
 * How each catalogue entry fared: `covered` (its path was read), `under-item` (it sits
 * under one object, such as `/organization/{org}/branding`, and the collection
 * that object is listed in was read), `unreadable`, or `not-in-metadata`.
 */
export function catalogueCoverage(items, catalog = CATALOG) {
  const graphItems = items.filter((item) => item.source.startsWith('graph:'));
  const byPath = new Map();
  for (const item of graphItems) {
    const list = byPath.get(item.name.toLowerCase()) ?? [];
    list.push(item);
    byPath.set(item.name.toLowerCase(), list);
  }
  return catalog.map((entry) => {
    const path = catalogPath(entry.path);
    // An entry under one object is looked up by the collection that object is
    // listed in: the path up to its first placeholder.
    const lookup = isUnderItem(path) ? path.slice(0, path.search(/\/\{/)) : path;
    const seen = byPath.get(lookup.toLowerCase()) ?? [];
    const readable = seen.find((item) => item.status !== 'unreadable');
    let coverage;
    if (readable) coverage = isUnderItem(path) ? 'under-item' : 'covered';
    else coverage = seen.length ? 'unreadable' : 'not-in-metadata';
    const refused = seen.find((item) => item.status === 'unreadable');
    return {
      type: entry.type, path, version: entry.version, coverage,
      objects: readable && !isUnderItem(path) ? readable.objects : null,
      reason: coverage === 'unreadable' ? refused?.reason ?? null : null,
      missingGrant: coverage === 'unreadable' ? refused?.missingGrant ?? null : null,
    };
  });
}

/** The run summary the portal reads. */
export function summarize(items, catalogue, extraContainers = {}) {
  const distinct = new Map();
  for (const item of items) {
    const id = `${item.kind === 'cmdlet' ? item.source : 'graph'}|${item.name.toLowerCase()}`;
    const prior = distinct.get(id);
    // A type readable in any version counts as readable.
    if (!prior || (prior.status === 'unreadable' && item.status !== 'unreadable')) distinct.set(id, item);
  }
  const counts = Object.fromEntries(STATUSES.map((status) => [status, 0]));
  for (const item of distinct.values()) counts[item.status] += 1;
  const containers = {};
  for (const container of CONTAINERS) {
    const item = items.find((candidate) => candidate.source === 'graph:v1.0' && candidate.name.toLowerCase() === container.path.toLowerCase())
      ?? items.find((candidate) => candidate.source.startsWith('graph:') && candidate.name.toLowerCase() === container.path.toLowerCase());
    if (extraContainers[container.name]) containers[container.name] = extraContainers[container.name];
    else if (!item) containers[container.name] = null;
    else if (item.status === 'unreadable') containers[container.name] = { objects: null, exact: null, reason: item.reason, missingGrant: item.missingGrant };
    else containers[container.name] = { objects: item.objects, exact: item.objectsExact };
  }
  const coverage = {};
  for (const entry of catalogue) coverage[entry.coverage] = (coverage[entry.coverage] ?? 0) + 1;
  return { types: distinct.size, ...counts, containers, catalogue: coverage };
}

/**
 * One discovery run. `metadata` is { [version]: text } for each Graph version to walk
 * (a version whose fetch failed maps to an Error and is reported `unknown`).
 * `powershellCommands` is the per-module command list, or null; `powershellErrors` says
 * why a module could not be listed. `heldGrants` is the
 * app's granted roles (from its token), or null when they are not known.
 */
export async function discover({
  graph, metadata, powershellCommands = null, powershellErrors = {}, catalog = CATALOG, cataloguedCmdlets, now = () => new Date(),
  pageCap, concurrency, maxPaths, containers = true, heldGrants = null,
}) {
  const startedAt = now();
  const catalogued = catalogedGraphPaths({ catalog });
  const sources = [];
  const items = [];
  for (const version of Object.keys(metadata)) {
    const text = metadata[version];
    if (text instanceof Error || typeof text !== 'string') {
      sources.push({ source: `graph:${version}`, status: 'unknown', error: clip(String(text?.message ?? 'no metadata')), metadataVersion: null, paths: 0 });
      continue;
    }
    const result = await discoverGraphVersion(graph, version, text, { catalogued, pageCap, concurrency, maxPaths, heldGrants });
    sources.push(result.source);
    items.push(...result.items);
  }
  // Containers reached through a function (sites) are not entity sets: count them
  // for the summary without listing them as types.
  const extraContainers = {};
  if (containers && typeof metadata['v1.0'] === 'string') {
    for (const container of CONTAINERS) {
      if (items.some((item) => item.source === 'graph:v1.0' && item.name.toLowerCase() === container.path.toLowerCase())) continue;
      try {
        const probe = await probePath(graph, 'v1.0', { path: container.path, collection: true }, { pageCap, heldGrants });
        extraContainers[container.name] = probe.readable ? { objects: probe.objects, exact: probe.objectsExact }
          : { objects: null, exact: null, reason: probe.reason, missingGrant: probe.grant?.grant ?? null };
      } catch (error) {
        if (error?.name === 'DiscoveryWriteRefused') throw error;
        extraContainers[container.name] = { objects: null, exact: null, reason: 'error', missingGrant: null };
      }
    }
  }
  const shell = discoverPowerShell(powershellCommands ?? {}, cataloguedCmdlets ?? await catalogedCmdlets(), powershellErrors ?? {});
  sources.push(...shell.sources);
  items.push(...shell.items);
  const catalogue = catalogueCoverage(items, catalog);
  return { startedAt: startedAt.toISOString(), finishedAt: now().toISOString(), sources, items, catalogue, summary: summarize(items, catalogue, extraContainers) };
}
