#!/usr/bin/env node
// /opt/keel/cli/keel-discover.mjs
//
// node keel-discover.mjs run  [--config /etc/keel/tenant.json] [--db-url $KEEL_DB_URL]
//                             [--versions v1.0,beta] [--metadata-dir DIR]
//                             [--powershell-commands FILE] [--out FILE] [--no-store]
//                             [--page-cap 5] [--concurrency 4] [--tenant-ref REF]
// node keel-discover.mjs show [--config /etc/keel/tenant.json] [--db-url $KEEL_DB_URL]
//
// Wave 1 DISC: what the tenant holds that Keel could back up.
//   run   reads each Graph version's $metadata, walks every entity set, singleton and
//         containment path under them, and counts the objects each one holds. Each type
//         is catalogued (Keel backs it up), uncatalogued (readable, not backed up yet),
//         skipped (readable, but logs, reports or a Microsoft-published catalogue)
//         or unreadable (with the HTTP status, the reason and the grant it most likely
//         needs; a refusal for a grant the app's token already holds is
//         refused-with-grant, with no hint). Every request is a GET to Microsoft Graph;
//         anything else is refused before it is sent. Bodies are counted and dropped.
//         --metadata-dir reads <dir>/v1.0.xml and <dir>/beta.xml instead of fetching them.
//         --powershell-commands names a JSON file { "<module>": ["Get-...", ...] }, as
//         listed on the host with
//           Get-Command -Module <module> -Verb Get | Select-Object -ExpandProperty Name
//         after connecting. Cmdlets are listed, never run. A module it leaves out is
//         reported "not listed", never as having no cmdlets.
//         --out writes the inventory as JSON (the operator commits it); --no-store skips
//         the database.
//         Exits 1 when a Graph source could not be read in full.
//         --tenant-ref is what the scheduled `discover` job sends; a run for another tenant
//         than the config names is refused before any request.
//   show  prints the latest stored run: totals, then every uncatalogued and unreadable type.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { getToken } from '../tools/tenant-probe/auth.mjs';
import { connect } from '../engine/store/db.mjs';
import { tenantRefFor } from '../engine/store/tenantRef.mjs';
import { GRAPH_VERSIONS, discover } from '../engine/discovery/discover.mjs';
import { tokenRoles } from '../engine/discovery/grants.mjs';
import { loadLatestDiscovery, saveDiscoveryRun } from '../engine/discovery/store.mjs';
import { readOnlyGraph } from '../engine/discovery/transport.mjs';

function arg(argv, name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i > -1 ? argv[i + 1] : fallback;
}

function positive(value, name) {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`--${name} must be a positive integer`);
  return number;
}

/** Each version's $metadata text, or an Error when it could not be read. */
export async function loadMetadata(graph, versions, { dir = null, readFile }) {
  const out = {};
  for (const version of versions) {
    try {
      if (dir) {
        out[version] = readFile(join(dir, `${version}.xml`));
        continue;
      }
      const response = await graph.get('/$metadata', { version, headers: { Accept: 'application/xml' } });
      if (response.status !== 200 || response.tooLarge || !response.text) {
        throw new Error(`GET /${version}/$metadata answered ${response.status}${response.tooLarge ? ' (too large)' : ''}`);
      }
      out[version] = response.text;
    } catch (error) {
      out[version] = error instanceof Error ? error : new Error(String(error));
    }
  }
  return out;
}

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
const objects = (item) => (item.objects === null || item.objects === undefined ? 'count unknown' : `${item.objectsExact === false ? 'at least ' : ''}${plural(item.objects, 'object')}`);

/** The lines `run` and `show` print for one inventory. */
export function describeInventory(run) {
  const { summary } = run;
  const lines = [
    `Discovery ${run.finishedAt}: ${plural(summary.types, 'type')}; ${summary.catalogued} catalogued, ${summary.uncatalogued} uncatalogued, ${summary.skipped ?? 0} skipped (not worth backing up), ${summary.unreadable} unreadable, ${summary['not-listed']} not listed.`,
  ];
  for (const source of run.sources) {
    if (source.status !== 'complete') lines.push(`  ${source.source}: ${source.status}${source.error ? ` (${source.error})` : ''}`);
  }
  const containers = Object.entries(summary.containers ?? {})
    .map(([name, value]) => `${name} ${value?.objects === null || value?.objects === undefined ? 'unknown' : `${value.exact === false ? '≥' : ''}${value.objects}`}`);
  if (containers.length) lines.push(`Containers: ${containers.join(', ')}.`);
  // Counted from the entries when present, so a stored run shows the not-used rule too.
  const counts = Array.isArray(run.catalogue)
    ? run.catalogue.reduce((out, entry) => ({ ...out, [entry.coverage]: (out[entry.coverage] ?? 0) + 1 }), {})
    : summary.catalogue ?? {};
  const catalogue = Object.entries(counts).map(([state, count]) => `${count} ${state}`).join(', ');
  if (catalogue) lines.push(`Catalogue: ${catalogue}.`);
  for (const entry of Array.isArray(run.catalogue) ? run.catalogue : []) {
    if (entry.coverage === 'covered' || entry.coverage === 'under-item') continue;
    lines.push(`  ${entry.coverage} ${entry.type} (${entry.version} ${entry.path})${entry.reason ? `: ${entry.reason}` : ''}${entry.missingGrant ? `, needs ${entry.missingGrant}` : ''}`);
  }
  const uncatalogued = run.items.filter((item) => item.status === 'uncatalogued');
  if (uncatalogued.length) lines.push('Uncatalogued (readable, not backed up yet):');
  for (const item of uncatalogued) lines.push(`  ${item.source} ${item.name}${item.kind === 'cmdlet' ? '' : ` (${objects(item)})`}`);
  const unreadable = run.items.filter((item) => item.status === 'unreadable');
  if (unreadable.length) lines.push('Unreadable:');
  for (const item of unreadable) {
    // A refusal for a held grant has no hint, so Graph's own words are the reason.
    const said = item.reason === 'refused-with-grant' && item.message ? `; Graph said: ${item.message.slice(0, 160)}` : '';
    lines.push(`  ${item.source} ${item.name}: ${item.reason}${item.httpStatus ? ` (${item.httpStatus})` : ''}${item.missingGrant ? `, needs ${item.missingGrant}` : ''}${said}`);
  }
  return lines;
}

export async function main(argv = process.argv.slice(2), {
  readFile = (path) => readFileSync(path, 'utf8'), writeFile = writeFileSync, connectFn = connect, getTokenFn = getToken,
  fetchImpl = globalThis.fetch, env = process.env, logger = console, now,
} = {}) {
  const command = argv[0];
  if (!['run', 'show'].includes(command) || argv.includes('--help')) {
    logger.log('usage: keel-discover.mjs run|show [--config FILE] [--db-url URL] [--versions v1.0,beta] [--metadata-dir DIR] [--powershell-commands FILE] [--out FILE] [--no-store] [--tenant-ref REF]');
    return command === undefined || argv.includes('--help') ? 0 : 2;
  }
  const config = JSON.parse(readFile(arg(argv, 'config', '/etc/keel/tenant.json')));
  const tenantRef = tenantRefFor(config.tenantId);
  const requested = arg(argv, 'tenant-ref');
  if (requested !== undefined && requested !== tenantRef) {
    throw new Error('the job names another tenant than the tenant config: refusing to discover');
  }
  const store = command === 'show' || !argv.includes('--no-store');
  const dbUrl = arg(argv, 'db-url', env.KEEL_DB_URL);
  if (store && !dbUrl) throw new Error('KEEL_DB_URL not set (source /etc/keel/db.env, pass --db-url, or use --no-store)');

  if (command === 'show') {
    const client = await connectFn(dbUrl);
    try {
      const run = await loadLatestDiscovery(client, { tenantRef, statuses: ['uncatalogued', 'unreadable'] });
      if (!run) {
        logger.log('Discovery has not run for this tenant yet. Run: keel-discover.mjs run');
        return 1;
      }
      for (const line of describeInventory(run)) logger.log(line);
      return 0;
    } finally {
      await client.end();
    }
  }

  const versions = (arg(argv, 'versions', GRAPH_VERSIONS.join(','))).split(',').map((value) => value.trim()).filter(Boolean);
  for (const version of versions) if (!GRAPH_VERSIONS.includes(version)) throw new Error(`--versions takes ${GRAPH_VERSIONS.join(', ')}`);
  const commandsPath = arg(argv, 'powershell-commands');
  const powershellCommands = commandsPath ? JSON.parse(readFile(commandsPath)) : null;
  if (powershellCommands !== null && (typeof powershellCommands !== 'object' || Array.isArray(powershellCommands))) {
    throw new Error('--powershell-commands must hold an object of module -> cmdlet names');
  }
  // The token's roles say which grants the app holds, so a refusal for one of them is
  // not reported as a missing grant. The token itself is never printed or stored.
  const token = (await getTokenFn(config)).accessToken;
  const graph = readOnlyGraph(async () => token, { fetchImpl });
  const metadata = await loadMetadata(graph, versions, { dir: arg(argv, 'metadata-dir', null), readFile });
  const run = await discover({
    graph, metadata, powershellCommands, heldGrants: tokenRoles(token), ...(now ? { now } : {}),
    pageCap: positive(arg(argv, 'page-cap'), 'page-cap'), concurrency: positive(arg(argv, 'concurrency'), 'concurrency'),
  });
  for (const line of describeInventory(run)) logger.log(line);
  logger.log(`${graph.stats.requests} Graph GET requests, ${graph.stats.throttled} throttled.`);
  const out = arg(argv, 'out');
  if (out) writeFile(out, `${JSON.stringify({ tenantRef, ...run }, null, 2)}\n`);
  if (store) {
    const client = await connectFn(dbUrl);
    try {
      const runId = await saveDiscoveryRun(client, { tenantRef, run });
      logger.log(`Stored discovery run ${runId}.`);
    } finally {
      await client.end();
    }
  }
  return run.sources.some((source) => source.source.startsWith('graph:') && source.status !== 'complete') ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }, (error) => { console.error(error.message ?? error); process.exitCode = 1; });
}
