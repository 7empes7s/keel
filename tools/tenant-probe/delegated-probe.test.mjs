import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  DOCS_OR_UNSURE_ROWS, READ_POSTS, ROWS, assertReadRequest, audienceFor, classify, environmentsOf, mask,
  readOnlyTransport, renderMarkdown, rowVerdict, runProbe,
} from './delegated-probe.mjs';

const env = (name, instanceUrl, fo = false) => ({ name, properties: {
  ...(instanceUrl ? { linkedEnvironmentMetadata: { instanceUrl } } : {}), ...(fo ? { linkedAppMetadata: { type: 'Internal' } } : {}) } });

test('every Docs or Unsure row of the design inventory has a probe group, once, in order', () => {
  assert.deepEqual(ROWS.map((group) => group.row), DOCS_OR_UNSURE_ROWS);
  // Live rows are not re-probed.
  for (const live of [1, 4, 10, 13, 19, 29]) assert.ok(!ROWS.some((group) => group.row === live), `row ${live}`);
  // A row with nothing to call says why.
  for (const group of ROWS) assert.ok(group.probes.length || group.cmdlets || group.unprobed, `row ${group.row}`);
  const ids = ROWS.flatMap((group) => group.probes.map((probe) => probe.id));
  assert.equal(new Set(ids).size, ids.length, 'probe ids are unique');
});

test('every probe URL is a read the transport accepts', () => {
  for (const group of ROWS) {
    for (const probe of group.probes) {
      if (probe.derived) continue;
      const url = probe.url.replace('{dataverse}', 'https://org1.crm4.dynamics.com').replace(/\{\w+\}/g, 'x');
      assert.ok(assertReadRequest(url, probe.method ?? 'GET'), probe.id);
      if (probe.method === 'POST') assert.ok(READ_POSTS.has(url), `${probe.id} is a listed read POST`);
    }
  }
});

test('the transport refuses writes, unknown hosts and plain http', () => {
  assert.throws(() => assertReadRequest('https://graph.microsoft.com/v1.0/users', 'PATCH'), /read-only/);
  assert.throws(() => assertReadRequest('https://graph.microsoft.com/v1.0/users', 'POST'), /read-only/);
  assert.throws(() => assertReadRequest('https://graph.microsoft.com/v1.0/users', 'GET', '{}'), /read-only/);
  assert.throws(() => assertReadRequest('https://graph.microsoft.com/v1.0/users', 'DELETE'), /read-only/);
  assert.throws(() => assertReadRequest([...READ_POSTS][0], 'POST', '{}'), /read-only/, 'the read POST is sent with no body');
  assert.throws(() => assertReadRequest('https://evil.example.com/x'), /host/);
  assert.throws(() => assertReadRequest('https://graph.microsoft.com.evil.example/x'), /host/);
  assert.throws(() => assertReadRequest('http://graph.microsoft.com/v1.0/users'), /host/);
  assert.equal(audienceFor('https://contoso.crm.dynamics.com/api/data/v9.2/WhoAmI'), 'https://contoso.crm.dynamics.com/');
  assert.equal(audienceFor('https://api.flow.microsoft.com/x'), 'https://service.flow.microsoft.com/');
});

test('the transport sends a bearer GET, never follows redirects, and returns a token failure as a result', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ value: [1, 2] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  let asked = 0;
  const transport = readOnlyTransport(async (audience) => { asked += 1; return `tok-${audience}`; }, fetchImpl);
  const answer = await transport('https://graph.microsoft.com/v1.0/admin/forms');
  await transport('https://graph.microsoft.com/beta/admin/todo');
  assert.equal(answer.status, 200);
  assert.equal(asked, 1, 'one token per audience');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.redirect, 'manual');
  assert.equal(calls[0].init.body, undefined);
  assert.equal(calls[0].init.headers.authorization, 'Bearer tok-https://graph.microsoft.com/');
  await assert.rejects(transport('https://graph.microsoft.com/v1.0/users', 'PATCH'), /read-only/);
  assert.equal(calls.length, 2, 'a refused write never reaches fetch');

  const failing = readOnlyTransport(async () => { throw new Error('Token request failed (400): invalid_resource — AADSTS500011: not found'); }, fetchImpl);
  assert.deepEqual(classify(await failing('https://www.yammer.com/api/v1/networks/current.json')),
    { outcome: 'no-token', status: null, code: 'AADSTS500011', message: 'Token request failed (400): invalid_resource — AADSTS500011: not found', count: null });
});

test('answers are classified by status and message', () => {
  assert.equal(classify({ status: 200, json: { value: [1] } }).outcome, 'works');
  assert.equal(classify({ status: 200, json: { value: [1] } }).count, 1);
  assert.equal(classify({ status: 403, json: { error: { code: 'Forbidden', message: 'no' } } }).outcome, 'refused');
  assert.equal(classify({ status: 401, json: null }).outcome, 'refused');
  assert.equal(classify({ status: 400, json: { error: { code: 'BadRequest', message: 'x' } } }).outcome, 'not-supported');
  assert.equal(classify({ status: 404, json: { error: { code: 'BadRequest', message: "Resource not found for the segment 'forms'." } } }).outcome, 'not-supported');
  assert.equal(classify({ status: 404, json: { error: { code: 'itemNotFound', message: 'gone' } } }).outcome, 'not-found');
  assert.equal(classify({ status: 503, json: null }).outcome, 'error');
  assert.equal(classify({ networkError: 'timeout' }).outcome, 'error');
});

test('masking strips tokens, ids, addresses and tenant hosts', () => {
  const text = mask('user a.b@contoso.com at https://contoso.crm4.dynamics.com id 0f8fad5b-d9cb-469f-a165-70867728950e 2026-10-22T12:00:00Z eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlc2lnbmF0dXJl');
  assert.ok(!/contoso|0f8fad5b|eyJ|12:00/.test(text), text);
});

test('environments come from the admin list, with their Dataverse URL and Finance and Operations link', () => {
  assert.deepEqual(environmentsOf({ value: [env('e1', 'https://org1.crm.dynamics.com/'), env('e2', null, true), { properties: {} }] }), [
    { name: 'e1', dataverse: 'https://org1.crm.dynamics.com', financeOperations: false },
    { name: 'e2', dataverse: null, financeOperations: true },
  ]);
});

// A fake tenant: Graph answers, Dataverse refuses (no application user), Yammer gives no token.
function fakeTenant() {
  const seen = [];
  const transport = async (url, method = 'GET') => {
    assertReadRequest(url, method);
    seen.push(`${method} ${url}`);
    const { hostname, pathname } = new URL(url);
    if (hostname === 'www.yammer.com') return { tokenError: 'AADSTS500011: resource not found' };
    if (hostname.endsWith('.dynamics.com')) return { status: 403, json: { error: { code: '0x80072560', message: 'The user is not a member of the organization.' } } };
    if (pathname.endsWith('/scopes/admin/environments')) return { status: 200, json: { value: [env('e1', 'https://org1.crm.dynamics.com/'), env('e2', null), env('e3', null), env('e4', null)] } };
    if (pathname.includes('/admin/groups') && url.includes('PersonalGroup')) return { status: 200, json: { value: [{ id: 'pg-1', name: 'PersonalWorkspace A' }] } };
    if (pathname.includes('/groups/pg-1/reports')) return { status: 401, json: { error: { code: 'PowerBINotAuthorizedException' } } };
    if (pathname.includes('/onenote/')) return { status: 400, json: { error: { code: '40004', message: 'app-only requests are not supported' } } };
    return { status: 200, json: { value: [] } };
  };
  return { transport, seen };
}

test('a run probes each row, uses the environment list for the Power Platform rows, and caps environments', async () => {
  const { transport, seen } = fakeTenant();
  const cmdletRows = [
    { workload: 'exo', cmdlet: 'Get-OrganizationConfig', outcome: 'works', count: 1 },
    { workload: 'exo', cmdlet: 'Get-Mailbox', outcome: 'needs-parameter' },
    { workload: 'exo', cmdlet: 'Get-SomethingSecret', outcome: 'refused', error: 'Access denied for x@contoso.onmicrosoft.com' },
    { workload: 'spo', cmdlet: 'Get-PnPTenant', outcome: 'works', count: 1 },
    { workload: 'spo', cmdlet: 'Get-PnPSearchConfiguration -Scope Subscription', outcome: 'refused', error: 'denied' },
  ];
  const report = await runProbe({ transport, maxEnvironments: 3, cmdletRows, now: () => new Date('2026-10-22T00:00:00Z') });
  const row = (n) => report.rows.find((entry) => entry.row === n);

  assert.equal(report.environments, 4);
  assert.equal(seen.filter((line) => line.includes('/environments/e4/')).length, 0, 'the fourth environment is beyond the cap');
  assert.equal(seen.filter((line) => line.includes('/environments/e3/apps')).length, 1);
  assert.ok(seen.includes('POST https://api.bap.microsoft.com/providers/Microsoft.BusinessAppPlatform/listtenantsettings?api-version=2020-10-01'));
  assert.ok(seen.every((line) => line.startsWith('GET ') || line.includes('listtenantsettings')), 'GET everywhere else');

  // Dataverse: environment 1 refused, environments 2 and 3 have no Dataverse.
  assert.deepEqual(row(2).results.map((r) => [r.target, r.outcome]), [
    ['environment 1', 'refused'], ['environment 2', 'skipped'], ['environment 3', 'skipped'],
    ['environment 1', 'refused'], ['environment 2', 'skipped'], ['environment 3', 'skipped'],
  ]);
  assert.equal(row(2).verdict, 'app-only refused');
  assert.equal(row(7).verdict, 'app-only works');
  assert.equal(row(9).results[0].outcome, 'info');
  assert.equal(row(12).verdict, 'partly app-only', 'admin list works, the personal workspace refuses');
  assert.equal(row(15).verdict, 'app-only refused');
  assert.equal(row(20).verdict, 'partly app-only');
  assert.equal(row(3).verdict, 'nothing to call');
  assert.equal(row(16).cmdlets.counts.works, 1);
  assert.equal(row(16).cmdlets.notWorking.length, 1);
  assert.equal(row(16).verdict, 'partly app-only');
  assert.deepEqual(row(14).cmdlets.notWorking.map((c) => c.cmdlet), ['Get-PnPSearchConfiguration -Scope Subscription'], 'only the search and term store cmdlets count for row 14');
  assert.equal(row(17).cmdlets.swept, false);

  const text = JSON.stringify(report) + renderMarkdown(report);
  assert.ok(!/contoso|org1|PersonalWorkspace|pg-1|e1\//.test(text), 'no tenant names or ids in the report');
  assert.match(renderMarkdown(report), /\| 21 \| Entra device registration settings \| app-only works \|/);
});

test('a refused environment list skips the per-environment rows with a reason', async () => {
  const transport = async (url) => (url.includes('/scopes/admin/environments') ? { status: 403, json: null } : { status: 200, json: {} });
  const report = await runProbe({ transport });
  const row6 = report.rows.find((entry) => entry.row === 6);
  assert.ok(row6.results.every((r) => r.outcome === 'skipped' && r.reason === 'no environment list'));
  assert.equal(row6.verdict, 'not probed (see reasons)');
});

test('row verdicts', () => {
  assert.equal(rowVerdict({ results: [{ outcome: 'works' }, { outcome: 'not-found' }] }), 'partly app-only');
  assert.equal(rowVerdict({ results: [{ outcome: 'error' }] }), 'inconclusive');
  assert.equal(rowVerdict({ results: [], cmdlets: { swept: false } }), 'not probed (see reasons)');
});

test('the cmdlet sweep only ever calls Get- cmdlets', () => {
  const script = readFileSync(new URL('../../ops/powershell/sweep-get-cmdlets.ps1', import.meta.url), 'utf8');
  assert.match(script, /Where-Object \{ \$_\.Verb -eq 'Get' \}/, 'the sweep filters on the Get verb');
  const code = script.replace(/<#[\s\S]*?#>/, '').split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');
  const verbs = [...code.matchAll(/\b(Set|New|Remove|Add|Grant|Revoke|Enable|Disable|Start|Stop|Update|Clear|Reset|Register|Unregister|Install|Restore|Export|Import|Invoke|Connect|Disconnect)-[A-Z][A-Za-z0-9]+/g)]
    .map((match) => match[0]);
  const allowed = new Set(['Import-Module', 'Connect-ExchangeOnline', 'Connect-IPPSSession', 'Connect-MicrosoftTeams', 'Connect-PnPOnline',
    'Disconnect-ExchangeOnline', 'Disconnect-MicrosoftTeams', 'Invoke-Sweep', 'Invoke-RestMethod', 'Add-Row']);
  assert.deepEqual(verbs.filter((verb) => !allowed.has(verb)), []);
  // REST calls: one token request, two Graph GETs.
  const rest = [...code.matchAll(/Invoke-RestMethod[^\n]*/g)].map((match) => match[0]);
  assert.equal(rest.length, 3);
  assert.equal(rest.filter((line) => /-Method Post/.test(line)).length, 1);
  assert.match(rest.find((line) => /-Method Post/.test(line)), /login\.microsoftonline\.com/);
});
