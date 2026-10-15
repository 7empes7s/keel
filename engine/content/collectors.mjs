/**
 * The content collector registry: every collector `keel-content-collect run` runs, in
 * run order (Wave 1 CONT).
 *
 * An entry is { workload, collect }:
 * - workload is one of CONTENT_WORKLOADS in ./store.mjs.
 * - collect(client, { tenantRef, tenantId, store, transport, scope, sleep, now, logger, syncState? })
 *   backs up one workload and returns { outcome: 'succeeded' | 'partial' | 'failed', items,
 *   bytes, reasons }. `store` is the content store (putItem, getItem, listItems), `transport`
 *   the read-only content transport (./transport.mjs), `scope` the content scope file.
 *   Delta state lives in content_sync_state (./syncState.mjs); `syncState` replaces it in tests.
 *   A collector never writes to the tenant.
 *
 * The scope file (/etc/keel/content-scope.json) is optional:
 *   { "namePrefix": "KEEL-RT-", "tenantHost": "contoso.sharepoint.com" }
 * namePrefix narrows mailboxes, OneDrives, sites and groups to names starting with it;
 * Teams has no name filter and reads every team. tenantHost is found from /sites/root
 * when it is not given.
 *
 * SharePoint sites run before Teams in the same run. Teams records a channel's files as
 * covered by its team site only when the sites collector has read that site's library in
 * full (a `covered:` marker in the sync state, with when); otherwise as unconfirmed.
 */
import { backupMailboxes, discoverMailboxes } from './mailboxes.mjs';
import { backupOneDrives } from './onedrives.mjs';
import { backupSharePointSites } from './sharepointSites.mjs';
import { backupTeams } from './teams.mjs';
import { backupPlannerAndConversations } from './planner.mjs';
import { GRAPH_ORIGIN, graphTransport, mailReader } from './collectorTransports.mjs';
import { createPgSyncState } from './syncState.mjs';

const OUTCOMES = { complete: 'succeeded', 'complete-empty': 'succeeded', partial: 'partial', failed: 'failed' };
const errorText = (error) => String(error?.message ?? error);

/** The content store, counting what each collector put. */
function counted(store) {
  const tally = { items: 0, bytes: 0 };
  const wrapped = Object.freeze({
    getItem: (ref) => store.getItem(ref),
    listItems: (query) => store.listItems(query),
    async putItem(source, meta) {
      const result = await store.putItem(source, meta);
      tally.items += 1;
      tally.bytes += result?.bytes ?? 0;
      return result;
    },
  });
  return { store: wrapped, tally };
}

const stateFor = (client, context) => context.syncState ?? createPgSyncState(client);
const prefixOf = (scope) => (typeof scope?.namePrefix === 'string' && scope.namePrefix ? scope.namePrefix : null);

async function collectMail(client, context) {
  const { tenantRef, transport, scope, sleep, now } = context;
  const syncState = stateFor(client, context);
  const { store, tally } = counted(context.store);
  const reader = mailReader(transport, { sleep });
  const found = await discoverMailboxes(reader, { match: prefixOf(scope) });
  const reasons = found.errors.map((error) => `${error.route}${error.id ? ` ${error.id}` : ''}: ${error.error}`);
  let ok = 0;
  for (const mailbox of found.mailboxes) {
    const ref = { tenantRef, workload: 'exchange-mail', key: mailbox.key };
    try {
      const previous = await syncState.load(ref);
      const result = await backupMailboxes(reader, store, {
        tenantRef, mailboxes: [mailbox], state: previous ? { [mailbox.key]: previous } : {},
        now: () => now().toISOString(),
      });
      await syncState.save({ ...ref, state: result.state[mailbox.key] ?? null });
      const report = result.mailboxes[0];
      if (report?.ok) ok += 1;
      else {
        const errors = [...(report?.mail?.errors ?? []), ...(report?.items?.errors ?? [])];
        reasons.push(`${mailbox.name} (${mailbox.kind}): ${errors.length} read(s) failed${errors[0]?.error ? ` (${errors[0].error})` : ''}`);
      }
    } catch (error) {
      reasons.push(`${mailbox.name} (${mailbox.kind}): ${errorText(error)}`);
    }
  }
  const failedAll = found.mailboxes.length > 0 ? ok === 0 : found.errors.length > 0;
  const outcome = reasons.length === 0 ? 'succeeded' : failedAll ? 'failed' : 'partial';
  return { outcome, ...tally, reasons };
}

async function collectOneDrives(client, context) {
  const { tenantRef, transport, scope, sleep, now } = context;
  const { store, tally } = counted(context.store);
  const result = await backupOneDrives({ transport, store, tenantRef, syncState: stateFor(client, context), namePrefix: prefixOf(scope), sleep, now });
  const reasons = [
    ...result.errors.map((error) => `${error.name ?? error.step}: ${error.error}`),
    ...result.drives.filter((drive) => drive.outcome === 'partial').map((drive) => `${drive.name}: ${drive.stats.warnings.length} file warning(s), first: ${drive.stats.warnings[0].warning}`),
  ];
  return { outcome: result.outcome, ...tally, reasons };
}

async function tenantHostOf(send, scope) {
  if (typeof scope?.tenantHost === 'string' && scope.tenantHost) return scope.tenantHost;
  const response = await send(`${GRAPH_ORIGIN}/v1.0/sites/root?$select=siteCollection`);
  const host = response?.body?.siteCollection?.hostname;
  if (!(response?.status >= 200 && response.status < 300) || typeof host !== 'string') {
    throw new Error(`could not find the tenant's SharePoint host (GET /sites/root answered HTTP ${response?.status})`);
  }
  return host;
}

async function collectSites(client, context) {
  const { tenantRef, transport, scope, sleep, now } = context;
  const syncState = stateFor(client, context);
  const { store, tally } = counted(context.store);
  const send = graphTransport(transport);
  const prefix = prefixOf(scope);
  const libraryKey = ({ siteId, listId, driveId }) => ({ tenantRef, workload: 'sharepoint-sites', key: `library:${siteId}/${listId}/${driveId}` });
  const result = await backupSharePointSites({
    transport: send, store, tenantRef, tenantHost: await tenantHostOf(send, scope), sleep, now,
    siteFilter: prefix ? (site) => [site.displayName, site.name].some((name) => typeof name === 'string' && name.toLowerCase().startsWith(prefix.toLowerCase())) : undefined,
    libraryState: {
      load: (where) => syncState.load(libraryKey(where)),
      save: ({ state, ...where }) => syncState.save({ ...libraryKey(where), state }),
    },
  });
  const reasons = [];
  if (result.discovery?.status !== 'observed') reasons.push(`site discovery: ${result.discovery?.error ?? result.discovery?.status}`);
  if (result.capped) reasons.push('more sites than one run reads; the rest was not read');
  for (const site of result.sites ?? []) {
    // A library's file sync is one of its list's reads.
    const parts = [
      ...Object.entries(site.reads ?? {}),
      ...(site.lists ?? []).flatMap((list) => Object.entries(list.reads ?? {}).map(([name, read]) => [`${list.displayName ?? list.listId} ${name}`, read])),
    ].filter(([, read]) => read?.status !== 'observed');
    // A library sync that finished with file warnings reads as observed but is partial.
    for (const list of site.lists ?? []) {
      if (list.library && list.library.status !== 'observed' && list.reads?.library?.status === 'observed') {
        const warning = list.library.result?.stats?.warnings?.[0];
        parts.push([`${list.displayName ?? list.listId} library files`, { status: list.library.status, error: warning ? `${list.library.result.stats.warnings.length} file warning(s), first: ${warning.warning}` : null }]);
      }
    }
    if (parts.length) {
      const [name, read] = parts[0];
      reasons.push(`${site.displayName ?? site.webUrl ?? site.siteId}: ${parts.length} part(s) not fully read, first ${name}: ${read?.status}${read?.error ? ` (${read.error})` : ''}`);
    }
    // Record which libraries this run read in full, so Teams can point at them.
    for (const list of site.lists ?? []) {
      if (list.library?.status === 'observed' && list.library.driveId) {
        await syncState.save({ ...coverageKey(tenantRef, site.siteId, list.library.driveId), state: { lastSyncedAt: now().toISOString() } });
      }
    }
  }
  return { outcome: OUTCOMES[result.outcome] ?? 'failed', ...tally, reasons };
}

// The marker the sites collector saves for a library it read in full.
const coverageKey = (tenantRef, siteId, driveId) => ({ tenantRef, workload: 'sharepoint-sites', key: `covered:${siteId}/${driveId}` });

/**
 * Teams channel folders live in their team site's library. A folder is recorded as
 * covered by the site only when the sites collector has read that library in full;
 * otherwise the answer is null and Teams records the folder as unconfirmed.
 */
function siteCoverage(tenantRef, syncState) {
  return Object.freeze({
    async backupDriveFolder({ siteId, driveId, itemId }) {
      if (!siteId || !driveId) return null;
      const covered = await syncState.load(coverageKey(tenantRef, siteId, driveId));
      if (!covered?.lastSyncedAt) return null;
      return { coveredBy: `site:${siteId}`, driveId, itemId: itemId ?? null, lastSyncedAt: covered.lastSyncedAt };
    },
  });
}

async function collectTeams(client, context) {
  const { tenantRef, tenantId, transport, sleep, now } = context;
  const { store, tally } = counted(context.store);
  const sites = siteCoverage(tenantRef, stateFor(client, context));
  const result = await backupTeams({ transport: graphTransport(transport), tenantId, tenantRef, store, sites, sleep, now });
  const reasons = [];
  if (result.discovery?.status !== 'observed') reasons.push(`team discovery: ${result.discovery?.error ?? result.discovery?.status}`);
  if (result.discovery?.capped) reasons.push('more teams than one run reads; the rest was not read');
  for (const team of result.teams ?? []) {
    const parts = [
      ['team settings', team.settings], ['installed apps', team.installedApps], ['channel list', team.channels],
      ...(team.channels?.items ?? []).flatMap((item) => {
        const channel = `channel ${item.fields?.displayName ?? item.channelId}`;
        return [[`${channel} settings`, item.settings], [`${channel} members`, item.members], [`${channel} tabs`, item.tabs], [`${channel} files`, item.files]];
      }),
    ].filter(([, read]) => read?.status === 'denied' || read?.status === 'failed');
    if (parts.length) {
      const [name, read] = parts[0];
      reasons.push(`${team.fields?.displayName ?? team.teamId}: ${parts.length} part(s) not read, first ${name}: ${read.status}${read.error ? ` (${read.error})` : ''}`);
    }
  }
  return { outcome: OUTCOMES[result.outcome] ?? 'failed', ...tally, reasons };
}

async function collectPlanner(client, context) {
  const { tenantRef, transport, scope, sleep, now } = context;
  const { store, tally } = counted(context.store);
  const result = await backupPlannerAndConversations({
    transport: graphTransport(transport), contentStore: store, tenantRef, namePrefix: prefixOf(scope), sleep, now,
  });
  const reasons = [];
  if (result.discovery?.status && result.discovery.status !== 'observed') reasons.push(`group discovery: ${result.discovery.error ?? result.discovery.status}`);
  if (result.capped) reasons.push('more groups than one run reads; the rest was not read');
  for (const group of result.unreachable ?? []) reasons.push(`group ${group.groupId}: ${group.error}`);
  for (const group of result.groups ?? []) {
    for (const [part, section] of [['Planner', group.planner], ['conversations', group.conversations]]) {
      if (section?.status && section.status !== 'observed') reasons.push(`${group.displayName ?? group.groupId} ${part}: ${section.status}${section.errors?.[0]?.error ? ` (${section.errors[0].error})` : ''}`);
    }
  }
  return { outcome: OUTCOMES[result.outcome] ?? 'failed', ...tally, reasons };
}

export const CONTENT_COLLECTORS = Object.freeze([
  Object.freeze({ workload: 'exchange-mail', collect: collectMail }),
  Object.freeze({ workload: 'onedrive', collect: collectOneDrives }),
  Object.freeze({ workload: 'sharepoint-sites', collect: collectSites }),
  Object.freeze({ workload: 'teams', collect: collectTeams }),
  Object.freeze({ workload: 'planner', collect: collectPlanner }),
]);
