#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { planBootstrap } from '../engine/bootstrap/plan.mjs';
import { approveBootstrapPlan, executeBootstrap } from '../engine/bootstrap/execute.mjs';
import { assertTokenFree } from '../tools/tenant-probe/auth.mjs';

// Server/CLI composition seam: journal derives tenant and principal from trusted
// deployment/authentication context, never from a submitted plan or artifact.
export async function runBootstrap({ mode = 'plan', journal, ...options }) {
  if (!journal) throw new Error('bootstrap requires an authenticated journal context');
  await journal.authorize();
  if (mode === 'plan') {
    if (options.tenantRef !== journal.tenantRef) throw new Error('bootstrap: tenant mismatch');
    return planBootstrap(options);
  }
  if (mode === 'approve') return approveBootstrapPlan({ journal, ...options });
  if (mode === 'execute') return executeBootstrap({ journal, ...options });
  if (mode === 'status') return journal.events(options.artifactId);
  throw new Error('bootstrap: unknown mode');
}

// Standalone CLI intentionally supports offline planning only. Execution requires
// a host-injected qualified adapter and authenticated database journal. No
// credential loading, network transport or live provisioning is installed here.
export async function main(argv = process.argv.slice(2), output = console) {
  const flags = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--mode', '--fixture'].includes(argv[i]) || !argv[i + 1] || flags.has(argv[i])) throw new Error('Usage: keel-bootstrap.mjs [--mode plan] --fixture FILE');
    flags.set(argv[i], argv[i + 1]);
  }
  if ((flags.get('--mode') ?? 'plan') !== 'plan') throw new Error('Execution requires authenticated host integration and qualified injected adapters');
  if (!flags.get('--fixture')) throw new Error('Offline planning requires --fixture FILE');
  const fixture = assertTokenFree(JSON.parse(readFileSync(flags.get('--fixture'), 'utf8')));
  const readAdapters = Object.fromEntries(['Applications', 'ServicePrincipals', 'AppRoleAssignments',
    'RoleAssignments', 'RoleEligibilitySchedules', 'SubscribedSkus'].map(name => {
    const key = name[0].toLowerCase() + name.slice(1);
    if (!Array.isArray(fixture.observed?.[key])) throw new Error(`Missing fixture collection: ${key}`);
    return [`list${name}`, async () => fixture.observed[key]];
  }));
  const plan = await planBootstrap({ tenantRef: fixture.tenantRef, workloads: fixture.workloads,
    operatorPrincipalId: fixture.operatorPrincipalId, readAdapters });
  output.log(JSON.stringify(plan, null, 2));
  return plan;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('Bootstrap refused; check mode, reference-only fixture and host prerequisites.'); process.exitCode = 1; });
}
