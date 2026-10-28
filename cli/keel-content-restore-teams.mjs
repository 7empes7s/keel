// The `teams` subcommand of cli/keel-content-restore.mjs: restore a Teams channel's
// messages into a new channel through Microsoft's message import API
// (engine/content/restore/teamsMessages.mjs).
//
//   keel-content-restore.mjs teams plan    --team TEAM_ID --channel CHANNEL_ID [options]
//   keel-content-restore.mjs teams request --team TEAM_ID --channel CHANNEL_ID [options] --actor PRINCIPAL_ID [--justification TEXT]
//   keel-content-restore.mjs teams run     --approval-id ID --actor PRINCIPAL_ID [--fixture FILE]
//   keel-content-restore.mjs teams fixture --author USER_ID --author USER_ID [--channel-name NAME]
//
// Options:
//   --at ISO                 the point in time (default: now, the latest backup)
//   --target-team TEAM_ID    restore into another team (default: the source team)
//   --fallback-author USER_ID   posts the messages of authors who left the tenant, with
//                            "Originally posted by <name>" on top
//   --fixture FILE           test tenant only: read the messages from a fixture file
//                            (`teams fixture` prints one) instead of the content store
//
// plan reads the content store (or the fixture) only. request files a content-restore
// approval for exactly that plan. run takes the request from the approval: the actor must
// hold content-restore, must be the requester, and someone else must have approved it
// (engine/content/restore/gate.mjs). On the test tenant a restore writes only into
// KEEL-RT- teams. Every call goes through the content write transport as the
// content-restorer app, which needs `Teamwork.Migrate.All` (application) for the import,
// `Channel.ReadBasic.All` and `Team.ReadBasic.All` to find the team and channel, and
// `User.Read.All` to check authors.
import { readConfigFile } from '../engine/config/configFile.mjs';
import { requestApproval } from '../engine/govern/approvals.mjs';
import { canonicalDigest } from '../engine/restore/dryRunArtifact.mjs';
import {
  CONTENT_RESTORE_ACTION, CONTENT_RESTORE_OTHER_LOCATION, ContentRestoreRefusedError, authorizeContentRestore, refuseFuturePointInTime, targetProblems,
} from '../engine/content/restore/gate.mjs';
import { createPgRestoreJournal } from '../engine/content/restore/journal.mjs';
import {
  GRAPH_ROOT, TEAMS_MESSAGES_WORKLOAD, normalizeTeamsMessagesRequest, planTeamsMessageRestore, restoreTeamsMessages,
  teamsMessageFixture, teamsMessagesRunId,
} from '../engine/content/restore/teamsMessages.mjs';
import { DEFAULT_RESTORER_PATH, restorerProblems } from './keel-content-restore.mjs';

export const TEAMS_USAGE = [
  'usage: keel-content-restore.mjs teams plan    --team ID --channel ID [--at ISO] [--target-team ID] [--fallback-author USER_ID] [--fixture FILE]',
  '       keel-content-restore.mjs teams request (the plan options) --actor PRINCIPAL_ID [--justification TEXT]',
  '       keel-content-restore.mjs teams run     --approval-id ID --actor PRINCIPAL_ID [--fixture FILE]',
  '       keel-content-restore.mjs teams fixture --author USER_ID --author USER_ID [--channel-name NAME]',
].join('\n');

function arg(argv, name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i > -1 ? argv[i + 1] : fallback;
}
const args = (argv, name) => argv.flatMap((value, i) => (value === `--${name}` ? [argv[i + 1]] : []));

/** The fixture file the command line names, parsed; only on the test tenant. */
function fixtureFrom(argv, { tenantRef, testTenantRefs, readFile }) {
  const path = arg(argv, 'fixture');
  if (path === undefined) return null;
  if (!testTenantRefs.includes(tenantRef)) throw new ContentRestoreRefusedError('a fixture file can only be restored on the test tenant');
  return readConfigFile(path, { readFile, what: 'Teams message fixture' });
}

/** The Teams message restore request the command line names. */
export function teamsRequestFromArgs(argv, tenantRef, fixture = null, now = () => new Date()) {
  return normalizeTeamsMessagesRequest({
    tenantRef,
    sourceTeamId: arg(argv, 'team'),
    sourceChannelId: arg(argv, 'channel'),
    targetTeamId: arg(argv, 'target-team'),
    at: arg(argv, 'at', now().toISOString()),
    fallbackAuthorId: arg(argv, 'fallback-author', null),
    fixture: fixture ? { sha256: canonicalDigest(fixture) } : null,
  });
}

/** Reads and writes stay inside the target team; authors are only read. */
export function teamsGuard(request) {
  const team = `/teams/${request.targetTeamId}`;
  return (url, { method, endpoint }) => {
    if (endpoint === null) return 'an upload chunk outside a file restore';
    const path = decodeURIComponent(endpoint.split('?')[0]).toLowerCase();
    if (path === team || path.startsWith(`${team}/`)) return true;
    if (method === 'GET' && /^\/users\/[^/]+$/.test(path)) return true;
    return `outside the restore target: ${method} ${path}`;
  };
}

/** The approval-policy classes of a Teams message restore: another team is another location. */
export const teamsPolicyActions = (request) => (request.targetTeamId !== request.sourceTeamId ? [CONTENT_RESTORE_OTHER_LOCATION] : []);

const summarize = (plan) => ({
  runId: plan.runId,
  request: plan.request,
  channel: plan.channel.displayName,
  threads: plan.threads.length,
  messages: plan.messages,
  skipped: plan.skipped,
});

export async function teamsCommand(argv, ctx) {
  const { tenantRef, client, store, readFile, exists, getTokenFn, fetchImpl, writeTransportFor, testTenantRefs, canFn, logger, config } = ctx;
  const action = argv[0];
  if (action === 'fixture') {
    logger.log(JSON.stringify(teamsMessageFixture({ authors: args(argv, 'author'), channelName: arg(argv, 'channel-name', 'KEEL-RT-import-proof') }), null, 2));
    return 0;
  }
  if (action === 'plan' || action === 'request') {
    const fixture = fixtureFrom(argv, { tenantRef, testTenantRefs, readFile });
    const request = teamsRequestFromArgs(argv, tenantRef, fixture);
    if (action === 'request') refuseFuturePointInTime(request.at);
    const plan = await planTeamsMessageRestore(store, request, { fixture });
    if (action === 'plan') {
      logger.log(JSON.stringify(summarize(plan), null, 2));
      return 0;
    }
    const filed = await requestApproval(client, {
      tenantRef, action: CONTENT_RESTORE_ACTION, params: { runId: plan.runId, tenantRef, workload: TEAMS_MESSAGES_WORKLOAD, request },
      requestedBy: arg(argv, 'actor'), justification: arg(argv, 'justification') ?? null, executor: 'cli',
      policyActions: teamsPolicyActions(request),
    });
    logger.log(JSON.stringify({ approvalId: filed.id, ...summarize(plan) }, null, 2));
    return 0;
  }
  if (action !== 'run') {
    logger.log(TEAMS_USAGE);
    return 2;
  }
  const approvalId = arg(argv, 'approval-id');
  const { rows: [approved] } = approvalId
    ? await client.query('SELECT params FROM approval_request WHERE id::text = $1', [approvalId])
    : { rows: [] };
  const request = approved?.params?.workload === TEAMS_MESSAGES_WORKLOAD && approved.params.request
    ? normalizeTeamsMessagesRequest(approved.params.request) : null;
  if (approvalId && approved && (!request || request.tenantRef !== tenantRef || approved.params.runId !== teamsMessagesRunId(request))) {
    throw new ContentRestoreRefusedError(`approval request ${approvalId} is not a Teams message restore of this tenant`);
  }
  const gate = await authorizeContentRestore(client, {
    actor: arg(argv, 'actor'), approvalId, runId: request ? teamsMessagesRunId(request) : null, tenantRef, ...(canFn ? { canFn } : {}),
    policyActions: request ? teamsPolicyActions(request) : [],
  });
  const fixture = request.fixture ? fixtureFrom(argv, { tenantRef, testTenantRefs, readFile }) : null;
  if (request.fixture && !fixture) throw new ContentRestoreRefusedError('this restore was planned from a fixture file; pass the same --fixture file');
  const restorerPath = arg(argv, 'restorer', DEFAULT_RESTORER_PATH);
  if (!exists(restorerPath)) {
    throw new ContentRestoreRefusedError(`Teams message restore is waiting on the content-restorer app (admin consent for content writes): ${restorerPath} does not exist yet; nothing was written`);
  }
  const restorer = readConfigFile(restorerPath, { readFile, what: 'content restorer settings' });
  const readerPath = arg(argv, 'reader', '/etc/keel/content-reader.json');
  const reader = exists(readerPath) ? readConfigFile(readerPath, { readFile, what: 'content backup reader settings' }) : null;
  const problems = restorerProblems(restorer, config, reader);
  if (problems.length) throw new Error(`content restorer file ${restorerPath}: ${problems.join('; ')}`);

  const plan = await planTeamsMessageRestore(store, request, { fixture });
  const transport = await writeTransportFor(() => getTokenFn(restorer), { guard: teamsGuard(request), fetchImpl });
  const found = await transport(`${GRAPH_ROOT}/teams/${request.targetTeamId}?$select=id,displayName`, { method: 'GET' });
  if (found?.status !== 200 || String(found.body?.id ?? '').toLowerCase() !== request.targetTeamId) {
    throw new Error(`the target team ${request.targetTeamId} could not be read: ${found?.status ?? 'no answer'}`);
  }
  const refused = targetProblems({ tenantRef, names: [found.body.displayName], testTenantRefs });
  if (refused.length) throw new ContentRestoreRefusedError(`${refused.join('; ')}; nothing was written`);

  const report = await restoreTeamsMessages({
    transport, journal: createPgRestoreJournal(client), plan, target: { id: request.targetTeamId, displayName: found.body.displayName },
    actor: gate.actor, approvedBy: gate.approvedBy, logger,
  });
  logger.log(JSON.stringify(report, null, 2));
  return report.status === 'completed' ? 0 : 1;
}
