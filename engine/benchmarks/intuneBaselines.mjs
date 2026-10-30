/**
 * Intune security baselines, matched setting by setting against the tenant.
 *
 * Microsoft publishes its security baselines (Windows, Defender for Endpoint, Edge,
 * Microsoft 365 Apps, Windows 365 and others) as settings catalog templates in each
 * tenant: `/deviceManagement/configurationPolicyTemplates` with
 * `templateFamily = baseline`. Each template lists its settings, each with the value
 * Microsoft recommends (the template's default value).
 *
 * Keel reads every baseline template and every version of it (readBaselineTemplates,
 * run after a backup by cli/keel-collect.mjs), then matches each baseline setting by
 * its settingDefinitionId against EVERY settings catalog policy in the newest
 * complete backup, not only policies made from the baseline. Policy names are never
 * used for matching. Each setting gets one result:
 *  - match:          every policy that sets it uses the baseline's value
 *  - different:      the policies that set it agree on another value
 *  - not-configured: no policy sets it
 *  - conflict:       two or more policies set it to different values
 *  - unknown:        no backup read the settings catalog policies in full
 * A baseline setting with no recommended value (Microsoft leaves the value to the
 * admin) matches when any policy sets it.
 *
 * Read-only toward the tenant. Templates are Microsoft-published reference data, so
 * they are kept in their own table (intune_baseline_template_read), not in a backup.
 */
import { newestCompleteRead } from './runChecks.mjs';
import { assertTenantRef } from '../store/tenantRef.mjs';

const TEMPLATES_PATH = '/deviceManagement/configurationPolicyTemplates';
// A complete read newer than this is reused; baselines change a few times a year.
export const TEMPLATE_READ_MAX_AGE_MS = 24 * 3_600_000;
// Reads kept per tenant (the newest ones); older ones are removed on each write.
const READS_KEPT = 3;
// How many snapshots are searched for a complete settings catalog read.
const SNAPSHOT_LOOKBACK = 50;

export const RESULTS = Object.freeze(['conflict', 'different', 'not-configured', 'match', 'unknown']);

function text(value) { return typeof value === 'string' && value.length > 0 ? value : null; }

function valueKey(values) { return JSON.stringify([...values].sort()); }

function scalar(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return null;
  return String(value);
}

/** The value a default template holds: an option id, or a constant. */
function defaultOf(defaultValue) {
  if (!defaultValue || typeof defaultValue !== 'object') return null;
  return scalar(defaultValue.settingDefinitionOptionId)
    ?? scalar(defaultValue.constantValue)
    ?? scalar(defaultValue.constant)
    ?? scalar(defaultValue.value);
}

/** The one option a value definition allows, or null when it allows none or several. */
function onlyAllowed(definition) {
  const options = Array.isArray(definition?.allowedOptions) ? definition.allowedOptions : [];
  return options.length === 1 ? scalar(options[0]?.itemId) : null;
}

const asList = (value) => (Array.isArray(value) ? value : value && typeof value === 'object' ? [value] : []);

/**
 * Every setting a template's setting instance holds, children included, in order:
 * [{ id, expected: string[] | null }]. Groups hold no value of their own, so only
 * their children are listed.
 */
export function templateSettings(instance, out = []) {
  if (!instance || typeof instance !== 'object') return out;
  const id = text(instance.settingDefinitionId);
  const valueKeys = Object.keys(instance).filter((key) => /ValueTemplate$/.test(key));
  const isGroup = valueKeys.some((key) => key.startsWith('group'));
  const expected = [];
  const children = [];
  for (const key of valueKeys) {
    for (const value of asList(instance[key])) {
      // The default is Microsoft's value. Without one, a recommended (or required)
      // definition that allows exactly one option names it instead.
      const found = defaultOf(value.defaultValue) ?? onlyAllowed(value.recommendedValueDefinition) ?? onlyAllowed(value.requiredValueDefinition);
      if (found !== null) expected.push(found);
      children.push(...asList(value.children), ...asList(value.defaultValue?.children));
    }
  }
  if (id && !isGroup) out.push({ id, expected: expected.length ? [...new Set(expected)].sort() : null });
  for (const child of children) templateSettings(child, out);
  return out;
}

/**
 * Every setting a policy's setting instance sets, children included:
 * [{ id, values: string[] }]. Groups hold no value of their own.
 */
export function policySettings(instance, out = []) {
  if (!instance || typeof instance !== 'object') return out;
  const id = text(instance.settingDefinitionId);
  const valueKeys = Object.keys(instance).filter((key) => /(SettingValue|CollectionValue)$/.test(key));
  const isGroup = valueKeys.some((key) => key.startsWith('group'));
  const values = [];
  const children = [];
  for (const key of valueKeys) {
    for (const value of asList(instance[key])) {
      const found = scalar(value.value);
      if (found !== null) values.push(found);
      children.push(...asList(value.children));
    }
  }
  if (id && !isGroup && values.length) out.push({ id, values: [...new Set(values)].sort() });
  for (const child of children) policySettings(child, out);
  return out;
}

function optionLabels(definition) {
  const labels = {};
  for (const option of asList(definition?.options)) {
    const itemId = text(option?.itemId);
    if (itemId) labels[itemId] = text(option.displayName) ?? itemId;
  }
  return labels;
}

/** One baseline template version in the compact shape Keel keeps. */
export function shapeTemplate(template, settingTemplates, categories = new Map()) {
  const definitions = new Map();
  for (const entry of settingTemplates) {
    for (const definition of asList(entry?.settingDefinitions)) {
      if (text(definition?.id)) definitions.set(definition.id, definition);
    }
  }
  const seen = new Set();
  const settings = [];
  for (const entry of settingTemplates) {
    for (const setting of templateSettings(entry?.settingInstanceTemplate)) {
      if (seen.has(setting.id)) continue;
      seen.add(setting.id);
      const definition = definitions.get(setting.id) ?? null;
      const categoryId = text(definition?.categoryId);
      settings.push({
        id: setting.id,
        name: text(definition?.displayName) ?? setting.id,
        description: text(definition?.description),
        categoryId,
        category: (categoryId && categories.get(categoryId)) ?? null,
        expected: setting.expected,
        labels: optionLabels(definition),
      });
    }
  }
  return {
    templateId: String(template.id),
    name: text(template.displayName) ?? String(template.id),
    version: text(template.displayVersion),
    state: text(template.lifecycleState),
    platforms: text(template.platforms),
    technologies: text(template.technologies),
    settings,
  };
}

/**
 * Reads every baseline template, every version, with its settings and their
 * definitions, through a GraphReader. Never throws for a Graph error: a template
 * whose settings could not be read is listed in `failures` and the read is partial.
 */
export async function readBaselineTemplates(reader) {
  const list = await reader.collect('beta', TEMPLATES_PATH);
  if (list.error) {
    return { outcome: 'failed', error: list.error.error ?? `Graph answered ${list.error.status}`, templates: [], failures: [] };
  }
  const baselines = list.items.filter((template) => String(template?.templateFamily ?? '').toLowerCase() === 'baseline'
    && String(template?.lifecycleState ?? '').toLowerCase() !== 'draft');
  const failures = [];
  const raw = [];
  for (const template of baselines) {
    const read = await reader.collect('beta', `${TEMPLATES_PATH}/${encodeURIComponent(template.id)}/settingTemplates?$expand=settingDefinitions`);
    if (read.error || read.capped) {
      failures.push({ templateId: String(template.id), name: text(template.displayName), error: read.error?.error ?? 'stopped before the last page' });
      continue;
    }
    raw.push({ template, settingTemplates: read.items });
  }
  // Category names, so settings group the way Intune shows them.
  const categoryIds = new Set();
  for (const { settingTemplates } of raw) {
    for (const entry of settingTemplates) {
      for (const definition of asList(entry?.settingDefinitions)) if (text(definition?.categoryId)) categoryIds.add(definition.categoryId);
    }
  }
  const categories = new Map();
  for (const categoryId of categoryIds) {
    const read = await reader.get('beta', `/deviceManagement/configurationCategories/${encodeURIComponent(categoryId)}?$select=id,displayName`);
    if (read.ok && text(read.body?.displayName)) categories.set(categoryId, read.body.displayName);
  }
  const templates = raw.map(({ template, settingTemplates }) => shapeTemplate(template, settingTemplates, categories));
  const outcome = failures.length || list.capped ? 'partial' : (templates.length ? 'complete' : 'complete-empty');
  return { outcome, error: list.capped ? 'the template list stopped before the last page' : null, templates, failures };
}

/** Stores one template read and keeps only the newest few for the tenant. */
export async function recordBaselineTemplateRead(client, { tenantRef, read, readAt = new Date() }) {
  assertTenantRef(tenantRef);
  const { rows: [row] } = await client.query(
    `INSERT INTO intune_baseline_template_read (tenant_ref, read_at, outcome, error, failures, templates)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id::text AS id`,
    [tenantRef, readAt, read.outcome, read.error ?? null, JSON.stringify(read.failures ?? []), JSON.stringify(read.templates ?? [])],
  );
  await client.query(
    `DELETE FROM intune_baseline_template_read
      WHERE tenant_ref = $1
        AND id NOT IN (SELECT id FROM intune_baseline_template_read WHERE tenant_ref = $1 ORDER BY read_at DESC, id DESC LIMIT ${READS_KEPT})
        -- The newest read that is not a failure stays, so failed reads never empty the page.
        AND id IS DISTINCT FROM (SELECT id FROM intune_baseline_template_read WHERE tenant_ref = $1 AND outcome <> 'failed' ORDER BY read_at DESC, id DESC LIMIT 1)`,
    [tenantRef],
  );
  return row.id;
}

/** True when no complete or partial template read is newer than `maxAgeMs`. A partial
 *  read counts, so a template that always fails is retried once a day, not every backup. */
export async function templatesDue(client, { tenantRef, now = new Date(), maxAgeMs = TEMPLATE_READ_MAX_AGE_MS }) {
  assertTenantRef(tenantRef);
  const { rows } = await client.query(
    `SELECT 1 FROM intune_baseline_template_read
      WHERE tenant_ref = $1 AND outcome IN ('complete', 'complete-empty', 'partial') AND read_at > $2 LIMIT 1`,
    [tenantRef, new Date(now.getTime() - maxAgeMs)],
  );
  return rows.length === 0;
}

/**
 * After a backup that read the settings catalog policies: read the baseline
 * templates when the last complete read is a day old or older. Logs one line and
 * never throws, so a failed read never changes the backup's outcome.
 */
export async function refreshBaselineTemplates(client, { tenantRef, reader, now = new Date(), logger = console }) {
  try {
    if (!await templatesDue(client, { tenantRef, now })) return null;
    const read = await readBaselineTemplates(reader);
    await recordBaselineTemplateRead(client, { tenantRef, read, readAt: now });
    const settings = read.templates.reduce((sum, template) => sum + template.settings.length, 0);
    logger.log(`intune security baselines: ${read.outcome}, ${read.templates.length} baseline versions with ${settings} settings`
      + `${read.failures.length ? `; ${read.failures.length} could not be read` : ''}${read.error ? ` (${read.error})` : ''}`);
    return read;
  } catch (error) {
    logger.log(`intune security baselines not read: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/** What each settings catalog policy sets, by setting: id -> [{ policyId, policyName, values }]. */
export function settingsByDefinition(policies) {
  const byId = new Map();
  for (const policy of policies) {
    const found = new Map();
    for (const entry of asList(policy?.settings)) {
      for (const setting of policySettings(entry?.settingInstance)) {
        const before = found.get(setting.id) ?? [];
        found.set(setting.id, [...new Set([...before, ...setting.values])].sort());
      }
    }
    for (const [id, values] of found) {
      const list = byId.get(id) ?? [];
      list.push({ policyId: text(policy?.id), policyName: text(policy?.name) ?? text(policy?.displayName), values });
      byId.set(id, list);
    }
  }
  return byId;
}

/** One baseline setting's result against what the policies set. */
export function matchSetting(setting, setBy) {
  if (setBy === null) return 'unknown';
  if (!setBy?.length) return 'not-configured';
  const distinct = new Set(setBy.map((entry) => valueKey(entry.values)));
  if (distinct.size > 1) return 'conflict';
  if (setting.expected === null) return 'match';
  return distinct.has(valueKey(setting.expected)) ? 'match' : 'different';
}

const emptyCounts = () => Object.fromEntries(RESULTS.map((result) => [result, 0]));

/**
 * Every setting of every baseline version, matched against the policies. `policies`
 * null means no complete read of them exists, and every setting is 'unknown'.
 */
export function matchBaselines(templates, policies) {
  const byId = policies ? settingsByDefinition(policies) : null;
  return templates.map((template) => {
    const counts = emptyCounts();
    const settings = template.settings.map((setting) => {
      const setBy = byId ? (byId.get(setting.id) ?? []) : null;
      const result = matchSetting(setting, setBy);
      counts[result] += 1;
      return { ...setting, result, setBy: setBy ?? [] };
    });
    return { ...template, counts, settings };
  });
}

/**
 * What the portal shows: the newest template read, the newest complete backup of
 * the settings catalog policies, and every setting's result.
 */
export async function intuneBaselineResults(client, { tenantRef, now = new Date() }) {
  assertTenantRef(tenantRef);
  // The newest read (for a failure to say), and the newest usable one with its templates.
  const { rows: [newest = null] } = await client.query(
    `SELECT read_at, outcome, error FROM intune_baseline_template_read
      WHERE tenant_ref = $1 AND read_at <= $2 ORDER BY read_at DESC, id DESC LIMIT 1`,
    [tenantRef, now],
  );
  const { rows: [usable = null] } = await client.query(
    `SELECT read_at, outcome, error, failures, templates FROM intune_baseline_template_read
      WHERE tenant_ref = $1 AND read_at <= $2 AND outcome <> 'failed' ORDER BY read_at DESC, id DESC LIMIT 1`,
    [tenantRef, now],
  );
  const { rows: snapshots } = await client.query(
    `SELECT id, tenant_ref, started_at, completed_at, coverage_digest
       FROM snapshot
      WHERE tenant_ref = $1 AND completed_at IS NOT NULL AND completed_at <= $2
      ORDER BY completed_at DESC, id DESC
      LIMIT ${SNAPSHOT_LOOKBACK}`,
    [tenantRef, now],
  );
  const policyRead = await newestCompleteRead(client, { tenantRef, resourceType: 'configurationPolicy', snapshots });
  const baselines = usable ? matchBaselines(usable.templates ?? [], policyRead ? policyRead.resources : null) : [];
  return {
    templates: usable ? {
      readAt: new Date(usable.read_at).toISOString(),
      outcome: usable.outcome,
      error: usable.error,
      failures: usable.failures ?? [],
    } : null,
    // A newer read that failed, said beside the older one still shown.
    lastFailure: newest && newest.outcome === 'failed' ? { readAt: new Date(newest.read_at).toISOString(), error: newest.error } : null,
    policies: policyRead ? {
      snapshotId: policyRead.snapshotId,
      readAt: policyRead.observation.window?.endedAt ?? null,
      count: policyRead.resources.length,
    } : null,
    baselines,
  };
}
