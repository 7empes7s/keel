import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { JobQueueError } from '../powershell/jobQueue.mjs';
import { discoverPowerShell } from './discover.mjs';
import { COMMAND_SESSIONS, listPowerShellCommands } from './powershellCommands.mjs';

const ok = (session, commands) => ({ jobId: `j-${session}`, result: { ok: true, session, commands }, stderr: '' });

test('each session is listed once in the container and Exchange merges with Security & Compliance', async () => {
  const jobs = [];
  const answers = {
    exo: ['Get-TransportRule', 'Get-Mailbox', 'Get-OrganizationConfig'],
    ipps: ['Get-Label', 'Get-DlpCompliancePolicy', 'Get-Mailbox'],
    teams: ['Get-CsTeamsMeetingPolicy', 'Get-Team', 'Set-Team'],
    pnp: ['Get-PnPTenantSite', 'Get-PnPTenant'],
  };
  const runJobFn = async (job, options) => { jobs.push({ job, options }); return ok(job.session, answers[job.session]); };
  const { commands, errors } = await listPowerShellCommands({ runJobFn, tenantConfigPath: '/etc/keel/tenant.json' });
  assert.deepEqual(jobs.map(({ job }) => job), COMMAND_SESSIONS.map(({ session }) => ({ adapter: 'powershell/commands', mode: 'commands', session, tenantConfigPath: '/etc/keel/tenant.json' })));
  assert.ok(jobs.every(({ options }) => options.timeoutMs === 3 * 60 * 1000));
  assert.deepEqual(errors, {});
  assert.deepEqual(commands, {
    ExchangeOnlineManagement: ['Get-DlpCompliancePolicy', 'Get-Label', 'Get-Mailbox', 'Get-OrganizationConfig', 'Get-TransportRule'],
    MicrosoftTeams: ['Get-CsTeamsMeetingPolicy', 'Get-Team'],
    'PnP.PowerShell': ['Get-PnPTenant', 'Get-PnPTenantSite'],
  });
});

test('a module that cannot be listed is reported with the reason, never as a half list', async () => {
  const runJobFn = async (job) => {
    if (job.session === 'ipps') {
      throw new JobQueueError('job exited 1', { code: 'NONZERO_EXIT', stdout: JSON.stringify({ ok: false, session: 'ipps', error: { message: 'could not connect: AADSTS700027 token expired', errorId: 'ListConnectFailed' } }), stderr: '' });
    }
    if (job.session === 'teams') throw new JobQueueError('timed out', { code: 'TIMEOUT', stdout: '', stderr: '' });
    if (job.session === 'pnp') return ok('pnp', []);
    return ok(job.session, ['Get-TransportRule']);
  };
  const { commands, errors } = await listPowerShellCommands({ runJobFn });
  assert.deepEqual(commands, {});
  assert.deepEqual(errors, {
    ExchangeOnlineManagement: 'Security & Compliance: could not connect: AADSTS700027 token expired',
    MicrosoftTeams: 'MicrosoftTeams: the listing took longer than 3 minutes',
    'PnP.PowerShell': 'PnP.PowerShell: the module listed no Get cmdlets',
  });

  // Exchange Online failing first skips Security & Compliance: the module is out either way.
  const sessions = [];
  const failed = await listPowerShellCommands({
    runJobFn: async (job) => {
      sessions.push(job.session);
      if (job.session === 'exo') throw new JobQueueError('no docker', { code: 'SPAWN_ERROR', stdout: '', stderr: '' });
      return ok(job.session, ['Get-Team']);
    },
  });
  assert.deepEqual(sessions, ['exo', 'teams', 'pnp']);
  assert.equal(failed.errors.ExchangeOnlineManagement, 'Exchange Online: the PowerShell container could not be started');

  // The reason becomes the source error, so the portal can show it under Technical details.
  const catalogued = new Map([['ExchangeOnlineManagement', new Set(['Get-TransportRule'])]]);
  const { sources, items } = discoverPowerShell(commands, catalogued, errors);
  assert.deepEqual(sources.find((source) => source.source === 'powershell:ExchangeOnlineManagement'),
    { source: 'powershell:ExchangeOnlineManagement', status: 'unknown', error: errors.ExchangeOnlineManagement, metadataVersion: null, paths: 0 });
  assert.deepEqual(items.map((item) => [item.name, item.status]), [['Get-TransportRule', 'not-listed']]);
  assert.equal(discoverPowerShell({}, catalogued).sources[0].error, 'no command list was supplied for this module');
});

test('the container lists cmdlets without running them, and connects only where Exchange needs it', () => {
  const script = readFileSync(new URL('../../ops/powershell/list-commands.ps1', import.meta.url), 'utf8');
  const runJob = readFileSync(new URL('../../ops/powershell/run-job.sh', import.meta.url), 'utf8');
  const dockerfile = readFileSync(new URL('../../ops/powershell/Dockerfile', import.meta.url), 'utf8');
  assert.match(runJob, /\$mode -eq "commands"[\s\S]*?& \/app\/list-commands\.ps1/);
  assert.match(dockerfile, /COPY list-commands\.ps1 \/app\/list-commands\.ps1/);
  for (const session of ['exo', 'ipps', 'teams', 'pnp']) assert.match(script, new RegExp(`${session} = '`));
  // Listing only: no cmdlet name taken from the job is ever invoked, and nothing writes.
  assert.doesNotMatch(script, /& \$name|Invoke-Expression|\biex\b|\b(Set|New|Remove|Add|Enable|Disable|Update)-[A-Z]/);
  assert.match(script, /Disconnect-ExchangeOnline/);
});

test('each session connects with its family config from the workload scope, the rest with the tenant config (#542)', async () => {
  // Operator Q146: Exchange Online and Security & Compliance refused /etc/keel/tenant.json,
  // which names no organization.
  const jobs = [];
  const runJobFn = async (job) => { jobs.push(job); return ok(job.session, ['Get-Thing']); };
  const { errors } = await listPowerShellCommands({
    runJobFn, tenantConfigPath: '/etc/keel/tenant.json',
    familyConfigPaths: { exchange: '/etc/keel/exchange-collector.json', purview: '/etc/keel/purview-collector.json' },
  });
  assert.deepEqual(errors, {});
  assert.deepEqual(Object.fromEntries(jobs.map((job) => [job.session, job.tenantConfigPath])), {
    exo: '/etc/keel/exchange-collector.json', ipps: '/etc/keel/purview-collector.json',
    teams: '/etc/keel/tenant.json', pnp: '/etc/keel/tenant.json',
  });
});
