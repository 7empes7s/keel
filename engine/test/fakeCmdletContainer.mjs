/**
 * Test helpers for the read-only cmdlet workloads: a fake PowerShell container behind
 * the real engine/powershell/jobQueue.mjs spawn path, which plays the
 * ops/powershell/run-cmdlet.ps1 contract for one allowlist, and a workload ledger in
 * which chosen reads are live-qualified. Nothing here touches a tenant.
 */
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';

import { WORKLOAD_DESCRIPTORS, buildWorkloadLedger } from '../collect/workloadContract.mjs';

/** One allowlist hashtable of run-cmdlet.ps1, as { cmdlet: [parameter names] }. */
export function containerAllowlist(variable) {
  const script = readFileSync(new URL('../../ops/powershell/run-cmdlet.ps1', import.meta.url), 'utf8');
  const block = new RegExp(`\\$${variable} = @\\{([\\s\\S]*?)\\n\\}`).exec(script)[1];
  return Object.fromEntries([...block.matchAll(/'([A-Za-z-]+)'\s*=\s*@\(([^)]*)\)/g)]
    .map(([, name, entries]) => [name, [...entries.matchAll(/'([A-Za-z0-9]+)'/g)].map((match) => match[1])]));
}

/** The error envelope a session answers for a cmdlet it does not expose. */
export const notFound = (cmdlet) => ({
  message: `The term '${cmdlet}' is not recognized as a name of a cmdlet, function, script file, or executable program.`,
  category: 'ObjectNotFound', errorId: 'CommandNotFoundException',
});

/**
 * A fake container enforcing `allowlist` for `module`. `answer(cmdlet, parameters)`
 * returns the output list, `{ error }` for an error envelope, or 'crash'.
 */
export function fakeCmdletContainer({ module, allowlist, answer }) {
  const calls = [];
  const envelope = (body, exitCode = 0) => ({ stdout: JSON.stringify(body), exitCode });
  function run(job) {
    const keys = Object.keys(job).filter((key) => key !== 'jobId').sort();
    if (job.mode !== 'cmdlet' || keys.some((key) => !['adapter', 'cmdlet', 'mode', 'module', 'parameters', 'tenantConfigPath'].includes(key))) {
      return { stdout: '', stderr: `run-job.sh: refused descriptor with ${keys.join(',')}`, exitCode: 2 };
    }
    if (job.module !== module || !allowlist[job.cmdlet]) {
      return envelope({ ok: false, error: { message: `cmdlet ${job.cmdlet} is not allowed`, category: null, errorId: 'CmdletNotAllowed' } }, 1);
    }
    for (const name of Object.keys(job.parameters ?? {})) {
      if (!allowlist[job.cmdlet].includes(name)) return envelope({ ok: false, error: { message: `parameter ${name} is not allowed`, category: null, errorId: 'ParameterNotAllowed' } }, 1);
    }
    const parameters = job.parameters ?? {};
    calls.push({ cmdlet: job.cmdlet, parameters });
    const output = answer(job.cmdlet, parameters);
    if (output === 'crash') return { stdout: '', stderr: 'pwsh: segmentation fault', exitCode: 139 };
    if (output?.error) return envelope({ ok: false, error: output.error }, 1);
    return envelope({ ok: true, output: structuredClone(output ?? []) });
  }
  function spawnFn() {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    let input = '';
    child.stdin = {
      write(chunk) { input += chunk; },
      end() {
        queueMicrotask(() => {
          const result = run(JSON.parse(input));
          if (result.stdout) child.stdout.emit('data', Buffer.from(result.stdout));
          if (result.stderr) child.stderr.emit('data', Buffer.from(result.stderr));
          child.emit('close', result.exitCode);
        });
      },
    };
    return child;
  }
  return { calls, powershell: { spawnFn, timeoutMs: 200, tenantConfigPath: '/etc/keel/tenant.json' } };
}

export const MODULE_VERSIONS = Object.freeze({ ExchangeOnlineManagement: '3.5.0', 'PnP.PowerShell': '3.4.1', MicrosoftTeams: '6.0.0' });
export const RUNTIME = Object.freeze({ modules: MODULE_VERSIONS });
export const GRANTS = Object.freeze({
  permissions: [...new Set(WORKLOAD_DESCRIPTORS.flatMap((descriptor) => descriptor.rbac.permissions))],
  roles: [...new Set(WORKLOAD_DESCRIPTORS.flatMap((descriptor) => descriptor.rbac.roles))],
});
export const ALL_READS = Object.freeze(WORKLOAD_DESCRIPTORS.map((descriptor) => descriptor.id));

/** A ledger where the reads in `live` are live-qualified and the rest fixture-tested. */
export function ledgerWith(tenantRef, live, { now }) {
  const evidence = WORKLOAD_DESCRIPTORS.map((descriptor) => {
    if (!live.includes(descriptor.id)) return { operationId: descriptor.id, kind: 'fixture', synthetic: true, ok: true, proofRef: `${descriptor.id}.fixture` };
    const version = descriptor.operation.kind === 'graph' ? descriptor.operation.version : MODULE_VERSIONS[descriptor.operation.module];
    return {
      operationId: descriptor.id, kind: 'live-capture', synthetic: false, tenantRef,
      capturedAt: new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(), version, ok: true, proofRef: `${descriptor.id}@sha256:x`,
    };
  });
  return buildWorkloadLedger({ evidence, grants: GRANTS, runtime: RUNTIME, tenantRef, now });
}
