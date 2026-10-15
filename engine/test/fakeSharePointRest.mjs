/**
 * Gap 4 test fixture: an in-memory SharePoint REST API for one KEEL-RT- site, holding
 * levels, groups with members, site collection admins and role assignments on the site
 * and one list. It answers the reads the content backup makes and the writes the site
 * permissions restore sends; nothing here reaches a tenant.
 */
export const HOST = 'contoso.sharepoint.com';
export const SITE = `${HOST},00000001-0000-4000-8000-000000000001,00000101-0000-4000-8000-000000000101`;
export const WEB_URL = `https://${HOST}/sites/KEEL-RT-20261015`;
export const API = `${WEB_URL}/_api`;
export const LIST = '0000aaaa-0000-4000-8000-00000000aaaa';

export const login = (name) => `i:0#.f|membership|${name}@contoso.com`;
export const USERS = ['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'mallory', 'zoe', 'keel-rt-tester'];
export const ROLES = {
  full: { Id: 1073741829, Name: 'Full Control', RoleTypeKind: 5, Hidden: false, Order: 1, BasePermissions: { High: '2147483647', Low: '4294967295' } },
  edit: { Id: 1073741830, Name: 'Edit', RoleTypeKind: 6, Hidden: false, Order: 48, BasePermissions: { High: '432', Low: '1012866047' } },
  read: { Id: 1073741826, Name: 'Read', RoleTypeKind: 2, Hidden: false, Order: 128, BasePermissions: { High: '176', Low: '138612833' } },
  limited: { Id: 1073741825, Name: 'Limited Access', RoleTypeKind: 1, Hidden: true, Order: 160, BasePermissions: { High: '16', Low: '134287360' } },
  reviewer: { Id: 1073741930, Name: 'KEEL-RT Reviewer', RoleTypeKind: 0, Hidden: false, Order: 200, Description: 'Reads and comments', BasePermissions: { High: '176', Low: '138612835' } },
};
export const group = (Id, Title, members, extra = {}) => ({
  Id, Title, Description: `${Title} of the site`, LoginName: Title, OwnerTitle: 'KEEL-RT Owners', AllowMembersEditMembership: false,
  AllowRequestToJoinLeave: false, AutoAcceptRequestToJoinLeave: false, OnlyAllowMembersViewMembership: true, RequestToJoinLeaveEmailSetting: null,
  members, ...extra,
});

/** The site as the backup saw it. */
export function backupState() {
  return {
    web: { Id: 'web-1', Url: WEB_URL, HasUniqueRoleAssignments: true },
    roleDefinitions: [ROLES.full, ROLES.edit, ROLES.read, ROLES.limited, ROLES.reviewer],
    groups: [
      group(3, 'KEEL-RT Owners', ['alice']),
      group(4, 'KEEL-RT Members', ['bob', 'carol']),
      group(7, 'KEEL-RT Reviewers', ['dave']),
      group(9, 'SharingLinks.0000.OrganizationView.1111', []),
    ],
    admins: ['alice', 'erin'],
    web_assignments: [
      ['group', 'KEEL-RT Owners', 'full'], ['group', 'KEEL-RT Members', 'edit'], ['group', 'KEEL-RT Reviewers', 'reviewer'],
      ['user', 'frank', 'read'], ['group', 'SharingLinks.0000.OrganizationView.1111', 'limited'], ['user', 'bob', 'limited'],
    ],
    lists: [{ Id: LIST, Title: 'KEEL-RT Documents', Hidden: false, HasUniqueRoleAssignments: true, assignments: [['group', 'KEEL-RT Members', 'read'], ['user', 'dave', 'edit']] }],
  };
}

/**
 * The site now: the custom level and the Reviewers group are gone, carol left Members
 * and mallory joined, erin is no longer an admin and zoe is, frank lost Read and mallory
 * holds Full Control on the site, dave lost Edit on the list, and a group was added.
 */
export function liveState() {
  const state = backupState();
  state.roleDefinitions = state.roleDefinitions.filter((role) => role.Id !== ROLES.reviewer.Id);
  state.groups = state.groups.filter((item) => item.Id !== 7);
  state.groups.find((item) => item.Id === 4).members = ['bob', 'mallory'];
  state.groups.push(group(12, 'KEEL-RT Extra', []));
  state.admins = ['alice', 'zoe'];
  state.web_assignments = state.web_assignments.filter(([, who]) => who !== 'KEEL-RT Reviewers' && who !== 'frank');
  state.web_assignments.push(['user', 'mallory', 'full']);
  state.lists[0].assignments = [['group', 'KEEL-RT Members', 'read']];
  return state;
}

/** An in-memory SharePoint REST API for one site. `onWrite` can refuse a write. */
export function fakeSharePoint(initial, { onWrite } = {}) {
  const state = structuredClone(initial);
  let nextId = 100;
  const users = new Map(USERS.map((name, index) => [login(name), { Id: 20 + index, Title: name, LoginName: login(name), PrincipalType: 1, Email: `${name}@contoso.com`, UserPrincipalName: `${name}@contoso.com` }]));
  const roleByKey = (key) => state.roleDefinitions.find((role) => role === ROLES[key] || role.Name === ROLES[key]?.Name || role.Name === key);
  const user = (name) => users.get(name.startsWith('i:') ? name : login(name));
  const principal = ([kind, who]) => {
    if (kind === 'group') {
      const found = state.groups.find((item) => item.Title === who);
      return { Id: found.Id, Title: found.Title, LoginName: found.Title, PrincipalType: 8 };
    }
    const found = user(who);
    return { Id: found.Id, Title: found.Title, LoginName: found.LoginName, PrincipalType: 1 };
  };
  const assignments = (rows) => rows.map((row) => {
    const member = principal(row);
    const role = roleByKey(row[2]);
    return { PrincipalId: member.Id, Member: member, RoleDefinitionBindings: [{ Id: role.Id, Name: role.Name }] };
  });
  const requests = [];
  const ok = (body, status = 200) => ({ status, headers: {}, body });
  async function transport(url, init = {}) {
    const method = init.method ?? 'GET';
    requests.push({ url, method, body: init.body ?? null, headers: init.headers ?? null });
    const parsed = new URL(url);
    const path = decodeURIComponent(parsed.pathname);
    if (!path.startsWith('/sites/KEEL-RT-20261015/_api/')) return ok(null, 404);
    const api = path.slice('/sites/KEEL-RT-20261015/_api/'.length).toLowerCase();
    if (method === 'GET') {
      if (api === 'web') return ok({ Id: state.web.Id, Url: state.web.Url, HasUniqueRoleAssignments: state.web.HasUniqueRoleAssignments });
      if (api === 'web/roledefinitions') return ok({ value: structuredClone(state.roleDefinitions) });
      if (api === 'web/sitegroups') return ok({ value: state.groups.map(({ members, ...rest }) => structuredClone(rest)) });
      const members = /^web\/sitegroups\/getbyid\((\d+)\)\/users$/.exec(api);
      if (members) return ok({ value: state.groups.find((item) => item.Id === Number(members[1])).members.map((name) => ({ ...user(name), IsSiteAdmin: state.admins.includes(user(name).Title) })) });
      if (api === 'web/siteusers') return ok({ value: state.admins.map((name) => ({ ...user(name), IsSiteAdmin: true })) });
      if (api === 'web/roleassignments') return ok({ value: assignments(state.web_assignments) });
      if (api === 'web/lists') return ok({ value: state.lists.map(({ assignments: _, ...rest }) => structuredClone(rest)) });
      const listRoles = /^web\/lists\(guid'([^']+)'\)\/roleassignments$/.exec(api);
      if (listRoles) return ok({ value: assignments(state.lists.find((list) => list.Id === listRoles[1]).assignments) });
      return ok(null, 404);
    }
    const refused = onWrite?.(api, init);
    if (refused) return refused;
    if (api === 'web/roledefinitions') {
      const role = { Id: nextId += 1, Name: init.body.Name, Description: init.body.Description ?? null, RoleTypeKind: 0, Hidden: false, Order: init.body.Order, BasePermissions: init.body.BasePermissions };
      state.roleDefinitions.push(role);
      return ok({ Id: role.Id, Name: role.Name }, 201);
    }
    if (api === 'web/sitegroups') {
      const created = { ...group(nextId += 1, init.body.Title, []), ...init.body, OwnerTitle: 'KEEL Restorer' };
      state.groups.push(created);
      return ok({ Id: created.Id, Title: created.Title }, 201);
    }
    const addMember = /^web\/sitegroups\/getbyid\((\d+)\)\/users$/.exec(api);
    if (addMember) {
      state.groups.find((item) => item.Id === Number(addMember[1])).members.push(user(init.body.LoginName).Title);
      return ok({ Id: user(init.body.LoginName).Id }, 201);
    }
    if (api === 'web/ensureuser') return ok({ Id: user(init.body.logonName).Id, LoginName: init.body.logonName });
    const siteUser = /^web\/siteusers\/getbyid\((\d+)\)$/.exec(api);
    if (siteUser && init.headers?.['X-HTTP-Method'] === 'MERGE') {
      const found = [...users.values()].find((item) => item.Id === Number(siteUser[1]));
      if (init.body.IsSiteAdmin === true) state.admins.push(found.Title);
      return ok(null, 204);
    }
    const add = /^web\/(?:lists\(guid'([^']+)'\)\/)?roleassignments\/addroleassignment\(principalid=(\d+),roledefid=(\d+)\)$/.exec(api);
    if (add) {
      const role = state.roleDefinitions.find((item) => item.Id === Number(add[3]));
      const groupFound = state.groups.find((item) => item.Id === Number(add[2]));
      const userFound = [...users.values()].find((item) => item.Id === Number(add[2]));
      const row = groupFound ? ['group', groupFound.Title, role.Name] : ['user', userFound.Title, role.Name];
      (add[1] ? state.lists.find((list) => list.Id === add[1]).assignments : state.web_assignments).push(row);
      return ok(null, 200);
    }
    return ok(null, 404);
  }
  return { state, requests, transport, writes: () => requests.filter((request) => request.method !== 'GET') };
}
