/**
 * Wave 2 IDO fixture: an in-memory Graph for the identity object and Intune
 * record writers. Objects live at their path; a collection lists the objects
 * under it (or, before any child write, the parent's inline array of the same
 * name); `$expand=x` adds the `x` collection to the object read. The actions
 * the writers use are modelled: /assign, /targetApps, a policy set's /update, owners/$ref,
 * appRoleAssignments, createNewVersion and assignLicense. Every call is kept in
 * `calls` (method, version, path, body) for the tests to inspect.
 */
export function idoFakeGraph({ seed = {}, failWrites = () => null } = {}) {
  const objects = new Map(Object.entries(seed).map(([path, body]) => [path, structuredClone(body)]));
  const collections = new Map();
  const calls = [];
  let next = 0;

  const parentOf = (path) => path.slice(0, path.lastIndexOf('/'));
  const nameOf = (path) => path.slice(path.lastIndexOf('/') + 1);
  const collectionOf = (path) => {
    if (collections.has(path)) return collections.get(path);
    const inline = objects.get(parentOf(path))?.[nameOf(path)];
    const children = [...objects.entries()].filter(([key]) => parentOf(key) === path).map(([, body]) => body);
    const list = Array.isArray(inline) ? structuredClone(inline) : children;
    return list;
  };
  const setCollection = (path, list) => {
    collections.set(path, list);
    const parent = objects.get(parentOf(path));
    if (parent) objects.set(parentOf(path), { ...parent, [nameOf(path)]: list });
  };
  const ok = (status, body) => ({ ok: true, status, body });
  const notFound = () => ({ ok: false, status: 404, body: { error: { code: 'ResourceNotFound' } } });

  return {
    objects,
    calls,
    async write(version, path, { method, body }) {
      calls.push({ version, method, path, body: body === undefined ? undefined : structuredClone(body) });
      const forced = failWrites({ version, method, path, body });
      if (forced) return forced;
      const action = nameOf(path);
      const owner = parentOf(path);
      if (method === 'POST' && action === 'assign') {
        if (!objects.has(owner)) return notFound();
        setCollection(`${owner}/assignments`, (body.assignments ?? []).map((entry, index) => ({ ...entry, id: `assignment-${index}` })));
        return ok(200, null);
      }
      if (method === 'POST' && action === 'targetApps') {
        if (!objects.has(owner)) return notFound();
        setCollection(`${owner}/apps`, (body.apps ?? []).map((app, index) => ({ ...app, id: `app-${index}` })));
        return ok(204, null);
      }
      if (method === 'POST' && action === 'updateDefinitionValues') {
        // An administrative template's settings: removed by id, then added
        // with their values (each bound to its setting and field by URL).
        if (!objects.has(owner)) return notFound();
        const idOf = (bind) => /\('([^']+)'\)$/.exec(String(bind))?.[1];
        const removed = new Set(body.deletedIds ?? []);
        const settings = collectionOf(`${owner}/definitionValues`).filter((setting) => !removed.has(setting.id));
        for (const setting of body.added ?? []) {
          next += 1;
          const id = `setting-${next}`;
          settings.push({ id, enabled: setting.enabled, definition: { id: idOf(setting['definition@odata.bind']) } });
          collections.set(`${owner}/definitionValues/${id}/presentationValues`, (setting.presentationValues ?? [])
            .map(({ 'presentation@odata.bind': bind, ...value }, index) => ({ ...value, id: `${id}-value-${index}`, presentation: { id: idOf(bind) } })));
        }
        setCollection(`${owner}/definitionValues`, settings);
        return ok(204, null);
      }
      if (method === 'POST' && action === 'update' && parentOf(owner) === '/deviceAppManagement/policySets') {
        // A policy set's items: removed by id, then added (restore gaps batch 6).
        if (!objects.has(owner)) return notFound();
        const removed = new Set(body.deletedPolicySetItemIds ?? []);
        const items = collectionOf(`${owner}/items`).filter((item) => !removed.has(item.id));
        for (const item of body.addedPolicySetItems ?? []) {
          next += 1;
          items.push({ ...item, id: `item-${next}`, status: 'notAssigned' });
        }
        setCollection(`${owner}/items`, items);
        return ok(204, null);
      }
      if (method === 'POST' && action === 'createNewVersion') {
        if (!objects.has(owner)) return notFound();
        const { tasks, ...fields } = body.workflow;
        const current = objects.get(owner);
        objects.set(owner, { ...current, ...fields, version: (current.version ?? 1) + 1 });
        setCollection(`${owner}/tasks`, tasks.map((task, index) => ({ ...task, id: `task-${index}` })));
        return ok(201, objects.get(owner));
      }
      if (method === 'POST' && action === 'assignLicense') {
        const user = objects.get(owner);
        if (!user) return notFound();
        if (!user.usageLocation) return { ok: false, status: 400, body: { error: { code: 'Request_BadRequest', message: 'usage location is not set' } } };
        const added = body.addLicenses.map((entry) => ({ skuId: entry.skuId, disabledPlans: entry.disabledPlans }));
        objects.set(owner, {
          ...user,
          assignedLicenses: added,
          licenseAssignmentStates: added.map((entry) => ({ ...entry, assignedByGroup: null, state: 'Active' })),
        });
        return ok(200, objects.get(owner));
      }
      if (method === 'POST' && action === '$ref') {
        const id = String(body['@odata.id']).split('/').pop();
        const list = collectionOf(owner);
        if (list.some((item) => item.id === id)) return { ok: false, status: 400, body: { error: { code: 'Request_BadRequest', message: 'One or more added object references already exist' } } };
        setCollection(owner, [...list, { id }]);
        return ok(204, null);
      }
      if (method === 'POST') {
        next += 1;
        const id = body?.id ?? `fixture-${next}`;
        const created = { ...structuredClone(body), id };
        if (created.passwordProfile) delete created.passwordProfile; // never readable
        const collectionPath = path;
        if (collections.has(collectionPath) || Array.isArray(objects.get(parentOf(collectionPath))?.[nameOf(collectionPath)])) {
          setCollection(collectionPath, [...collectionOf(collectionPath), created]);
        } else {
          objects.set(`${path}/${id}`, created);
        }
        return ok(201, created);
      }
      if (method === 'PUT') {
        objects.set(path, structuredClone(body));
        return ok(204, null);
      }
      if (!objects.has(path)) {
        // A child of an inline collection (an allowed value, a localized message).
        const list = collectionOf(owner);
        const index = list.findIndex((item) => String(item.id) === decodeURIComponent(action));
        if (index < 0 || method !== 'PATCH') return notFound();
        const updated = [...list];
        updated[index] = { ...updated[index], ...body };
        setCollection(owner, updated);
        return ok(204, null);
      }
      if (method === 'PATCH') {
        objects.set(path, { ...objects.get(path), ...structuredClone(body) });
        return ok(204, null);
      }
      if (method === 'DELETE') {
        objects.delete(path);
        return ok(204, null);
      }
      return { ok: false, status: 405, body: null };
    },
    async read(version, requested) {
      calls.push({ version, method: 'GET', path: requested });
      const [path, query = ''] = requested.split('?');
      const expand = /\$expand=([^&(]+)/.exec(decodeURIComponent(query))?.[1] ?? null;
      if (objects.has(path)) {
        const body = structuredClone(objects.get(path));
        if (expand) for (const name of expand.split(',')) body[name] = collectionOf(`${path}/${name}`);
        return ok(200, body);
      }
      if (objects.has(parentOf(path)) || collections.has(path)) return ok(200, { value: collectionOf(path) });
      return notFound();
    },
  };
}
