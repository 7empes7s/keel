/**
 * The full CISA ScubaGear rule set, imported from the pinned, hash-checked copy beside
 * this file (pin.json, v2.0.0/), with a report of what each rule reads and whether Keel
 * reads it.
 *
 * Nothing here runs a rule or touches a tenant. It answers:
 *  - which rules exist, per product, with their statement, SHALL/SHOULD, NIST mapping
 *    and whether CISA marks them as a manual check (importScubaGearRules);
 *  - for each rule, which ScubaGear input keys it reads and whether Keel collects each
 *    one (scubaCoverage). Rules whose inputs Keel does not read are the rules that will
 *    read "could not check" once the rules run.
 *
 * Every file is checked against MANIFEST.sha256, and the manifest itself against the
 * hash in pin.json, before it is read. A file on disk that the manifest does not list
 * is refused too, so nothing unpinned can sit beside the pinned copy.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { regoRuleInputs } from './rego.mjs';
import { SCUBA_INPUT_SOURCES } from './inputs.mjs';

export const DEFAULT_PIN_PATH = join(dirname(fileURLToPath(import.meta.url)), 'pin.json');
// Product order on every list: identity first, then mail and security, then collaboration, then apps.
export const PRODUCT_ORDER = Object.freeze(['aad', 'exo', 'securitysuite', 'sharepoint', 'teams', 'powerplatform', 'powerbi']);
export const RULE_STATES = Object.freeze(['ready', 'partial', 'missing-input', 'manual']);

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function listFiles(root, dir = root) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((item) => {
    const path = join(dir, item.name);
    return item.isDirectory() ? listFiles(root, path) : [`./${relative(root, path).split('\\').join('/')}`];
  });
}

/** Reads pin.json and returns a reader that only hands out manifest-checked bytes. */
export function openPinnedScubaGear({ pinPath = DEFAULT_PIN_PATH } = {}) {
  const pin = JSON.parse(readFileSync(pinPath, 'utf8'));
  if (!/public domain/i.test(pin?.licensing?.status ?? '')
    || pin.licensing.attributionRequired !== false || pin.licensing.commercialUseRestricted !== false) {
    throw new Error('ScubaGear pin is not the unrestricted public-domain (CC0) grant');
  }
  for (const field of ['version', 'commitSha', 'localPath', 'manifest', 'manifestSha256']) {
    if (typeof pin[field] !== 'string' || !pin[field]) throw new Error(`ScubaGear pin is missing ${field}`);
  }
  const base = dirname(pinPath);
  const root = join(base, pin.localPath);
  const manifestBytes = readFileSync(join(base, pin.manifest));
  if (sha256(manifestBytes) !== pin.manifestSha256) throw new Error('ScubaGear MANIFEST.sha256 does not match the hash in pin.json');
  const manifest = new Map();
  for (const line of manifestBytes.toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    const match = /^([0-9a-f]{64}) {2}(\.\/\S.*)$/.exec(line);
    if (!match) throw new Error(`unreadable MANIFEST.sha256 line: ${line}`);
    manifest.set(match[2], match[1]);
  }
  const manifestName = `./${relative(root, join(base, pin.manifest)).split('\\').join('/')}`;
  const unlisted = listFiles(root).filter((file) => file !== manifestName && !manifest.has(file));
  if (unlisted.length) throw new Error(`files not in MANIFEST.sha256: ${unlisted.join(', ')}`);

  const read = (relativePath) => {
    const key = `./${relativePath}`;
    const expected = manifest.get(key);
    if (!expected) throw new Error(`no MANIFEST.sha256 entry for ${key}`);
    const bytes = readFileSync(join(root, relativePath));
    if (sha256(bytes) !== expected) throw new Error(`MANIFEST.sha256 hash mismatch for ${key}`);
    return bytes.toString('utf8');
  };
  const verifyAll = () => { for (const file of manifest.keys()) read(file.slice(2)); return manifest.size; };
  return { pin, read, verifyAll, files: [...manifest.keys()] };
}

// One rule per `#### <id>` heading, closed by its `<!--Policy: <id>; Criticality: X -->` marker.
function parseBaseline(markdown, product) {
  const rules = [];
  let section = null;
  const lines = markdown.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const sectionMatch = /^## (\d+)\. (.+?)\s*$/.exec(lines[i]);
    if (sectionMatch) { section = { number: Number(sectionMatch[1]), name: sectionMatch[2] }; continue; }
    const heading = /^#### (MS\.[A-Z]+\.\d+\.\d+v\d+)\s*$/.exec(lines[i]);
    if (!heading) continue;
    const id = heading[1];
    const statement = [];
    const badges = [];
    let marker = null;
    let j = i + 1;
    for (; j < lines.length && !/^#{1,4} /.test(lines[j]); j += 1) {
      const line = lines[j];
      const policy = /^<!--Policy: (\S+); Criticality: (SHALL|SHOULD) -->/.exec(line);
      if (policy) { marker = policy; break; }
      const badge = [...line.matchAll(/\[!\[([^\]]+)\]/g)].map((m) => m[1]);
      if (badge.length) badges.push(...badge);
      else if (line.trim()) statement.push(line.trim());
    }
    if (!marker || marker[1] !== id) throw new Error(`${product}: ${id} has no matching Policy/Criticality marker`);
    let nist = [];
    for (let k = j + 1; k < lines.length && !/^#{1,4} /.test(lines[k]); k += 1) {
      const mapping = /^- _NIST SP 800-53 Rev\. 5 FedRAMP High Baseline Mapping:_\s*(.*)$/.exec(lines[k]);
      if (mapping) nist = mapping[1].split(',').map((value) => value.trim()).filter(Boolean);
    }
    if (!section) throw new Error(`${product}: ${id} is outside a numbered section`);
    rules.push({
      id, product, section: section.number, sectionName: section.name,
      statement: statement.join(' '),
      criticality: marker[2],
      manual: badges.includes('Manual'),
      nistControlIds: nist,
    });
    i = j;
  }
  return rules;
}

function parseNistCsv(text) {
  const map = new Map();
  const [, ...rows] = text.split(/\r?\n/).filter(Boolean);
  for (const row of rows) {
    const match = /^([^,]+),"?(.*?)"?$/.exec(row);
    if (match) map.set(match[1].trim(), match[2].split(',').map((value) => value.trim()).filter(Boolean));
  }
  return map;
}

const byRuleId = (left, right) => left.localeCompare(right, 'en', { numeric: true });

/**
 * Every rule of the pinned release, grouped and counted per product. Throws if the
 * baseline Markdown, CISA's asset package and the Rego rules disagree on which rules
 * exist (beyond `regoOnly`, rule ids the Rego still reports that no baseline lists).
 */
export function importScubaGearRules({ pinPath = DEFAULT_PIN_PATH } = {}) {
  const source = openPinnedScubaGear({ pinPath });
  const { pin } = source;
  source.verifyAll();
  const nist = parseNistCsv(source.read(pin.nistMapping));
  const assetPackage = JSON.parse(source.read(pin.assetPackage));

  const products = Object.keys(pin.products);
  const unknown = products.filter((product) => !PRODUCT_ORDER.includes(product));
  if (unknown.length || products.length !== PRODUCT_ORDER.length) throw new Error(`unexpected ScubaGear products: ${products.join(', ')}`);

  const regoFiles = [...products.map((product) => pin.products[product].rego), ...pin.regoUtils]
    .map((file) => ({ file, source: source.read(file) }));
  const rego = regoRuleInputs(regoFiles);

  const rules = [];
  const nistNotInCsv = [];
  const nistDiffers = [];
  for (const product of PRODUCT_ORDER) {
    const parsed = parseBaseline(source.read(pin.products[product].baseline), product);
    const packaged = assetPackage.baselines?.[product] ?? [];
    const packagedIds = packaged.map((rule) => rule.id).sort(byRuleId);
    const parsedIds = parsed.map((rule) => rule.id).sort(byRuleId);
    if (JSON.stringify(packagedIds) !== JSON.stringify(parsedIds)) {
      throw new Error(`${product}: ScubaBaselines.json and the baseline Markdown list different rules`);
    }
    for (const rule of parsed) {
      const packagedRule = packaged.find((candidate) => candidate.id === rule.id);
      if (packagedRule.criticality !== rule.criticality) throw new Error(`${rule.id}: criticality differs between Markdown and ScubaBaselines.json`);
      // The Markdown is authoritative. CISA's CSV lags it (some newer rules have no row, a
      // few rows differ), so differences are listed, not fatal; a test pins the list.
      const csv = nist.get(rule.id);
      if (!csv) nistNotInCsv.push(rule.id);
      else if (JSON.stringify(csv) !== JSON.stringify(rule.nistControlIds)) nistDiffers.push({ id: rule.id, markdown: rule.nistControlIds, csv });
      const regoRule = rego.get(rule.id);
      if (!regoRule) throw new Error(`${rule.id}: no Rego rule reports it`);
      if (regoRule.file !== pin.products[product].rego) throw new Error(`${rule.id}: reported from ${regoRule.file}`);
      const regoManual = [...regoRule.criticalities].every((value) => /Not-Implemented/.test(value));
      if (regoManual !== rule.manual) throw new Error(`${rule.id}: the baseline and the Rego disagree on whether it is a manual check`);
      rules.push(Object.freeze({
        ...rule,
        title: packagedRule.name,
        regoFile: regoRule.file,
        inputs: Object.freeze([...regoRule.inputs].sort()),
        nistControlIds: Object.freeze(rule.nistControlIds),
      }));
    }
  }
  const listed = new Set(rules.map((rule) => rule.id));
  const regoOnly = [...rego.keys()].filter((id) => !listed.has(id)).sort(byRuleId);

  const counts = Object.fromEntries(PRODUCT_ORDER.map((product) => {
    const own = rules.filter((rule) => rule.product === product);
    return [product, Object.freeze({
      name: pin.products[product].name,
      rules: own.length,
      shall: own.filter((rule) => rule.criticality === 'SHALL').length,
      should: own.filter((rule) => rule.criticality === 'SHOULD').length,
      manual: own.filter((rule) => rule.manual).length,
    })];
  }));
  return Object.freeze({
    version: pin.version,
    commitSha: pin.commitSha,
    total: rules.length,
    counts: Object.freeze(counts),
    rules: Object.freeze(rules),
    regoOnly: Object.freeze(regoOnly),
    nistNotInCsv: Object.freeze(nistNotInCsv),
    nistDiffers: Object.freeze(nistDiffers),
  });
}

/**
 * For each rule: the input keys it reads, how Keel gets each one, and the rule's state:
 *  - manual: CISA marks it as a manual check, so it shows as "check by hand";
 *  - missing-input: it reads at least one key Keel does not collect ("could not check");
 *  - partial: every key is collected, but at least one only through another API that may
 *    lack fields (the adapter decides per field);
 *  - ready: Keel collects every key it reads.
 * Run settings and run status are supplied by Keel and never block a rule.
 */
export function scubaCoverage(imported = importScubaGearRules(), sources = SCUBA_INPUT_SOURCES) {
  const rules = imported.rules.map((rule) => {
    const inputs = rule.inputs.map((key) => {
      const source = sources[key];
      if (!source) throw new Error(`${rule.id} reads ${key}, which has no entry in SCUBA_INPUT_SOURCES`);
      return Object.freeze({ key, state: source.state, from: source.from, keel: source.keel, note: source.note });
    });
    const tenant = inputs.filter((input) => !['run-setting', 'run-status'].includes(input.state));
    let state = 'ready';
    if (rule.manual) state = 'manual';
    else if (tenant.some((input) => input.state === 'not-read')) state = 'missing-input';
    else if (tenant.some((input) => input.state === 'partial')) state = 'partial';
    return Object.freeze({ id: rule.id, product: rule.product, title: rule.title, criticality: rule.criticality, state, inputs: Object.freeze(inputs) });
  });
  const byState = (list) => Object.fromEntries(RULE_STATES.map((state) => [state, list.filter((rule) => rule.state === state).length]));
  const missing = new Map();
  for (const rule of rules) {
    for (const input of rule.inputs) {
      if (input.state !== 'not-read') continue;
      if (!missing.has(input.key)) missing.set(input.key, { key: input.key, from: input.from, note: input.note, rules: [] });
      missing.get(input.key).rules.push(rule.id);
    }
  }
  return Object.freeze({
    version: imported.version,
    commitSha: imported.commitSha,
    total: rules.length,
    summary: Object.freeze(byState(rules)),
    perProduct: Object.freeze(Object.fromEntries(PRODUCT_ORDER.map((product) => [product, byState(rules.filter((rule) => rule.product === product))]))),
    missingInputs: Object.freeze([...missing.values()].sort((a, b) => b.rules.length - a.rules.length || a.key.localeCompare(b.key))),
    rules: Object.freeze(rules),
  });
}
