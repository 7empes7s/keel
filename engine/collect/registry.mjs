/**
 * Adapter registry (spec §4.1): the mapping from resource type to its
 * ResourceTypeDescriptor and serving adapter implementation. Registration is
 * static and explicit — a type is collectable only because a descriptor and an
 * adapter were registered for it, never by runtime discovery or fallback.
 *
 * adapterImpl implements { collect(reader, scope) } today; apply/verify join
 * the contract when the restore lane needs them.
 */
const entries = new Map(); // type -> { descriptor, adapter }

export function register(descriptor, adapterImpl) {
  if (!descriptor || typeof descriptor.type !== 'string') {
    throw new Error('descriptor must declare a string type');
  }
  if (!adapterImpl || typeof adapterImpl.collect !== 'function') {
    throw new Error(`adapter for ${descriptor.type} must implement collect(reader, scope)`);
  }
  if (entries.has(descriptor.type)) {
    throw new Error(`resource type ${descriptor.type} is already registered`);
  }
  entries.set(descriptor.type, { descriptor, adapter: adapterImpl });
}

export function get(type) {
  const entry = entries.get(type);
  if (!entry) throw new Error(`no adapter registered for resource type ${type}`);
  return entry;
}

export function list() {
  return [...entries.values()].map(({ descriptor }) => descriptor);
}
