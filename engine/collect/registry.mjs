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

// Roadmap task-102: workload adapters (SharePoint first) register separately. They
// are not catalogue types, the Entra snapshot path never iterates them, and each
// ships disabled: `enabledByDefault` must be false until live qualification enables
// it through the task-101 ledger.
const workloads = new Map(); // type -> { descriptor, adapter }

export function registerWorkload(descriptor, adapterImpl) {
  if (!descriptor || typeof descriptor.type !== 'string' || typeof descriptor.workload !== 'string') {
    throw new Error('workload descriptor must declare a string type and workload');
  }
  if (descriptor.enabledByDefault !== false) {
    throw new Error(`workload ${descriptor.type} must ship disabled (enabledByDefault: false)`);
  }
  if (!adapterImpl || typeof adapterImpl.collect !== 'function') {
    throw new Error(`adapter for ${descriptor.type} must implement collect(reader, scope)`);
  }
  if (workloads.has(descriptor.type) || entries.has(descriptor.type)) {
    throw new Error(`resource type ${descriptor.type} is already registered`);
  }
  workloads.set(descriptor.type, { descriptor, adapter: adapterImpl });
}

export function listWorkloads() {
  return [...workloads.values()].map(({ descriptor }) => descriptor);
}
