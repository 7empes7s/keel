/** Task-131 boundary coverage: the Protect page and the restore wizard in plain words.
 * Real engine collection and schedules in an isolated database, then the real portal
 * loaders, authorization and page render in a separate portal runtime. Only the
 * database URL and tenant config are replaced. No live Microsoft calls or writers.
 */
import { strict as assert } from 'node:assert';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';

import { grantRole } from '../authz/administration.mjs';
import { collectSnapshot } from '../collect/snapshot.mjs';
import { seedSchedules } from '../store/scheduleSeed.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
after(async () => { await database.cleanup(); });

// group succeeds, roleAssignment is denied (a failed type the page must name),
// namedLocation succeeds empty; everything else succeeds with nothing in it.
const reader = {
  async collect(_version, path) {
    if (path.startsWith('/groups?')) return { items: [{ id: 'g1', mailNickname: 'group-1' }], pages: 1, status: 200, error: null };
    if (path === '/roleManagement/directory/roleAssignments') {
      return { items: [], pages: 0, error: { status: 403, code: 'Error_AccessDenied', error: 'denied' } };
    }
    if (path === '/identity/conditionalAccess/policies') {
      return { items: [{ id: 'cap1', displayName: 'Block legacy auth' }], pages: 1, status: 200, error: null };
    }
    return { items: [], pages: 1, status: 200, error: null };
  },
};

// Run a script in the portal's own TypeScript runtime, against this test's database.
function inPortal(script, env) {
  const result = spawnSync(process.execPath, ['--require', 'tsx/cjs', '-e', String.raw`
    const assert = require('node:assert/strict');
    globalThis.AsyncLocalStorage = require('node:async_hooks').AsyncLocalStorage;
    const { createElement } = require('react');
    const { renderToStaticMarkup } = require('react-dom/server');
    const { AppRouterContext } = require('next/dist/shared/lib/app-router-context.shared-runtime');
    const router = { push() {}, replace() {}, refresh() {}, prefetch() {}, back() {}, forward() {} };
    const withRouter = (element) => renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: router }, element));
    // The text a person reads outside the record layer: every record disclosure removed,
    // then every tag, so attribute values never count as visible text.
    const visibleText = (html) => html
      .replace(/<details class="technical-details" data-layer="record">[\s\S]*?<\/details>/g, '\n')
      .replace(/<[^>]+>/g, '\n');
    const BANNED = ['natural key', 'disposition', 'fidelity', 'qualified', 'capability', 'closure', 'projection',
      'blast radius', 'guard refusal', 'wave', 'verb', 'artifact', 'promotion', 'adapter', 'observation', 'catalog type'];
    const assertPlain = (text, where) => {
      assert.doesNotMatch(text, /\b[a-z][A-Za-z]+:[A-Za-z0-9]/, where + ': a natural key is outside the record');
      assert.doesNotMatch(text, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, where + ': an id is outside the record');
      assert.doesNotMatch(text, /\/etc\/keel/, where + ': a credential path is on screen');
      for (const term of BANNED) assert.doesNotMatch(text, new RegExp('\\b' + term + 's?\\b', 'i'), where + ': "' + term + '" is outside the record');
    };
    ${script}
  `], {
    cwd: new URL('../../portal/', import.meta.url), encoding: 'utf8',
    env: { ...process.env, KEEL_DB_URL: database.url, __NEXT_EXPERIMENTAL_AUTH_INTERRUPTS: '1', ...env },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

test('Protect: the verdict comes from the coverage reader, tier cards from the schedules, and only words are outside the record', async (t) => {
  const client = await database.connect();
  t.after(() => client.end());
  await client.query(readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8'));
  const tenantId = 'protect-page-fixture';
  const tenantRef = `sha256:${createHash('sha256').update(tenantId).digest('hex').slice(0, 16)}`;
  await collectSnapshot(client, { reader, tenantRef, tenantId, tier: 'tier1' });
  await seedSchedules(client, { tenantRef, now: new Date() });
  const { rows } = await client.query("INSERT INTO principal (email) VALUES ('viewer@contoso.com') RETURNING id::text AS id");
  await grantRole(client, { principalId: rows[0].id, role: 'viewer', grantedBy: rows[0].id });
  const directory = mkdtempSync(join(tmpdir(), 'keel-protect-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const config = join(directory, 'tenant.json');
  writeFileSync(config, JSON.stringify({ tenantId }));

  inPortal(String.raw`
    const page = require('./app/protect/page.tsx').default;
    const { getCoverageData } = require('./lib/portal-data.ts');
    const { protectVerdict, protectProblems, typeName } = require('./lib/protect-view.ts');
    const { PRINCIPAL_ID_HEADER, CAPABILITIES_HEADER } = require('./lib/principal.ts');
    const { workAsyncStorage } = require('next/dist/server/app-render/work-async-storage.external.js');
    const { workUnitAsyncStorage } = require('next/dist/server/app-render/work-unit-async-storage.external.js');
    const render = (headers) => workAsyncStorage.run({ route: '/protect', forceStatic: false }, () =>
      workUnitAsyncStorage.run({ type: 'request', phase: 'render', headers,
        implicitTags: [], url: { pathname: '/protect', search: '' }, rootParams: {},
        resumeDataCache: null, isHmrRefresh: false, fallbackParams: null,
      }, () => page()));
    (async () => {
      await assert.rejects(render(new Headers([[CAPABILITIES_HEADER, 'read']])), (error) => error.digest === 'NEXT_HTTP_ERROR_FALLBACK;403');
      const html = withRouter(await render(new Headers([[PRINCIPAL_ID_HEADER, ${JSON.stringify(rows[0].id)}], [CAPABILITIES_HEADER, 'read']])));
      const data = await getCoverageData();

      // The verdict is the reader's answer, not a constant: the denied type fails.
      const verdict = protectVerdict(data, data.generatedAt);
      assert.equal(verdict.text, '1 type failed its last backup.');
      assert.match(html, new RegExp('<p class="verdict-sentence">' + verdict.text.replace('.', '\\.') + '</p>'));
      assert.equal((html.match(/data-layer="verdict"/g) || []).length, 1);

      // Tier cards carry the schedule reader's next run, in words.
      for (const tier of ['Tier 1', 'Tier 2', 'Tier 3']) assert.match(html, new RegExp('Back up ' + tier));
      assert.match(html, /<span class="tier-next">Next run (in \d+ (minute|hour|day)s?|is due now)\.<\/span>/);
      assert.doesNotMatch(html, /KEEL could not read the schedules/);

      // Failed types are listed by name, with a retry.
      const problems = protectProblems(data, data.generatedAt);
      assert.ok(problems.some((problem) => problem.type === 'roleAssignment' && problem.health === 'failed'));
      assert.match(html, new RegExp('<strong>' + typeName('roleAssignment') + '</strong>'));
      assert.match(html, /Retry backup/);

      // One drawer per type, each with a standing sentence and its proof reference in the record.
      assert.equal((html.match(/<details class="capability-matrix type-drawer/g) || []).length, data.types.length);
      assert.equal((html.match(/<p class="type-drawer-standing">/g) || []).length, data.types.length);
      for (const item of data.types) {
        if (!item.writeCapability) continue;
        assert.ok(html.includes('Proof reference · update</dt><dd><code>' + (item.writeCapability.operations.update.proofRef ?? 'unknown')), item.type);
      }
      assertPlain(visibleText(html), 'Protect');
    })().catch((error) => { console.error(error); process.exitCode = 1; });
  `, { KEEL_TENANT_CONFIG_PATH: config });
});

test('Restore: the step title is the verdict and no credential path is rendered or editable', () => {
  inPortal(String.raw`
    const { RestoreSelection } = require('./components/restore-selection.tsx');
    const { restoreCredentialPaths } = require('./lib/restore-config.ts');
    const html = withRouter(createElement(RestoreSelection, {
      canRestore: true, canApprove: true, snapshotId: 'snap-1',
      snapshots: [{ id: 'snap-1', startedAt: '2026-10-02T09:01:00Z', completedAt: '2026-10-02T09:12:00Z', resourceCount: 3 }],
      resources: [
        { naturalKey: 'conditionalAccessPolicy:Block legacy auth', resourceType: 'conditionalAccessPolicy', blastRadius: 'tenant-lockout' },
        { naturalKey: 'group:Break-glass admins', resourceType: 'group', blastRadius: 'access-affecting' },
      ],
    }));
    assert.match(html, /<p class="verdict-sentence">Step 1 of 5: choose what to put back\.<\/p>/);
    assert.match(html, /aria-label="Select Block legacy auth \(Conditional Access policy\)"/);
    // Credential config paths are server configuration: no input, no value, no label.
    assert.doesNotMatch(html, /\/etc\/keel/);
    assert.doesNotMatch(html, /credential/i);
    assert.deepEqual(html.match(/<input(?![^>]*type="(checkbox|search)")[^>]*>/g), null,
      'the only inputs are the resource checkboxes and the search box');
    assertPlain(visibleText(html), 'Restore');
    // The server decides the paths; a deployment may move them, a request never can.
    assert.deepEqual(restoreCredentialPaths({}), { collectorConfig: '/etc/keel/tenant-target.json', targetConfig: '/etc/keel/restorer.json' });
    assert.equal(restoreCredentialPaths({ KEEL_RESTORER_CONFIG_PATH: '/srv/keel/r.json' }).targetConfig, '/srv/keel/r.json');
  `, {});
});
