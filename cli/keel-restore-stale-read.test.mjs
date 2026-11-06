// Issue #1036 (found live in #1031): Graph's /admin/sharepoint/settings answers
// with the old value for a while after a change (the batch-2 SharePoint capture
// read it stale twice before it read fresh). The dry run read the Loop switch
// stale, as in the backup, and left the settings alone; the promotion read it
// fresh and planned an update. The promotion must refuse, and say the target
// changed since the dry run, never that the restore plan no longer matches.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runCli } from './keel-restore.mjs';
import { tenantRefFor } from '../engine/store/tenantRef.mjs';

const testDbUrl = process.env.KEEL_DB_TEST_URL;
assert.ok(testDbUrl, 'KEEL_DB_TEST_URL must be set for restore CLI tests');

const configs = new Map([
  ['/fixtures/restorer.json', JSON.stringify({ tenantId: 'target-tenant', clientId: 'restorer-client', certPath: '/fixtures/restorer.cer', keyPath: '/fixtures/restorer.key' })],
  ['/fixtures/collector.json', JSON.stringify({ tenantId: 'target-tenant', clientId: 'collector-client', certPath: '/fixtures/collector.cer', keyPath: '/fixtures/collector.key' })],
]);
const readFile = (path) => {
  const config = configs.get(path);
  if (!config) throw new Error(`unexpected fixture read: ${path}`);
  return config;
};

const KEY = 'sharepointSettings:sharepointSettings';
// The settings as GET /v1.0/admin/sharepoint/settings answers them (no id).
const BACKUP = Object.freeze({
  allowedDomainGuidsForSyncApp: [], availableManagedPathsForSiteCreation: ['/sites/', '/teams/'],
  deletedUserPersonalSiteRetentionPeriodInDays: 30, excludedFileExtensionsForSyncApp: [],
  idleSessionSignOut: { isEnabled: false, warnAfterInSeconds: 0, signOutAfterInSeconds: 0 },
  imageTaggingOption: 'basic', isCommentingOnSitePagesEnabled: true, isFileActivityNotificationEnabled: true,
  isLegacyAuthProtocolsEnabled: true, isLoopEnabled: false, isMacSyncAppEnabled: true,
  isRequireAcceptingUserToMatchInvitedUserEnabled: true, isResharingByExternalUsersEnabled: false,
  isSharePointMobileNotificationEnabled: true, isSharePointNewsfeedEnabled: false, isSiteCreationEnabled: true,
  isSiteCreationUIEnabled: true, isSitePagesCreationEnabled: true, isSitesStorageLimitAutomatic: true,
  isSyncButtonHiddenOnPersonalSite: false, isUnmanagedSyncAppForTenantRestricted: false,
  personalSiteDefaultStorageLimitInMB: 1048576, sharingAllowedDomainList: [], sharingBlockedDomainList: [],
  sharingCapability: 'externalUserAndGuestSharing', sharingDomainRestrictionMode: 'none',
  siteCreationDefaultManagedPath: '/sites/', siteCreationDefaultStorageLimitInMB: 26214400,
  tenantDefaultTimezone: '(UTC) Coordinated Universal Time',
});
const answer = (settings) => ({ '@odata.context': 'https://graph.microsoft.com/v1.0/$metadata#admin/sharepoint/settings/$entity', ...settings });

/** The restore's fakes. `graph.settings` is what Graph answers right now. */
function fakes(artifacts, graph) {
  const writes = [];
  const client = {
    query: async (sql) => {
      if (/FROM relationship_edge_set/.test(sql)) return { rows: [] };
      if (/recovery_completion_item/.test(sql)) return { rows: [] };
      if (/SELECT tenant_ref FROM snapshot/.test(sql)) return { rows: [{ tenant_ref: 'sha256:issue-1036' }] };
      if (/FROM snapshot WHERE id = \$1 AND tenant_ref = \$2/.test(sql)) return { rows: [] };
      if (/rollback_entry/.test(sql)) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    },
    end: async () => {},
  };
  class Reader {
    async collect(_version, path) {
      if (path === '/admin/sharepoint/settings') return { items: [answer(graph.settings)], pages: 1, status: 200, error: null };
      if (path.startsWith('/roleManagement/directory/roleAssignments')) {
        return { items: [{ id: 'break-glass-role', principalId: 'break-glass-id', roleDefinitionId: '62e90394-69f5-4237-9190-012177145e10', directoryScopeId: '/' }], pages: 1, error: null };
      }
      return { items: [], pages: 1, error: null };
    }
    async get(_version, path) {
      if (path === '/admin/sharepoint/settings') return { ok: true, status: 200, body: answer(graph.settings) };
      if (path === '/policies/authenticationMethodsPolicy') return { ok: true, status: 200, body: { id: 'methods' } };
      if (path === '/policies/identitySecurityDefaultsEnforcementPolicy') return { ok: true, status: 200, body: { id: 'defaults', isEnabled: false } };
      if (path.startsWith('/users/')) return { ok: true, status: 200, body: { id: 'break-glass-id', accountEnabled: true } };
      return { ok: true, status: 200, body: {} };
    }
  }
  class Writer {
    async write(_version, path, options) {
      writes.push({ path, method: options.method, body: options.body });
      return { ok: true, status: 204, body: null };
    }
    async read() { return { ok: true, status: 200, body: answer(graph.settings) }; }
  }
  return {
    writes,
    dependencies: {
      connect: async (url) => {
        assert.equal(url, testDbUrl);
        return client;
      },
      testTenantRefs: [tenantRefFor('target-tenant')],
      getResourceVersions: async () => [{ id: 'v-sharepoint', natural_key: KEY, resource_type: 'sharepointSettings', payload: BACKUP, blast_radius: 'access-affecting' }],
      getReferences: async () => [],
      getToken: async () => ({ accessToken: 'fake-token' }),
      GraphReader: Reader,
      GraphWriter: Writer,
      ThrottleGovernor: class { async acquire() {} },
      createDryRunArtifact: async (_client, fields) => {
        const artifact = { ...fields, createdAt: '2026-11-06T15:00:00.000Z' };
        artifacts.set(fields.id, artifact);
        return artifact;
      },
      getDryRunArtifactById: async (_client, { id }) => artifacts.get(id) ?? null,
    },
  };
}

const run = (argv, dependencies, errors) => runCli({
  argv: ['node', 'keel-restore.mjs', ...argv], readFile, dbUrl: testDbUrl, dependencies,
  logger: { log() {}, error: (error) => errors.push(String(error)) },
});
const dryRun = (id, dependencies, errors) => run([
  '--snapshot-id', 'source-snapshot', '--select', KEY, '--target-config', '/fixtures/restorer.json',
  '--collector-config', '/fixtures/collector.json', '--persist-artifact', id, '--requested-by', 'principal-restorer',
  '--allow-tenant-wide-test-writes',
], dependencies, errors);
const promote = (id, dependencies, errors) => run(['--artifact', id, '--enforce'], dependencies, errors);

test('a dry run that read the SharePoint settings stale is refused at promotion as a changed target, and a new dry run plans the drift', async () => {
  const artifacts = new Map();
  // Loop was switched on live; Graph still answers with the backup's value.
  const graph = { settings: { ...BACKUP } };
  const errors = [];
  const stale = '11111111-0000-4000-8000-000000001036';
  assert.equal(await dryRun(stale, fakes(artifacts, graph).dependencies, errors), 0, errors.join('\n'));
  assert.deepEqual(artifacts.get(stale).plannedVerbs, [{ naturalKey: KEY, verb: 'noop' }]);

  // Graph now answers fresh.
  graph.settings = { ...BACKUP, isLoopEnabled: true };
  const promotion = fakes(artifacts, graph);
  assert.equal(await promote(stale, promotion.dependencies, errors), 1);
  assert.deepEqual(promotion.writes, [], 'nothing the approved plan did not list is written');
  const refusal = errors.join('\n');
  assert.doesNotMatch(refusal, /recomputed restore plan no longer matches/);
  assert.match(refusal, /the target changed since the dry run, so this run would write what the approved plan did not list: sharepointSettings:sharepointSettings update \(dry run: noop\)/);

  // A new dry run from the fresh read plans the Loop drift, and its promotion writes it alone.
  errors.length = 0;
  const fresh = '22222222-0000-4000-8000-000000001036';
  assert.equal(await dryRun(fresh, fakes(artifacts, graph).dependencies, errors), 0, errors.join('\n'));
  assert.deepEqual(artifacts.get(fresh).plannedVerbs, [{ naturalKey: KEY, verb: 'update' }]);
  const second = fakes(artifacts, graph);
  await promote(fresh, second.dependencies, errors);
  assert.doesNotMatch(errors.join('\n'), /no longer matches|target changed|target has changed/);
  assert.deepEqual(second.writes, [{ path: '/admin/sharepoint/settings', method: 'PATCH', body: { isLoopEnabled: false } }]);
});
