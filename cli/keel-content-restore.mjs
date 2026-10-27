#!/usr/bin/env node
// /opt/keel/cli/keel-content-restore.mjs
//
// Wave 2 content restore. One subcommand per workload: mail is here, files and teams
// (channel messages) are in keel-content-restore-files.mjs and keel-content-restore-teams.mjs.
//
//   node keel-content-restore.mjs mail plan    --source-mailbox USER_ID --at ISO [restore options]
//   node keel-content-restore.mjs mail request --source-mailbox USER_ID --at ISO [restore options] --actor PRINCIPAL_ID [--justification TEXT]
//   node keel-content-restore.mjs mail run     --approval-id ID --actor PRINCIPAL_ID
//
// Restore options:
//   --target-mailbox USER_ID        another mailbox (default: the source mailbox)
//   --into restored-folder|original "Restored <date>" containers (default), or back into the
//                                   original folders of the same mailbox
//   --kinds mail,calendar,contacts,todo
//   --kind KIND --folder ID [--item ID]   one folder (with its subfolders) or one item;
//                                   --folder default is the default contacts folder
// Common: [--config /etc/keel/tenant.json] [--reader /etc/keel/content-reader.json]
//         [--restorer /etc/keel/content-restorer.json] [--db-url $KEEL_DB_URL]
//
// plan reads the content store only and prints what a restore would write. request files a
// content-restore approval request for exactly that plan. run takes everything from the
// approved request: the actor must hold content-restore, must be the requester, and the
// request must have been approved by someone else (engine/content/restore/gate.mjs). On the
// test tenant a restore writes only to KEEL-RT- mailboxes. Every write goes through the
// content write transport as the content-restorer app, a separate app registration:
//   { "tenantId": "...", "clientId": "...", "certPath": "...", "keyPath": "..." }
// The run is journaled (schema.d/72-content-restore.sql): running the same request again
// resumes it and writes nothing already restored.
import { existsSync, readFileSync } from 'node:fs';
import { readConfigFile } from '../engine/config/configFile.mjs';
import { pathToFileURL } from 'node:url';

import { getToken } from '../tools/tenant-probe/auth.mjs';
import { TEST_TENANT_REFS } from '../tools/qualification/entraLive.mjs';
import { connect } from '../engine/store/db.mjs';
import { tenantRefFor } from '../engine/store/tenantRef.mjs';
import { createLocalStorageAdapter } from '../engine/storage/local.mjs';
import { createPgContentIndex } from '../engine/content/index.mjs';
import { createContentStore, parseContentKey } from '../engine/content/store.mjs';
import { requestApproval } from '../engine/govern/approvals.mjs';
import { seg } from '../engine/content/exchangeMail.mjs';
import { CONTENT_RESTORE_ACTION, ContentRestoreRefusedError, authorizeContentRestore, targetProblems } from '../engine/content/restore/gate.mjs';
import { createPgRestoreJournal } from '../engine/content/restore/journal.mjs';
import { contentWriteTransport } from '../engine/content/restore/transport.mjs';
import { GRAPH_ROOT, MAIL_RESTORE_KINDS, mailRestoreRunId, normalizeMailRestoreRequest, planMailRestore, restoreMail } from '../engine/content/restore/mail.mjs';
import { DEFAULT_READER_PATH, readerProblems } from './keel-content-collect.mjs';
import { filesCommand } from './keel-content-restore-files.mjs';
import { teamsCommand } from './keel-content-restore-teams.mjs';

export const DEFAULT_RESTORER_PATH = '/etc/keel/content-restorer.json';

function arg(argv, name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i > -1 ? argv[i + 1] : fallback;
}

const USAGE = [
  'usage: keel-content-restore.mjs mail plan    --source-mailbox USER_ID --at ISO [--target-mailbox USER_ID] [--into restored-folder|original] [--kinds LIST] [--kind KIND --folder ID [--item ID]]',
  '       keel-content-restore.mjs mail request (the plan options) --actor PRINCIPAL_ID [--justification TEXT]',
  '       keel-content-restore.mjs mail run     --approval-id ID --actor PRINCIPAL_ID',
  '       keel-content-restore.mjs files help | teams help   (file and Teams message restores)',
  '       common: [--config /etc/keel/tenant.json] [--reader FILE] [--restorer FILE] [--db-url URL]',
].join('\n');

/** The mail restore request the command line names. */
export function mailRequestFromArgs(argv, tenantRef) {
  const kind = arg(argv, 'kind');
  const folderId = arg(argv, 'folder');
  if ((kind === undefined) !== (folderId === undefined)) throw new TypeError('--kind and --folder go together');
  if (arg(argv, 'item') !== undefined && folderId === undefined) throw new TypeError('--item needs --kind and --folder');
  return normalizeMailRestoreRequest({
    tenantRef,
    sourceMailboxId: arg(argv, 'source-mailbox'),
    targetMailboxId: arg(argv, 'target-mailbox'),
    at: arg(argv, 'at'),
    into: arg(argv, 'into', 'restored-folder'),
    kinds: arg(argv, 'kinds') === undefined ? MAIL_RESTORE_KINDS : arg(argv, 'kinds').split(',').map((kind) => kind.trim()),
    selection: kind === undefined ? null : { kind, folderId, itemKey: arg(argv, 'item') ?? null },
  });
}

/** Problems with the restorer file: same tenant, its own app, nothing else. */
export function restorerProblems(restorer, config, reader) {
  const problems = [];
  if (restorer?.tenantId !== config.tenantId) problems.push('the restorer file names another tenant than the tenant config');
  if (typeof restorer?.clientId !== 'string' || !restorer.clientId) problems.push('the restorer file needs the content-restorer clientId');
  else if (restorer.clientId === config.clientId || restorer.clientId === reader?.clientId) {
    problems.push('the content restorer must be its own app registration, not the collector or the content reader');
  }
  for (const key of ['certPath', 'keyPath']) if (typeof restorer?.[key] !== 'string' || !restorer[key]) problems.push(`the restorer file needs ${key}`);
  return problems;
}

/** The content write transport, with this run's target guard. */
async function defaultWriteTransport(tokenSource, { guard, fetchImpl }) {
  return contentWriteTransport(tokenSource, fetchImpl, { guard });
}

const summarize = (plan) => ({
  runId: plan.runId,
  request: plan.request,
  containers: plan.containers.length,
  items: Object.fromEntries(MAIL_RESTORE_KINDS.map((kind) => [kind, plan.items.filter((item) => item.kind === kind).length])),
  notRestorable: plan.skipped,
});

async function mailCommand(argv, { config, tenantRef, client, store, readFile, exists, getTokenFn, fetchImpl, writeTransportFor, testTenantRefs, canFn, logger }) {
  const action = argv[0];
  if (action === 'plan') {
    const plan = await planMailRestore(store, mailRequestFromArgs(argv, tenantRef));
    logger.log(JSON.stringify(summarize(plan), null, 2));
    return 0;
  }
  if (action === 'request') {
    const request = mailRequestFromArgs(argv, tenantRef);
    const plan = await planMailRestore(store, request);
    const filed = await requestApproval(client, {
      tenantRef, action: CONTENT_RESTORE_ACTION, params: { runId: plan.runId, tenantRef, workload: 'mail', request },
      requestedBy: arg(argv, 'actor'), justification: arg(argv, 'justification') ?? null, executor: 'cli',
    });
    logger.log(JSON.stringify({ approvalId: filed.id, ...summarize(plan) }, null, 2));
    return 0;
  }
  if (action !== 'run') {
    logger.log(USAGE);
    return 2;
  }
  const approvalId = arg(argv, 'approval-id');
  const { rows: [approved] } = approvalId
    ? await client.query('SELECT params FROM approval_request WHERE id::text = $1', [approvalId])
    : { rows: [] };
  const request = approved?.params?.request ? normalizeMailRestoreRequest(approved.params.request) : null;
  if (request && (request.tenantRef !== tenantRef || approved.params.runId !== mailRestoreRunId(request))) {
    throw new ContentRestoreRefusedError(`approval request ${approvalId} is not a mail restore of this tenant`);
  }
  const gate = await authorizeContentRestore(client, {
    actor: arg(argv, 'actor'), approvalId, runId: request ? mailRestoreRunId(request) : null, tenantRef, ...(canFn ? { canFn } : {}),
  });
  const restorerPath = arg(argv, 'restorer', DEFAULT_RESTORER_PATH);
  if (!exists(restorerPath)) {
    throw new ContentRestoreRefusedError(`mail restore is waiting on the content-restorer app (admin consent for content writes): ${restorerPath} does not exist yet; nothing was written`);
  }
  const restorer = readConfigFile(restorerPath, { readFile, what: 'content restorer settings' });
  const reader = exists(arg(argv, 'reader', DEFAULT_READER_PATH)) ? readConfigFile(arg(argv, 'reader', DEFAULT_READER_PATH), { readFile, what: 'content backup reader settings' }) : null;
  const problems = restorerProblems(restorer, config, reader);
  if (problems.length) throw new Error(`content restorer file ${restorerPath}: ${problems.join('; ')}`);

  const owner = `/users/${seg(request.targetMailboxId)}`;
  const guard = (url) => {
    const path = decodeURIComponent(new URL(url).pathname).replace(/^\/(v1\.0|beta)/, '');
    if (path !== owner && !path.startsWith(`${owner}/`)) throw new ContentRestoreRefusedError(`refused a request outside the target mailbox: ${url}`);
  };
  const transport = await writeTransportFor(() => getTokenFn(restorer), { guard, fetchImpl });
  const found = await transport(`${GRAPH_ROOT}${owner}?$select=id,displayName,mail,userPrincipalName`, { method: 'GET' });
  if (found?.status !== 200 || found.body?.id !== request.targetMailboxId) {
    throw new Error(`the target mailbox ${request.targetMailboxId} could not be read: ${found?.status ?? 'no answer'}`);
  }
  const names = [found.body.displayName, found.body.mail, found.body.userPrincipalName];
  const refused = targetProblems({ tenantRef, names, testTenantRefs });
  if (refused.length) throw new ContentRestoreRefusedError(`${refused.join('; ')}; nothing was written`);

  const plan = await planMailRestore(store, request);
  const report = await restoreMail({
    store, transport, journal: createPgRestoreJournal(client), plan, target: { id: request.targetMailboxId, names },
    actor: gate.actor, approvedBy: gate.approvedBy, logger,
  });
  logger.log(JSON.stringify(report, null, 2));
  return report.status === 'completed' ? 0 : 1;
}

// One line per workload. `files` and `teams` live in their own modules.
export const SUBCOMMANDS = Object.freeze({ mail: mailCommand, files: filesCommand, teams: teamsCommand });

export async function main(argv = process.argv.slice(2), {
  readFile = (path) => readFileSync(path, 'utf8'), exists = existsSync, connectFn = connect, getTokenFn = getToken,
  fetchImpl = globalThis.fetch, env = process.env, logger = console, writeTransportFor = defaultWriteTransport,
  testTenantRefs = TEST_TENANT_REFS, subcommands = SUBCOMMANDS, canFn = null,
  openStore = (reader, client) => createContentStore({
    index: createPgContentIndex(client), storage: createLocalStorageAdapter({ root: reader.storage.root }),
    key: parseContentKey(readFile(reader.contentKeyFile)),
  }),
} = {}) {
  const command = subcommands[argv[0]];
  if (!command || argv.includes('--help') || !argv[1]) {
    logger.log(USAGE);
    return argv.length === 0 || argv.includes('--help') ? 0 : 2;
  }
  const config = readConfigFile(arg(argv, 'config', '/etc/keel/tenant.json'), { readFile, what: 'collector settings' });
  const tenantRef = tenantRefFor(config.tenantId);
  const readerPath = arg(argv, 'reader', DEFAULT_READER_PATH);
  if (!exists(readerPath)) throw new Error(`content restore reads the content store named in ${readerPath}, which does not exist yet`);
  const reader = readConfigFile(readerPath, { readFile, what: 'content backup reader settings' });
  const problems = readerProblems(reader, config);
  if (problems.length) throw new Error(`content reader file ${readerPath}: ${problems.join('; ')}`);
  const dbUrl = arg(argv, 'db-url', env.KEEL_DB_URL);
  if (!dbUrl) throw new Error('KEEL_DB_URL not set (source /etc/keel/db.env or pass --db-url)');
  const client = await connectFn(dbUrl);
  try {
    const store = openStore(reader, client);
    return await command(argv.slice(1), { config, tenantRef, client, store, readFile, exists, getTokenFn, fetchImpl, writeTransportFor, testTenantRefs, canFn, logger });
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }, (error) => { console.error(error.message ?? error); process.exitCode = 1; });
}
