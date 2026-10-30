/**
 * ScubaGear's config file, per tenant. ScubaGear reads a few lists only the tenant can
 * give (its config file), and Keel keeps them as a customer setting:
 *  - sensitive users: the people whose names anti-phish policies must protect against
 *    impersonation (MS.SECURITYSUITE.2.1v1, `SecuritySuite.<id>.SensitiveUsers`);
 *  - partner domains: the suppliers' and partners' domains they must protect
 *    (MS.SECURITYSUITE.2.3v1, `SecuritySuite.<id>.PartnerDomains`);
 *  - emergency (break-glass) accounts: left out of the sign-in rules
 *    (`Aad.<id>.CapExclusions.Users`) and allowed a permanent admin role
 *    (`Aad.MS.AAD.7.4v1.RoleExclusions.Users`). These are not a list of their own: they
 *    are the accounts registered under Emergency access (breakglass_account), so the
 *    tenant names them once.
 *
 * A rule that needs a list the tenant has not set reads "could not check", never a pass
 * or a fail (controls.mjs). Lists are kept in Keel's own database only; nothing here
 * reads or writes Microsoft 365. Each change is written to the audit record as counts,
 * so the record holds no addresses.
 */
import { can } from '../../authz/can.mjs';
import { findPrincipalById } from '../../authz/principals.mjs';
import { appendEvidence } from '../../govern/evidence.mjs';
import { assertTenantRef } from '../../store/tenantRef.mjs';

export const SCUBA_CONFIG_LIST_EVIDENCE_KIND = 'scuba-config-list';
export const SCUBA_LIST_MAX_ENTRIES = 500;

// ScubaGear's default run settings: a commercial cloud and no exclusions.
export const DEFAULT_SCUBA_CONFIG = Object.freeze({ M365Environment: 'commercial', Aad: Object.freeze({}), Exo: Object.freeze({}) });

const EMAIL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** The lists a tenant sets, in the order the Compliance page shows them. */
export const SCUBA_LISTS = Object.freeze({
  'sensitive-users': Object.freeze({
    policyId: 'MS.SECURITYSUITE.2.1v1', key: 'SensitiveUsers', maxLength: 254,
    valid: (entry) => EMAIL.test(entry), what: 'an email address',
  }),
  'partner-domains': Object.freeze({
    policyId: 'MS.SECURITYSUITE.2.3v1', key: 'PartnerDomains', maxLength: 253,
    valid: (entry) => DOMAIN.test(entry), what: 'a domain name',
  }),
});
export const SCUBA_LIST_NAMES = Object.freeze(Object.keys(SCUBA_LISTS));

// The sign-in (Conditional Access) rules that let named users be left out of a policy,
// and the rule that lets named users hold an admin role permanently. A test keeps both
// equal to the pinned Rego.
export const SIGN_IN_EXCLUSION_RULES = Object.freeze([
  'MS.AAD.1.1v1', 'MS.AAD.2.1v1', 'MS.AAD.2.3v1', 'MS.AAD.3.1v1', 'MS.AAD.3.2v2',
  'MS.AAD.3.6v1', 'MS.AAD.3.7v1', 'MS.AAD.3.8v1', 'MS.AAD.3.9v1',
]);
export const ROLE_EXCLUSION_RULES = Object.freeze(['MS.AAD.7.4v1']);

export class ScubaConfigListError extends Error {}

/** The list a rule needs the tenant to set, or null. */
export function listForRule(policyId) {
  return SCUBA_LIST_NAMES.find((name) => SCUBA_LISTS[name].policyId === policyId) ?? null;
}

/**
 * Entries as typed, cleaned: trimmed, lower case, without repeats, sorted. Throws with
 * the first entry that is not valid for the list, so nothing half-valid is kept.
 */
export function normaliseEntries(list, entries) {
  const spec = SCUBA_LISTS[list];
  if (!spec) throw new ScubaConfigListError(`unknown list: ${list} (one of ${SCUBA_LIST_NAMES.join(', ')})`);
  if (!Array.isArray(entries)) throw new ScubaConfigListError('entries must be a list');
  const clean = new Set();
  for (const raw of entries) {
    if (typeof raw !== 'string') throw new ScubaConfigListError('each entry must be text');
    const entry = raw.trim().toLowerCase();
    if (entry === '') continue;
    if (entry.length > spec.maxLength || !spec.valid(entry)) throw new ScubaConfigListError(`not ${spec.what}: ${raw.trim().slice(0, 80)}`);
    clean.add(entry);
  }
  if (clean.size > SCUBA_LIST_MAX_ENTRIES) throw new ScubaConfigListError(`at most ${SCUBA_LIST_MAX_ENTRIES} entries`);
  return [...clean].sort();
}

// An install whose schema predates a table reads as nothing set, never as an error.
async function tableExists(client, name) {
  const { rows: [row] } = await client.query('SELECT to_regclass($1) AS name', [name]);
  return Boolean(row?.name);
}

async function emergencyAccounts(client, tenantRef) {
  if (!await tableExists(client, 'breakglass_account')) return [];
  const { rows } = await client.query(
    'SELECT account_id, label FROM breakglass_account WHERE tenant_ref = $1 AND retired_at IS NULL ORDER BY label, account_id',
    [tenantRef],
  );
  return rows.map((row) => ({ accountId: row.account_id, label: row.label }));
}

/**
 * Every list with its entries and who set it last (an unset list is empty, with no
 * one), and the emergency accounts the sign-in and admin role rules leave out.
 */
export async function getScubaConfigLists(client, { tenantRef }) {
  assertTenantRef(tenantRef);
  const { rows } = await tableExists(client, 'scuba_config_list')
    ? await client.query('SELECT list, entries, updated_by, updated_at FROM scuba_config_list WHERE tenant_ref = $1', [tenantRef])
    : { rows: [] };
  const byList = new Map(rows.map((row) => [row.list, row]));
  return {
    lists: SCUBA_LIST_NAMES.map((list) => {
      const row = byList.get(list);
      return {
        list,
        policyId: SCUBA_LISTS[list].policyId,
        entries: Array.isArray(row?.entries) ? row.entries.filter((entry) => typeof entry === 'string') : [],
        updatedBy: row?.updated_by ?? null,
        updatedAt: row?.updated_at ?? null,
      };
    }),
    emergencyAccounts: await emergencyAccounts(client, tenantRef),
  };
}

/**
 * ScubaGear's `scuba_config` input from the tenant's lists: the sensitive users and
 * partner domains for their rules, and the emergency accounts left out of every
 * sign-in rule that allows it and allowed a permanent admin role. Pure.
 */
export function scubaConfigFrom({ lists = [], emergencyAccounts: accounts = [] } = {}) {
  const config = { M365Environment: DEFAULT_SCUBA_CONFIG.M365Environment, Aad: {}, Exo: {} };
  const users = [...new Set(accounts.map((account) => account.accountId))].sort();
  if (users.length) {
    for (const policyId of SIGN_IN_EXCLUSION_RULES) config.Aad[policyId] = { CapExclusions: { Users: users } };
    for (const policyId of ROLE_EXCLUSION_RULES) config.Aad[policyId] = { RoleExclusions: { Users: users } };
  }
  for (const { list, entries } of lists) {
    const spec = SCUBA_LISTS[list];
    if (!spec || !entries?.length) continue;
    config.SecuritySuite ??= {};
    config.SecuritySuite[spec.policyId] = { [spec.key]: [...entries] };
  }
  return config;
}

/** The tenant's `scuba_config`, for a compliance run. */
export async function loadScubaConfig(client, { tenantRef }) {
  return scubaConfigFrom(await getScubaConfigLists(client, { tenantRef }));
}

/** Whether `config` holds the list a rule needs (a rule that needs none always does). */
export function configHasList(config, policyId) {
  const list = listForRule(policyId);
  if (!list) return true;
  const entries = config?.SecuritySuite?.[policyId]?.[SCUBA_LISTS[list].key];
  return Array.isArray(entries) && entries.length > 0;
}

/**
 * Replace one list. The actor must hold `configuration` now. The audit record is
 * written first, so a list never changes without one. An empty list unsets it.
 */
export async function setScubaConfigList(client, { tenantRef, list, entries, actor, now = new Date() }) {
  assertTenantRef(tenantRef);
  if (typeof actor !== 'string' || actor.length === 0) throw new ScubaConfigListError('a list change needs an actor');
  const clean = normaliseEntries(list, entries);
  const principal = await findPrincipalById(client, actor);
  if (!principal || !(await can(client, principal, 'configuration', now))) {
    throw new Error('forbidden: setting a ScubaGear list requires configuration');
  }
  const before = (await getScubaConfigLists(client, { tenantRef })).lists.find((entry) => entry.list === list);
  const previous = new Set(before.entries);
  const added = clean.filter((entry) => !previous.has(entry)).length;
  const removed = before.entries.filter((entry) => !clean.includes(entry)).length;
  if (added === 0 && removed === 0 && before.updatedAt) return { changed: false, list: before };
  await appendEvidence(client, {
    tenantRef,
    kind: SCUBA_CONFIG_LIST_EVIDENCE_KIND,
    subject: { list, policyId: SCUBA_LISTS[list].policyId, count: clean.length, previousCount: before.entries.length, added, removed },
    actor,
  });
  await client.query(
    `INSERT INTO scuba_config_list (tenant_ref, list, entries, updated_by, updated_at)
     VALUES ($1, $2, $3::jsonb, $4, now())
     ON CONFLICT (tenant_ref, list)
       DO UPDATE SET entries = EXCLUDED.entries, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [tenantRef, list, JSON.stringify(clean), actor],
  );
  const after = (await getScubaConfigLists(client, { tenantRef })).lists.find((entry) => entry.list === list);
  return { changed: true, list: after, added, removed };
}
