/**
 * Wave 1 DISC: the readable Graph surface, from a $metadata (CSDL) document.
 *
 * A root entity set (`/users`) is a collection. A root singleton (`/deviceManagement`)
 * is one object, and its containment navigation properties are the types under it
 * (`/deviceManagement/deviceConfigurations`). Single-valued containment children are
 * walked the same way, to `maxDepth` path segments. Four reaches every catalogued
 * path, the deepest being
 * `/policies/crossTenantAccessPolicy/templates/multiTenantOrganizationIdentitySynchronization`;
 * against Microsoft's published metadata it adds about 20 v1.0 and 40 beta paths over
 * three, and a fifth segment adds two more. Non-containment navigation properties
 * point at objects held elsewhere, so they are not types of their own.
 *
 * This reads the flat, well-known shape of a Graph $metadata document; it is not a
 * general XML parser. It understands schema aliases, BaseType inheritance and
 * self-closing EntityType elements, which tools/qualification/apiDrift.mjs's parser
 * (built for field diffs) does not need.
 */

export const DEFAULT_MAX_DEPTH = 4;

// Signed-in-user roots: an application identity cannot address them, and what lies
// under /me and /drive is one user's mail, files and chats, which discovery never lists.
export const SKIPPED_ROOTS = Object.freeze(['me', 'drive']);

function attribute(tag, name) {
  const match = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
  return match ? match[1] : null;
}

/**
 * Parses the parts of a CSDL document discovery needs.
 * Returns { version, roots: [{ name, kind, type }], types: Map<qualifiedName, { baseType, navigation, properties }> }.
 */
export function parseMetadata(xml) {
  if (typeof xml !== 'string' || !/<(\w+:)?Schema[\s>]/.test(xml)) {
    throw new Error('not a CSDL metadata document (no Schema element)');
  }
  const version = attribute(xml.match(/<(\w+:)?Edmx[\s>][^>]*>/)?.[0] ?? '', 'Version');

  // Schemas, so an alias (`graph.user`) and a namespace (`microsoft.graph.user`)
  // resolve to the same qualified name.
  const schemas = [];
  for (const match of xml.matchAll(/<(?:\w+:)?Schema\s[^>]*>/g)) {
    const namespace = attribute(match[0], 'Namespace');
    if (!namespace) throw new Error('malformed Schema element (Namespace required)');
    schemas.push({ index: match.index, namespace, alias: attribute(match[0], 'Alias') });
  }
  const aliases = new Map(schemas.filter((schema) => schema.alias).map((schema) => [schema.alias, schema.namespace]));
  const namespaceAt = (index) => {
    let current = schemas[0]?.namespace ?? null;
    for (const schema of schemas) if (schema.index <= index) current = schema.namespace;
    return current;
  };
  const qualify = (ref) => {
    if (typeof ref !== 'string' || !ref) return null;
    const dot = ref.lastIndexOf('.');
    if (dot === -1) return ref;
    const prefix = ref.slice(0, dot);
    return `${aliases.get(prefix) ?? prefix}.${ref.slice(dot + 1)}`;
  };
  const typeRef = (ref) => {
    const collection = /^Collection\(.*\)$/.test(ref ?? '');
    return { type: qualify(collection ? ref.slice('Collection('.length, -1) : ref), collection };
  };

  const types = new Map();
  for (const match of xml.matchAll(/<(?:\w+:)?EntityType\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?EntityType>)/g)) {
    const tag = ` ${match[1]}`;
    const name = attribute(tag, 'Name');
    if (!name) throw new Error('malformed EntityType element (Name required)');
    const navigation = [];
    const properties = [];
    for (const property of (match[2] ?? '').matchAll(/<(?:\w+:)?Property\s[^>]*>/g)) {
      const propertyName = attribute(property[0], 'Name');
      if (propertyName) properties.push(propertyName);
    }
    for (const nav of (match[2] ?? '').matchAll(/<(?:\w+:)?NavigationProperty\s[^>]*>/g)) {
      const navName = attribute(nav[0], 'Name');
      const ref = attribute(nav[0], 'Type');
      if (!navName || !ref) throw new Error(`malformed NavigationProperty in EntityType ${name}`);
      navigation.push({ name: navName, ...typeRef(ref), containsTarget: attribute(nav[0], 'ContainsTarget') === 'true' });
    }
    types.set(`${namespaceAt(match.index)}.${name}`, { baseType: qualify(attribute(tag, 'BaseType')), navigation, properties });
  }

  const roots = [];
  for (const match of xml.matchAll(/<(?:\w+:)?(EntitySet|Singleton)\s[^>]*>/g)) {
    const kind = match[1] === 'EntitySet' ? 'entitySet' : 'singleton';
    const name = attribute(match[0], 'Name');
    const type = qualify(attribute(match[0], kind === 'entitySet' ? 'EntityType' : 'Type'));
    if (!name || !type) throw new Error(`malformed ${match[1]} element (Name and type required)`);
    roots.push({ name, kind, type });
  }
  if (roots.length === 0) throw new Error('CSDL document declares no EntitySet or Singleton');
  return { version, roots, types };
}

function inherited(types, typeName, pick) {
  const seen = new Set();
  const out = [];
  let current = typeName;
  while (current && types.has(current) && !seen.has(current)) {
    seen.add(current);
    out.push(...pick(types.get(current)));
    current = types.get(current).baseType;
  }
  return out;
}

/** Every navigation property of a type, its base types' included (nearest wins). */
export function navigationOf(types, typeName) {
  const out = new Map();
  for (const nav of inherited(types, typeName, (entry) => entry.navigation)) if (!out.has(nav.name)) out.set(nav.name, nav);
  return [...out.values()];
}

/** True when a type holds data of its own: a structural property besides its id. */
export function holdsData(types, typeName) {
  return inherited(types, typeName, (entry) => entry.properties ?? []).some((name) => name !== 'id');
}

const shortName = (qualified) => (qualified ? qualified.slice(qualified.lastIndexOf('.') + 1) : null);

/**
 * The discoverable paths of a parsed document, in document order:
 * [{ path, kind: 'entitySet'|'singleton'|'navigation', entityType, collection }].
 *
 * A single object that only groups other types (`/identity`, `/policies`: no property
 * but its id, and containment children) is walked but not listed: its children are
 * the types. One with settings of its own (`/deviceManagement`) is listed as well.
 */
export function discoverablePaths(parsed, { maxDepth = DEFAULT_MAX_DEPTH, skippedRoots = SKIPPED_ROOTS } = {}) {
  const out = [];
  const seen = new Set();
  const visit = (entry, typeName, depth) => {
    const key = entry.path.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const children = entry.collection || depth >= maxDepth ? [] : navigationOf(parsed.types, typeName).filter((nav) => nav.containsTarget);
    const groupingOnly = children.length > 0 && !holdsData(parsed.types, typeName);
    if (!groupingOnly) out.push(entry);
    for (const nav of children) {
      visit({ path: `${entry.path}/${nav.name}`, kind: 'navigation', entityType: shortName(nav.type), collection: nav.collection }, nav.type, depth + 1);
    }
  };
  for (const root of parsed.roots) {
    if (skippedRoots.includes(root.name)) continue;
    visit({ path: `/${root.name}`, kind: root.kind, entityType: shortName(root.type), collection: root.kind === 'entitySet' }, root.type, 1);
  }
  return out;
}
