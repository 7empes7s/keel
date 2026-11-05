/**
 * Issue #1007: an access review definition names who is reviewed, who reviews
 * and who is told by Graph queries ("/groups/{id}/transitiveMembers",
 * "/users/{id}", "./manager"), not by bare ids, so the GUID walk never sees the
 * users, groups and apps in them. The id of the one user, group or app a query
 * names is a reference at the query's own path (`scope.query`,
 * `reviewers[0].query`), resolved through that object's natural key; the
 * restore writer puts the target's id back into the same query.
 */
const QUERY_REFERENCE_TYPES = new Set(['accessReviewScheduleDefinition']);

const GUID_TEXT = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** A user, group or app in a query (after an optional /v1.0 or /beta). */
export const QUERY_PRINCIPAL = new RegExp(`/(users|groups|servicePrincipals)/(${GUID_TEXT})(?![0-9a-f-])`, 'i');
/** Every id in a query: one that is not a single user, group or app cannot be matched. */
export const QUERY_GUIDS = new RegExp(GUID_TEXT, 'gi');

/** Every `query` text below a value, with its path ("scope.principalScopes[0].query"). */
export function* queryStrings(node, path = '') {
  if (Array.isArray(node)) {
    for (const [index, item] of node.entries()) yield* queryStrings(item, `${path}[${index}]`);
    return;
  }
  if (!node || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node)) {
    const at = path ? `${path}.${key}` : key;
    if (key === 'query' && typeof value === 'string') yield { path: at, query: value };
    else yield* queryStrings(value, at);
  }
}

/** The references a resource of this type holds inside its queries: { path, guid }. */
export function* queryReferenceValues(type, obj) {
  if (!QUERY_REFERENCE_TYPES.has(type)) return;
  for (const { path, query } of queryStrings(obj)) {
    const guids = query.match(QUERY_GUIDS) ?? [];
    const match = QUERY_PRINCIPAL.exec(query);
    // A query naming more than one id is not a reference KEEL can rewrite.
    if (match && guids.length === 1) yield { path, guid: match[2].toLowerCase() };
  }
}
