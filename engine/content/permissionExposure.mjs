// Saved exposure evidence only; no requests and no new permissions.
export function everyoneAudience(login) {
  if (/^c:0\(\.s\|true$/i.test(login ?? '')) return 'everyone';
  if (/^c:0-\.f\|rolemanager\|spo-grid-all-users\//i.test(login ?? '')) return 'everyone-except-external';
  return null;
}
export const emptyLinks = () => ({ anyone: { view: 0, edit: 0, unknown: 0 }, organisation: { view: 0, edit: 0, unknown: 0 }, specificPeople: { view: 0, edit: 0, unknown: 0 }, unknown: 0 });
export function sharingLinkKind(name) {
  const match = /^SharingLinks\.[^.]+\.(Anonymous|Organization|Flexible)(View|Edit)?(?:\.|$)/i.exec(name ?? '');
  if (!match || (!match[2] && match[1].toLowerCase() !== 'flexible')) return null;
  return { scope: { anonymous: 'anyone', organization: 'organisation', flexible: 'specificPeople' }[match[1].toLowerCase()], access: match[2]?.toLowerCase() ?? 'unknown' };
}
export function drivePermissionExposure(permissions) {
  if (!Array.isArray(permissions)) return null;
  const links = emptyLinks();
  const everyone = [];
  for (const grant of permissions) {
    if (grant.link) {
      const scope = { anonymous: 'anyone', organization: 'organisation', users: 'specificPeople' }[grant.link.scope];
      const access = grant.link.type === 'edit' ? 'edit' : grant.link.type === 'view' ? 'view' : 'unknown';
      if (scope) links[scope][access] += 1;
      else links.unknown += 1;
    }
    for (const identity of [grant.grantedToV2 ?? grant.grantedTo, ...(grant.grantedToIdentitiesV2 ?? grant.grantedToIdentities ?? [])]) {
      const audience = everyoneAudience(identity?.siteUser?.loginName ?? identity?.siteGroup?.loginName ?? identity?.group?.loginName);
      if (audience) everyone.push({ audience, roles: grant.roles ?? [] });
    }
  }
  return { everyone, links, linkGrants: permissions.filter((grant) => grant.link).map((grant) => ({ id: grant.id, scope: grant.link.scope, type: grant.link.type })) };
}
