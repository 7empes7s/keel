// A fake keel-dsc container for tests: plays the ops/powershell/run-dsc.ps1 contract
// behind the real engine/powershell/jobQueue.mjs spawn path, with an in-memory set of
// distribution lists. No Docker, no network, no tenant.
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

import { DSC_MODULE_VERSION } from '../powershell/dscJob.mjs';

const READ = [
  'Identity', 'Name', 'Ensure', 'DisplayName', 'Alias', 'PrimarySmtpAddress', 'Type', 'HiddenFromAddressListsEnabled', 'MemberJoinRestriction',
  'MemberDepartRestriction', 'RequireSenderAuthenticationEnabled', 'ModerationEnabled', 'SendModerationNotifications', 'SendOofMessageToOriginatorEnabled',
  'ManagedBy', 'ModeratedBy', 'GrantSendOnBehalfTo', 'AcceptMessagesOnlyFromSendersOrMembers', 'RejectMessagesFromSendersOrMembers', 'EmailAddresses', 'Members',
];

/** A list as Exchange would hold it, with Exchange defaults for what is not given. */
export function fakeList(fields) {
  return {
    Guid: fields.Guid ?? randomUUID(),
    DisplayName: fields.Name, Alias: fields.Name.replace(/[^A-Za-z0-9-]/g, ''), PrimarySmtpAddress: `${fields.Name.replace(/[^A-Za-z0-9-]/g, '')}@contoso.test`,
    Type: 'Distribution', HiddenFromAddressListsEnabled: false, MemberJoinRestriction: 'Closed', MemberDepartRestriction: 'Closed',
    RequireSenderAuthenticationEnabled: true, ModerationEnabled: false, SendModerationNotifications: 'Always', SendOofMessageToOriginatorEnabled: false,
    ManagedBy: [], ModeratedBy: [], GrantSendOnBehalfTo: [], AcceptMessagesOnlyFromSendersOrMembers: [], RejectMessagesFromSendersOrMembers: [], EmailAddresses: [], Members: [],
    ...fields,
  };
}

/**
 * The fake tenant. `lists` is a Map guid -> list. `jobs` records every job descriptor
 * received; `writes` every Set call. `behave.set(call)` may return 'crash-after' (apply,
 * then die with no answer), 'fail' (the Set errors) or nothing; `behave.afterSet(properties,
 * list)` may change the list after a Set, as a module that touches more than it was sent.
 */
export function fakeDscTenant(initial = [], { moduleVersion = DSC_MODULE_VERSION, behave = {} } = {}) {
  const lists = new Map(initial.map((list) => [list.Guid, structuredClone(list)]));
  const jobs = [];
  const writes = [];
  const find = (identity) => {
    const key = String(identity).toLowerCase();
    return [...lists.values()].find((list) => list.Guid.toLowerCase() === key || list.Name.toLowerCase() === key) ?? null;
  };
  const get = ({ Identity, Name }) => {
    const list = find(Identity);
    if (!list) return { Identity, Name, Ensure: 'Absent' };
    return Object.fromEntries(READ.map((field) => [field, field === 'Identity' ? Identity : field === 'Ensure' ? 'Present' : structuredClone(list[field])]));
  };
  const set = (properties) => {
    const { Identity, Ensure, ...rest } = properties;
    if (Ensure !== 'Present') throw new Error('the fake refuses a Set that is not Ensure Present');
    const list = find(Identity);
    if (list) Object.assign(list, rest);
    else {
      const created = fakeList({ ...rest, Name: properties.Name, ManagedBy: ['app-only'] });
      lists.set(created.Guid, created);
    }
  };

  function answer(job) {
    jobs.push(job);
    if (job.mode !== 'dsc') return { code: 2, stdout: '' };
    if (job.moduleVersion !== DSC_MODULE_VERSION) {
      return { code: 1, stdout: JSON.stringify({ ok: false, error: { message: 'version', category: null, errorId: 'ModuleVersionMismatch' } }) };
    }
    const results = [];
    for (const call of job.calls) {
      if (call.method === 'Get') results.push({ method: 'Get', ok: true, state: get(call.properties), missing: [] });
      else if (call.method === 'Set') {
        writes.push(structuredClone(call.properties));
        const how = behave.set?.(call.properties);
        if (how === 'fail') { results.push({ method: 'Set', ok: false, error: { message: 'The operation could not be performed', category: 'InvalidOperation', errorId: 'x' } }); continue; }
        set(call.properties);
        behave.afterSet?.(call.properties, find(call.properties.Identity));
        if (how === 'crash-after') return { code: 137, stdout: '' };
        results.push({ method: 'Set', ok: true });
      } else results.push({ method: call.method, ok: true, inDesiredState: true });
    }
    return { code: 0, stdout: `WARNING: Microsoft365DSC requires PowerShell 7.6 or higher.\n${JSON.stringify({ ok: true, moduleVersion, results })}` };
  }

  const spawnFn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    let input = '';
    child.stdin = {
      write(chunk) { input += chunk; },
      end() {
        queueMicrotask(() => {
          const { code, stdout } = answer(JSON.parse(input));
          if (stdout) child.stdout.emit('data', Buffer.from(stdout));
          child.emit('close', code);
        });
      },
    };
    child.kill = () => {};
    return child;
  };
  // The PowerShell options a connection would carry, pointed at this fake.
  const powershell = { tenantConfigPath: '/etc/keel/exchange-restorer.json', spawnFn, scriptMount: null };
  return { lists, jobs, writes, powershell, find };
}
