/**
 * Test helper: Exchange Online's management roles behind a fake PowerShell container (the
 * real engine/powershell/jobQueue.mjs spawn path), playing the run-cmdlet.ps1 contract for
 * the Exchange role allowlists. Nothing here touches a tenant.
 *
 * `roles` is [{ name, parent?, description?, entries: { cmdlet: [parameters] } }].
 * `ignoreEnabledCmdlets` makes New-ManagementRole copy every parent entry; `failNew` is an
 * answer New-ManagementRole gives instead of creating; `beforeNew(state, parameters)` runs just
 * before New-ManagementRole is answered (to make a role appear after Keel's last check).
 */
import { containerAllowlist, fakeCmdletContainer } from './fakeCmdletContainer.mjs';

export function fakeExchangeRoles({ roles = [], ignoreEnabledCmdlets = false, failNew = null, beforeNew = null } = {}) {
  const state = new Map(roles.map(({ name, parent = null, description = null, entries }) => [name.toLowerCase(), { name, parent, description, entries: structuredClone(entries) }]));
  const allowlist = { ...containerAllowlist('AllowedExchangeRoleReads'), ...containerAllowlist('AllowedExchangeRoleWrites') };
  const missing = (name) => ({ error: { message: `The operation couldn't be performed because object '${name}' couldn't be found.`, category: 'NotSpecified', errorId: 'ManagementObjectNotFoundException' } });
  const container = fakeCmdletContainer({
    module: 'ExchangeOnlineManagement',
    allowlist,
    answer(cmdlet, parameters) {
      if (cmdlet === 'Get-ManagementRole') return [...state.values()].map(({ name, parent, description }) => ({ Name: name, Parent: parent, Description: description, RoleType: 'Custom' }));
      if (cmdlet === 'New-ManagementRole' && beforeNew) beforeNew(state, parameters);
      const [roleName, entryName] = String(parameters.Identity ?? '').split('\\');
      const found = state.get(String(cmdlet === 'New-ManagementRole' ? parameters.Name : roleName).toLowerCase());
      if (cmdlet === 'Get-ManagementRoleEntry') {
        if (!found) return missing(roleName);
        return Object.entries(found.entries).map(([name, list]) => ({ Name: name, Role: found.name, Identity: `${found.name}\\${name}`, Parameters: [...list, 'ErrorAction', 'WhatIf'], Type: 'Cmdlet' }));
      }
      if (cmdlet === 'New-ManagementRole') {
        if (failNew) return failNew;
        if (found) return { error: { message: `The role ${parameters.Name} already exists.`, category: 'NotSpecified', errorId: 'ADObjectAlreadyExistsException' } };
        const parent = state.get(String(parameters.Parent).toLowerCase());
        if (!parent) return missing(parameters.Parent);
        const wanted = ignoreEnabledCmdlets ? Object.keys(parent.entries) : parameters.EnabledCmdlets;
        const unknown = wanted.filter((name) => !parent.entries[name]);
        if (unknown.length) return { error: { message: `${unknown.join(', ')} is not in the parent role`, category: 'InvalidArgument', errorId: 'InvalidEnabledCmdlets' } };
        state.set(parameters.Name.toLowerCase(), { name: parameters.Name, parent: parent.name, description: parameters.Description ?? null, entries: Object.fromEntries(wanted.map((name) => [name, [...parent.entries[name]]])) });
        return [{ Name: parameters.Name }];
      }
      if (!found || !found.entries[entryName]) return missing(parameters.Identity);
      if (cmdlet === 'Set-ManagementRoleEntry') {
        const drop = new Set(parameters.Parameters.map((name) => name.toLowerCase()));
        found.entries[entryName] = found.entries[entryName].filter((name) => !drop.has(name.toLowerCase()));
        return [];
      }
      if (cmdlet === 'Remove-ManagementRoleEntry') {
        delete found.entries[entryName];
        return [];
      }
      return { error: { message: `unexpected ${cmdlet}` } };
    },
  });
  return { ...container, state, sent: () => container.calls.filter(({ cmdlet }) => !cmdlet.startsWith('Get-')) };
}
