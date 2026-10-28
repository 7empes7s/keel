// The `files` subcommand of cli/keel-content-restore.mjs (Wave 2 FILER): restore OneDrive
// and SharePoint files, folders, libraries and lists from the content store.
//
//   keel-content-restore.mjs files plan    SOURCE [restore options]
//   keel-content-restore.mjs files request SOURCE [restore options] --actor PRINCIPAL_ID [--justification TEXT]
//   keel-content-restore.mjs files run     --approval-id ID --actor PRINCIPAL_ID
//
// SOURCE, one of:
//   --drive DRIVE_ID [--site SITE_ID] (--file ITEM_ID | --folder ITEM_ID | --whole-drive)
//                         a OneDrive, or with --site a document library of that site
//   --site SITE_ID --list LIST_ID [--items ID,ID]
// Restore options:
//   --at ISO                         the point in time (default: now, so the backup as it is
//                                    when the plan is made; later backups are never restored)
//   --version VERSION_ID             one file's version (with --file)
//   --target-drive ID [--target-folder PATH]       files to another drive or folder
//   --target-site ID (--target-list ID | --target-list-name NAME)   a list elsewhere
//   --conflict copy|replace|replace-newer          default copy: never overwrite
//   --permissions                    also restore direct sharing grants (files)
//
// plan reads the target through the content-restorer app and writes nothing. request files
// a content-restore approval for exactly that request. run takes the request from the
// approval: the actor must hold content-restore, must be the requester, and someone else
// must have approved it (engine/content/restore/gate.mjs), within 24 hours, and a run that
// completed is never started again. A restore to another drive, folder or list is filed
// as content-restore-other-location, so the tenant's two-person rule for it applies. On the test tenant a restore
// writes only to KEEL-RT- sites and drives. Every Graph call goes through the content
// write transport with a guard that keeps writes inside the target drive or site.
import { readConfigFile } from '../engine/config/configFile.mjs';
import { argvParser } from './args.mjs';
import { requestApproval } from '../engine/govern/approvals.mjs';
import {
  CONTENT_RESTORE_ACTION, CONTENT_RESTORE_OTHER_LOCATION, ContentRestoreRefusedError, authorizeContentRestore, refuseFuturePointInTime, requireContentPolicyAction,
  targetProblems,
} from '../engine/content/restore/gate.mjs';
import { createPgRestoreJournal } from '../engine/content/restore/journal.mjs';
import {
  CONFLICT_MODES, LIST_WORKLOAD, filesRestoreRequest, listRestoreRequest, restoreFiles, restoreList, restoreRunKey,
} from '../engine/content/restore/files.mjs';
import { DEFAULT_RESTORER_PATH, restorerProblems } from './keel-content-restore.mjs';

export const FILES_USAGE = [
  'usage: keel-content-restore.mjs files plan    --drive ID [--site ID] (--file ID | --folder ID | --whole-drive) [options]',
  '       keel-content-restore.mjs files plan    --site ID --list ID [--items ID,ID] [options]',
  '       keel-content-restore.mjs files request (the plan options) --actor PRINCIPAL_ID [--justification TEXT]',
  '       keel-content-restore.mjs files run     --approval-id ID --actor PRINCIPAL_ID',
  '       options: [--at ISO] [--version ID] [--target-drive ID [--target-folder PATH]]',
  '                [--target-site ID (--target-list ID | --target-list-name NAME)] [--conflict copy|replace|replace-newer] [--permissions]',
].join('\n');

// Parsed strictly (cli/args.mjs). The spec names this workload's options and the
// options every content-restore subcommand shares; the action (plan, request, run) is
// the one positional.
export const FILES_ARGS = {
  name: 'keel-content-restore files',
  strings: ['drive', 'site', 'file', 'folder', 'list', 'items', 'at', 'version', 'target-drive', 'target-folder', 'target-site', 'target-list', 'target-list-name', 'conflict', 'actor', 'approval-id', 'config', 'reader', 'restorer', 'db-url'],
  text: ['justification'],
  repeatable: [],
  booleans: ['whole-drive', 'permissions', 'help'],
  positionals: 1,
};
const options = argvParser(FILES_ARGS);

function arg(argv, name, fallback) {
  return options(argv)[name] ?? fallback;
}

/**
 * The file or list restore request the command line names, in canonical shape. Without
 * --at the point in time is now: the approved plan never grows with later backups.
 */
export function filesRequestFromArgs(argv, tenantRef, now = () => new Date()) {
  const at = arg(argv, 'at') ?? now().toISOString();
  const conflict = arg(argv, 'conflict', 'copy');
  if (!CONFLICT_MODES.includes(conflict)) throw new TypeError(`--conflict must be one of ${CONFLICT_MODES.join(', ')}`);
  const siteId = arg(argv, 'site');
  const listId = arg(argv, 'list');
  if (listId !== undefined) {
    if (!siteId) throw new TypeError('--list needs --site');
    const targetSite = arg(argv, 'target-site');
    const targetList = arg(argv, 'target-list');
    const targetListName = arg(argv, 'target-list-name');
    if (targetList !== undefined && targetListName !== undefined) throw new TypeError('--target-list and --target-list-name are exclusive');
    const target = targetSite || targetList || targetListName ? { siteId: targetSite ?? siteId, listId: targetList, listName: targetListName } : null;
    const items = arg(argv, 'items');
    return listRestoreRequest({
      source: { tenantRef, siteId, listId }, at, target, conflict,
      itemIds: items === undefined ? null : items.split(',').map((id) => id.trim()).filter(Boolean),
    });
  }
  const driveId = arg(argv, 'drive');
  if (!driveId) throw new TypeError('name a source: --drive ID (files) or --site ID --list ID (a list)');
  const picked = [['file', arg(argv, 'file')], ['folder', arg(argv, 'folder')], ['drive', options(argv)['whole-drive'] ? true : undefined]]
    .filter(([, value]) => value !== undefined);
  if (picked.length !== 1) throw new TypeError('name exactly one of --file ID, --folder ID or --whole-drive');
  const [kind, itemId] = picked[0];
  // Where the collectors stored it: a library under its site, a OneDrive under its drive.
  const source = siteId
    ? { tenantRef, workload: 'sharepoint-sites', container: `site:${siteId}`, driveId }
    : { tenantRef, workload: 'onedrive', container: `drive:${driveId}`, driveId };
  const targetDrive = arg(argv, 'target-drive');
  const targetFolder = arg(argv, 'target-folder');
  return filesRestoreRequest({
    source, scope: kind === 'drive' ? { kind } : { kind, itemId }, at, version: arg(argv, 'version') ?? null,
    target: targetDrive || targetFolder ? { driveId: targetDrive ?? driveId, folderPath: targetFolder } : null,
    conflict, permissions: options(argv).permissions,
  });
}

/**
 * The transport guard for one request: reads and writes stay inside the target drive (and
 * its site, and the users and groups a sharing grant names) or the target site.
 */
export function requestGuard(request) {
  const id = (value) => decodeURIComponent(value).toLowerCase();
  const toDrive = request.kind === 'files' ? id(request.target?.driveId ?? request.source.driveId) : null;
  const toSite = request.kind === 'list' ? id(request.target?.siteId ?? request.source.siteId) : null;
  return (url, { method, endpoint }) => {
    // A chunk of an upload session the transport opened for this drive (it checks the URL).
    if (endpoint === null) return toDrive && method === 'PUT' ? true : 'an upload chunk outside a file restore';
    const path = id(endpoint.split('?')[0]);
    const under = (prefix) => path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}:`);
    if (toDrive && under(`/drives/${toDrive}`)) return true;
    if (toSite && under(`/sites/${toSite}`)) return true;
    if (method === 'GET' && toDrive && /^\/sites\/[^/]+$/.test(path)) return true;
    if (method === 'GET' && toDrive && request.permissions && /^\/(users|groups)\/[^/]+$/.test(path)) return true;
    return `outside the restore target: ${method} ${path}`;
  };
}

const workloadOf = (request) => (request.kind === 'list' ? LIST_WORKLOAD : request.source.workload);

async function restorerTransport(argv, request, { config, readFile, exists, getTokenFn, fetchImpl, writeTransportFor }) {
  const restorerPath = arg(argv, 'restorer', DEFAULT_RESTORER_PATH);
  if (!exists(restorerPath)) {
    throw new ContentRestoreRefusedError(`file restore is waiting on the content-restorer app (admin consent for content writes): ${restorerPath} does not exist yet; nothing was written`);
  }
  const restorer = readConfigFile(restorerPath, { readFile, what: 'content restorer settings' });
  const readerPath = arg(argv, 'reader', '/etc/keel/content-reader.json');
  const reader = exists(readerPath) ? readConfigFile(readerPath, { readFile, what: 'content backup reader settings' }) : null;
  const problems = restorerProblems(restorer, config, reader);
  if (problems.length) throw new Error(`content restorer file ${restorerPath}: ${problems.join('; ')}`);
  return writeTransportFor(() => getTokenFn(restorer), { guard: requestGuard(request), fetchImpl });
}

/** The engine call for a request, with the CLI's guard (KEEL-RT- on the test tenant). */
function engineCall(request, { tenantRef, testTenantRefs }) {
  const guard = ({ drive = null, site = null }) => {
    const names = [site?.name, site?.displayName, drive?.name, drive?.owner?.user?.displayName];
    const refused = targetProblems({ tenantRef, names, testTenantRefs });
    if (refused.length) throw new ContentRestoreRefusedError(`${refused.join('; ')}; nothing was written`);
    return true;
  };
  return request.kind === 'list'
    ? (deps) => restoreList({ ...deps, guard, source: request.source, at: request.at, target: request.target, itemIds: request.itemIds, conflict: request.conflict })
    : (deps) => restoreFiles({
      ...deps, guard, source: request.source, scope: request.scope, at: request.at, version: request.version,
      target: request.target, conflict: request.conflict, permissions: request.permissions,
    });
}

const brief = (result) => ({
  runId: result.runKey, status: result.status ?? null, dryRun: Boolean(result.dryRun), summary: result.summary, stats: result.stats,
  steps: result.plan.map(({ itemKey, kind, path, source, name, action, outcome, reason, error }) => ({ itemKey, kind, path: path ?? source ?? name ?? null, action, outcome, reason, error })),
});

export async function filesCommand(argv, ctx) {
  const { tenantRef, client, store, testTenantRefs, canFn, logger } = ctx;
  const action = argv[0];
  if (action === 'plan' || action === 'request') {
    const request = filesRequestFromArgs(argv, tenantRef);
    if (action === 'request') refuseFuturePointInTime(request.at);
    const transport = await restorerTransport(argv, request, ctx);
    const planned = await engineCall(request, { tenantRef, testTenantRefs })({ store, transport, dryRun: true, logger });
    if (planned.runKey !== restoreRunKey(request)) throw new Error('the planned run does not match the request');
    if (action === 'plan') {
      logger.log(JSON.stringify(brief(planned), null, 2));
      return 0;
    }
    const filed = await requestApproval(client, {
      tenantRef, action: CONTENT_RESTORE_ACTION, params: { runId: planned.runKey, tenantRef, workload: workloadOf(request), request },
      requestedBy: arg(argv, 'actor'), justification: arg(argv, 'justification') ?? null, executor: 'cli',
      policyActions: planned.summary.otherLocation ? [CONTENT_RESTORE_OTHER_LOCATION] : [],
    });
    logger.log(JSON.stringify({ approvalId: filed.id, ...brief(planned) }, null, 2));
    return 0;
  }
  if (action !== 'run') {
    logger.log(FILES_USAGE);
    return 2;
  }
  const approvalId = arg(argv, 'approval-id');
  const { rows: [approved] } = approvalId
    ? await client.query('SELECT params FROM approval_request WHERE id::text = $1', [approvalId])
    : { rows: [] };
  const held = approved?.params?.request;
  const request = held?.kind === 'list' ? listRestoreRequest(held) : held?.kind === 'files' ? filesRestoreRequest(held) : null;
  if (request && (request.source.tenantRef !== tenantRef || approved.params.runId !== restoreRunKey(request))) {
    throw new ContentRestoreRefusedError(`approval request ${approvalId} is not a file restore of this tenant`);
  }
  // Approved before the point in time was fixed at request time: it would restore
  // whatever the newest backup holds, which nobody reviewed.
  if (request && request.at === null) {
    throw new ContentRestoreRefusedError(`approval request ${approvalId} has no point in time; file a new request`);
  }
  const gate = await authorizeContentRestore(client, {
    actor: arg(argv, 'actor'), approvalId, runId: request ? restoreRunKey(request) : null, tenantRef, ...(canFn ? { canFn } : {}),
  });
  const transport = await restorerTransport(argv, request, ctx);
  const result = await engineCall(request, { tenantRef, testTenantRefs })({
    store, transport, journal: createPgRestoreJournal(client),
    // Authorized above for exactly this run.
    // The engine names the class (another location or not); the approval must cover it.
    gate: async ({ runKey, action: actionClass }) => {
      if (runKey !== restoreRunKey(request)) throw new Error('the run is not the approved one');
      return requireContentPolicyAction(gate, actionClass);
    },
    logger,
  });
  logger.log(JSON.stringify(brief(result), null, 2));
  return result.status === 'completed' ? 0 : 1;
}
