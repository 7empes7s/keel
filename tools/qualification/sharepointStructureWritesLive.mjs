#!/usr/bin/env node
/**
 * SharePoint structure restore: capture the live proof its seven writes need before they
 * may run. The operator runs this against the test tenant; builders and CI never point
 * it at a tenant.
 *
 *   node tools/qualification/sharepointStructureWritesLive.mjs plan --site https://<host>/sites/KEEL-RT-... [--hub-site <url>]
 *     Offline (the default). Prints what a capture would send. No network.
 *
 *   [KEEL_QUALIFICATION_HMAC_KEY=...] node tools/qualification/sharepointStructureWritesLive.mjs capture --confirm-live-tenant-write \
 *        --tenant-ref sha256:... --site https://<host>/sites/KEEL-RT-... [--hub-site https://<host>/sites/KEEL-RT-...] \
 *        --collector-ref app:<collector app id> --restorer-ref app:<restorer app id> \
 *        --collector-config /etc/keel/<sharepoint collector>.json --restorer-config /etc/keel/<sharepoint restorer>.json \
 *        --grants grants.json --out docs/release/qualifications/sharepoint-structure-writes-live-acceptance.json [--build <sha>] [--powershell-image <tag>]
 *
 * What a capture does, in order (and nothing else):
 *  0. offline: asks the write transport for Remove-PnPSiteScript and for an undeclared
 *     parameter; both must be refused before anything is sent;
 *  1. collector: reads hub sites, designs, scripts and the --site template;
 *  2. restorer: Add-PnPSiteScript KEEL-RT-capture-<random> (no actions), read back;
 *     Set-PnPSiteScript on it (its description), read back;
 *  3. restorer: Add-PnPSiteDesign KEEL-RT-capture-<random> using that script, not
 *     default, read back; Set-PnPSiteDesign on it (its description), read back;
 *  4. on the first hub whose site is a /sites/KEEL-RT-* site: Set-PnPHubSite description
 *     to a marker, read back, put back, read back. No such hub: skipped;
 *  5. with --hub-site (a KEEL-RT- site that is not a hub): Register-PnPHubSite, read back;
 *  6. on --site, through the restore's own template builder: Invoke-PnPSiteTemplate adding
 *     a KEEL-RT-capture- list, site column and content type and one KEEL-RT-capture-
 *     navigation link, read back; then the navigation as it was, read back.
 * KEEL never deletes, so the script, design, list, column, content type and hub stay;
 * they are all KEEL-RT- fixtures. Tenant ids are pseudonymized. With
 * KEEL_QUALIFICATION_HMAC_KEY set the record is signed as `keel-release-runner`.
 *
 * ledgerEvidenceFromStructureWritesAcceptance() is the import seam: a record that passes
 * `verify --require-live` becomes one live write capture per proven write.
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

import { readSharePointStructure } from '../../engine/collect/workloads/sharepointStructure.mjs';
import { readConfigFile } from '../../engine/config/configFile.mjs';
import { CmdletError } from '../../engine/powershell/jobQueue.mjs';
import {
  backedUpTemplate, buildRestoreTemplate, readsBackAs, structureWriteCmdlet, unsupportedElements,
} from '../../engine/restore/workloads/sharepointStructure.mjs';
import {
  HUB_SITE_ADD, HUB_SITE_UPDATE, SITE_DESIGN_ADD, SITE_DESIGN_UPDATE, SITE_SCRIPT_ADD, SITE_SCRIPT_UPDATE, STRUCTURE_TEMPLATE_UPDATE,
} from '../../engine/restore/workloads/sharepointStructureWrites.mjs';
import { tenantRefFor } from '../../engine/store/tenantRef.mjs';
import { QUALIFICATION_CONTRACT_VERSION, verifyEvidence } from '../release/qualification.mjs';
import { pseudonymizeCapture } from './pseudonymize.mjs';
import { writeAcceptanceFiles } from './sharepointLive.mjs';
import {
  STRUCTURE_CAPTURE_PREFIX, STRUCTURE_MODULE, STRUCTURE_WRITES_CREDENTIAL_MODE, STRUCTURE_WRITES_LIVE_GATE, STRUCTURE_WRITES_LIVE_OPERATION,
  STRUCTURE_WRITES_RECORD_FILE, STRUCTURE_WRITES_TRANSPORT, isFixtureSite, provenStructureWrites,
} from './sharepointStructureWritesAcceptance.mjs';
import { pinnedModuleVersions } from './workloadWritesLive.mjs';

const sha256Hex = (text) => createHash('sha256').update(text).digest('hex');
const lc = (value) => String(value ?? '').toLowerCase();
const EMPTY_SCRIPT = '{"$schema":"https://developer.microsoft.com/json-schemas/sp/site-design-script-actions.schema.json","actions":[],"bindata":{},"version":1}';
const ZERO_GUID = '00000000-0000-0000-0000-000000000000';

function siteProblems({ site, hubSite }) {
  const problems = [];
  if (!isFixtureSite(site)) problems.push('--site must be a https://<host>/sites/KEEL-RT-* site collection');
  if (hubSite !== undefined && hubSite !== null && !isFixtureSite(hubSite)) problems.push('--hub-site must be a https://<host>/sites/KEEL-RT-* site collection');
  try {
    if (hubSite && new URL(hubSite).hostname !== new URL(site).hostname) problems.push('--hub-site must be on the same host as --site');
  } catch { /* reported above */ }
  return problems;
}

/** Offline: what a capture would send, in order. */
export function structureWritesCapturePlan({ site, hubSite = null }) {
  const problems = siteProblems({ site, hubSite });
  if (problems.length) throw new Error(problems.join('; '));
  return [
    { step: 0, credential: 'none', refused: 'Remove-PnPSiteScript (KEEL never deletes; refused before sending)' },
    { step: 0, credential: 'none', refused: 'Set-PnPSiteScript -Version (an undeclared parameter; refused before sending)' },
    { step: 1, credential: 'collector', read: `hub sites, site designs, site scripts and the template of ${site}` },
    { step: 2, credential: 'restorer', cmdlet: 'Add-PnPSiteScript', parameters: { Title: `${STRUCTURE_CAPTURE_PREFIX}<random>`, Description: '<marker>', Content: '<no actions>' }, operationId: SITE_SCRIPT_ADD },
    { step: 2, credential: 'restorer', cmdlet: 'Set-PnPSiteScript', parameters: { Identity: '<that script>', Description: '<marker 2>' }, operationId: SITE_SCRIPT_UPDATE },
    { step: 3, credential: 'restorer', cmdlet: 'Add-PnPSiteDesign', parameters: { Title: `${STRUCTURE_CAPTURE_PREFIX}<random>`, WebTemplate: 'TeamSite', SiteScriptIds: ['<that script>'], IsDefault: false }, operationId: SITE_DESIGN_ADD },
    { step: 3, credential: 'restorer', cmdlet: 'Set-PnPSiteDesign', parameters: { Identity: '<that design>', Description: '<marker 2>' }, operationId: SITE_DESIGN_UPDATE },
    { step: 4, credential: 'restorer', cmdlet: 'Set-PnPHubSite', parameters: { Identity: '<the first KEEL-RT- hub>', Description: '<marker>, then the original' }, operationId: HUB_SITE_UPDATE, note: 'skipped when no hub is a KEEL-RT- site' },
    ...(hubSite ? [{ step: 5, credential: 'restorer', cmdlet: 'Register-PnPHubSite', parameters: { Site: hubSite }, operationId: HUB_SITE_ADD, note: 'it stays a hub' }] : []),
    { step: 6, credential: 'restorer', cmdlet: 'Invoke-PnPSiteTemplate', parameters: { Url: site, TemplateGzip: `<a ${STRUCTURE_CAPTURE_PREFIX} list, site column, content type and navigation link>` }, operationId: STRUCTURE_TEMPLATE_UPDATE },
    { step: 6, credential: 'restorer', cmdlet: 'Invoke-PnPSiteTemplate', parameters: { Url: site, TemplateGzip: '<the navigation as it was>' }, operationId: STRUCTURE_TEMPLATE_UPDATE, note: 'put back' },
  ];
}

/** Reads until `matches`; a read that fails counts as no match and is retried. */
async function readUntil(readOnce, matches, { sleep, attempts, delayMs }) {
  let found = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt) await sleep(delayMs);
    try { found = await readOnce(); } catch { found = null; continue; }
    if (matches(found)) return { found, matched: true };
  }
  return { found, matched: false };
}

/**
 * The backed-up template with one KEEL-RT-capture- list, site column, content type and
 * navigation link added, so the restore's builder has something missing to send.
 */
export function captureSource(xml, { suffix, site }) {
  const columnId = `${randomGuid()}`;
  const typeId = `0x0100${randomBytes(16).toString('hex').toUpperCase()}`;
  const name = `${STRUCTURE_CAPTURE_PREFIX}${suffix}`;
  const column = `<Field ID="{${columnId}}" Name="KeelRtCapture${suffix}" StaticName="KeelRtCapture${suffix}" DisplayName="${name}" Type="Text" Group="KEEL-RT capture" />`;
  const type = `<pnp:ContentType ID="${typeId}" Name="${name}" Group="KEEL-RT capture" Description="KEEL live proof fixture; safe to delete" />`;
  const list = `<pnp:ListInstance Title="${name}" Description="KEEL live proof fixture; safe to delete" TemplateType="100" Url="Lists/${name}" OnQuickLaunch="false" EnableVersioning="false" />`;
  const node = `<pnp:NavigationNode Title="${name}" Url="${new URL(site).pathname}" IsExternal="false" />`;
  const insert = (text, close, open, body) => (text.includes(close) ? text.replace(close, `${body}${close}`) : text.replace('</pnp:ProvisioningTemplate>', `${open}${body}${close}</pnp:ProvisioningTemplate>`));
  let out = insert(xml, '</pnp:SiteFields>', '<pnp:SiteFields>', column);
  out = insert(out, '</pnp:ContentTypes>', '<pnp:ContentTypes>', type);
  out = insert(out, '</pnp:Lists>', '<pnp:Lists>', list);
  const navigation = /<\/pnp:StructuralNavigation>/.test(out);
  if (navigation) out = out.replace('</pnp:StructuralNavigation>', `${node}</pnp:StructuralNavigation>`);
  return { xml: out, keys: { siteColumns: [columnId], contentTypes: [lc(typeId)], lists: [lc(`Lists/${name}`)] }, names: { list: `Lists/${name}`, column: `KeelRtCapture${suffix}`, type: name, node: name }, navigation };
}

function randomGuid() {
  const hex = randomBytes(16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Runs a capture. `collector` and `restorer` are the runCmdlet options for each
 * identity's PnP config. Returns the unsigned record and the capture log, pseudonymized;
 * it never signs and never writes files.
 */
export async function captureStructureWrites({
  collector, restorer, site, hubSite = null, tenantRef, build, credentials, grants, moduleVersion, read = readSharePointStructure,
  now = () => new Date(), sleep = (ms) => new Promise((done) => setTimeout(done, ms)), readBackAttempts = 6, readBackDelayMs = 5000,
  suffix = () => randomBytes(4).toString('hex'),
}) {
  const problems = siteProblems({ site, hubSite });
  if (!tenantRef || !build) problems.push('a capture needs --tenant-ref and a build');
  if (!credentials?.collector || !credentials?.restorer || credentials.collector === credentials.restorer) problems.push('a capture needs two separate credential references (collector, restorer)');
  if (!grants?.restorer || !Array.isArray(grants.restorer.permissions)) problems.push('--grants must name the restorer\'s permissions');
  if (problems.length) throw new Error(problems.join('; '));
  const tenantHost = new URL(site).hostname.toLowerCase();
  const siteUrl = `https://${tenantHost}${new URL(site).pathname.replace(/\/+$/, '')}`;
  const requests = [];
  const log = { requests, values: {} };
  const timing = { sleep, attempts: readBackAttempts, delayMs: readBackDelayMs };

  const readFamilies = async (families, sites = []) => {
    const entry = { credential: 'collector', read: 'sharepoint-structure', families, outcome: 'ok', at: now().toISOString() };
    try {
      const result = await read({ powershell: collector, families, sites, tenantHost });
      requests.push(entry);
      const gap = [...(result.failures ?? []), ...(result.unavailable ?? [])][0];
      if (gap) throw new Error(`the ${gap.family} read was ${gap.status}`);
      return result.resources;
    } catch (error) {
      if (!requests.includes(entry)) requests.push({ ...entry, outcome: 'failed', error: error.message });
      throw error;
    }
  };
  const writeCmdlet = async (cmdlet, parameters) => {
    const logged = cmdlet === 'Invoke-PnPSiteTemplate'
      ? { Url: parameters.Url, TemplateGzipSha256: sha256Hex(parameters.TemplateGzip ?? '') }
      : { ...parameters };
    const entry = { credential: 'restorer', cmdlet, parameters: logged, outcome: 'ok', at: now().toISOString() };
    try {
      const result = await structureWriteCmdlet({ cmdlet, parameters }, restorer);
      requests.push(entry);
      return result;
    } catch (error) {
      if (error instanceof CmdletError) requests.push({ ...entry, outcome: 'failed', error: { code: error.detail.code, errorId: error.detail.errorId ?? null } });
      throw error;
    }
  };
  const sent = async (capture, cmdlet, parameters) => {
    try {
      await writeCmdlet(cmdlet, parameters);
      return true;
    } catch (error) {
      if (error instanceof CmdletError && error.detail.code === 'CMDLET_ERROR') { capture.error = `${cmdlet} failed: ${error.message}`; return false; }
      if (!(error instanceof CmdletError)) { capture.error = error.message; return false; }
      capture.error = `${cmdlet} had no answer (${error.message}); it may have applied`;
      return true;
    }
  };

  // 0. Offline refusals: a delete and an undeclared parameter never leave this process.
  const sentBefore = requests.length;
  const refusals = {
    remove: { cmdlet: 'Remove-PnPSiteScript', refused: false, sent: false },
    undeclaredParameter: { cmdlet: 'Set-PnPSiteScript', parameter: 'Version', refused: false, sent: false },
  };
  for (const [key, parameters] of [['remove', { Identity: ZERO_GUID }], ['undeclaredParameter', { Identity: ZERO_GUID, Version: 2 }]]) {
    try { await writeCmdlet(refusals[key].cmdlet, parameters); } catch (error) {
      refusals[key].refused = !(error instanceof CmdletError);
      refusals[key].reason = error.message;
    }
    refusals[key].sent = requests.length !== sentBefore;
  }

  const stamp = now().toISOString();
  const marker = `KEEL capture ${stamp}`;
  const writes = [];
  const skipped = [];
  const created = [];
  const base = (operationId, fixture) => ({
    operationId, version: moduleVersion, synthetic: false, fixture, ok: false, readBackVerified: false, capturedAt: null, error: null,
  });
  const finish = (capture) => { capture.capturedAt = now().toISOString(); writes.push(capture); return capture; };
  let refusal = Object.values(refusals).every((item) => item.refused && !item.sent) ? null : 'the write transport did not refuse a delete or an undeclared parameter; nothing was written';
  let first = null;
  if (!refusal) {
    try { first = await readFamilies(['hubSite', 'siteDesign', 'siteScript', 'siteTemplate'], [siteUrl]); } catch (error) { refusal = `the first read failed (${error.message}); nothing was written`; }
  }
  const byTitle = (family, title) => async () => (await readFamilies([family])).find((item) => item.kind === family && lc(item.fields?.Title) === lc(title)) ?? null;

  if (!refusal) {
    // 2. A site script, added and changed.
    const scriptTitle = `${STRUCTURE_CAPTURE_PREFIX}${suffix()}`;
    const scriptAdd = base(SITE_SCRIPT_ADD, scriptTitle);
    const scriptFields = { Title: scriptTitle, Description: marker, Content: EMPTY_SCRIPT };
    let script = null;
    if (await sent(scriptAdd, 'Add-PnPSiteScript', scriptFields)) {
      created.push({ kind: 'siteScript', name: scriptTitle });
      const seen = await readUntil(byTitle('siteScript', scriptTitle), (entry) => entry && Object.entries(scriptFields).every(([field, value]) => readsBackAs(field, entry.fields?.[field], value)), timing);
      scriptAdd.readBackVerified = seen.matched;
      scriptAdd.ok = seen.matched && scriptAdd.error === null;
      script = seen.found;
    }
    finish(scriptAdd);
    const scriptUpdate = base(SITE_SCRIPT_UPDATE, scriptTitle);
    if (script) {
      if (await sent(scriptUpdate, 'Set-PnPSiteScript', { Identity: script.identity, Description: `${marker} updated` })) {
        const seen = await readUntil(byTitle('siteScript', scriptTitle), (entry) => entry?.fields?.Description === `${marker} updated`, timing);
        scriptUpdate.readBackVerified = seen.matched;
        scriptUpdate.ok = seen.matched && scriptUpdate.error === null;
      }
      finish(scriptUpdate);
    } else skipped.push({ operationId: SITE_SCRIPT_UPDATE, reason: 'the capture script was not added' });

    // 3. A site design using it, added and changed.
    const designTitle = `${STRUCTURE_CAPTURE_PREFIX}${suffix()}`;
    if (script) {
      const designAdd = base(SITE_DESIGN_ADD, designTitle);
      const designFields = { Title: designTitle, Description: marker, WebTemplate: 'TeamSite', SiteScriptIds: [script.identity], IsDefault: false };
      let design = null;
      if (await sent(designAdd, 'Add-PnPSiteDesign', designFields)) {
        created.push({ kind: 'siteDesign', name: designTitle });
        const seen = await readUntil(byTitle('siteDesign', designTitle), (entry) => entry && ['Title', 'Description', 'WebTemplate', 'SiteScriptIds', 'IsDefault'].every((field) => readsBackAs(field, entry.fields?.[field], designFields[field])), timing);
        designAdd.readBackVerified = seen.matched;
        designAdd.ok = seen.matched && designAdd.error === null;
        design = seen.found;
      }
      finish(designAdd);
      const designUpdate = base(SITE_DESIGN_UPDATE, designTitle);
      if (design) {
        if (await sent(designUpdate, 'Set-PnPSiteDesign', { Identity: design.identity, Description: `${marker} updated` })) {
          const seen = await readUntil(byTitle('siteDesign', designTitle), (entry) => entry?.fields?.Description === `${marker} updated`, timing);
          designUpdate.readBackVerified = seen.matched;
          designUpdate.ok = seen.matched && designUpdate.error === null;
        }
        finish(designUpdate);
      } else skipped.push({ operationId: SITE_DESIGN_UPDATE, reason: 'the capture design was not added' });
    } else skipped.push({ operationId: SITE_DESIGN_ADD, reason: 'the capture script was not added' }, { operationId: SITE_DESIGN_UPDATE, reason: 'the capture script was not added' });

    // 4. A KEEL-RT- hub's description, changed and put back.
    const hub = first.filter((item) => item.kind === 'hubSite' && isFixtureSite(item.fields?.SiteUrl)).sort((a, b) => lc(a.fields.SiteUrl).localeCompare(lc(b.fields.SiteUrl)))[0];
    if (!hub) skipped.push({ operationId: HUB_SITE_UPDATE, reason: 'no hub is a /sites/KEEL-RT-* site' });
    else {
      const capture = base(HUB_SITE_UPDATE, decodeURIComponent(new URL(hub.fields.SiteUrl).pathname.split('/').filter(Boolean)[1]));
      capture.putBack = true;
      const original = hub.fields.Description ?? '';
      const readHub = async () => (await readFamilies(['hubSite'])).find((item) => item.kind === 'hubSite' && lc(item.fields?.SiteUrl) === lc(hub.fields.SiteUrl)) ?? null;
      if (await sent(capture, 'Set-PnPHubSite', { Identity: hub.fields.SiteUrl, Description: marker })) {
        capture.readBackVerified = (await readUntil(readHub, (entry) => entry?.fields?.Description === marker, timing)).matched;
        let putBackError = null;
        try { await writeCmdlet('Set-PnPHubSite', { Identity: hub.fields.SiteUrl, Description: original }); } catch (error) { putBackError = error.message; }
        capture.restoredToOriginal = (await readUntil(readHub, (entry) => (entry?.fields?.Description ?? '') === original, timing)).matched;
        if (!capture.restoredToOriginal) capture.error = `PUTTING THE HUB DESCRIPTION BACK FAILED${putBackError ? ` (${putBackError})` : ''}: set it to ${JSON.stringify(original)} by hand`;
        capture.ok = capture.error === null && capture.readBackVerified;
      }
      finish(capture);
    }

    // 5. A KEEL-RT- site registered as a hub (it stays one).
    if (!hubSite) skipped.push({ operationId: HUB_SITE_ADD, reason: 'no --hub-site was named' });
    else if (first.some((item) => item.kind === 'hubSite' && lc(item.fields?.SiteUrl).replace(/\/+$/, '') === lc(hubSite).replace(/\/+$/, ''))) {
      skipped.push({ operationId: HUB_SITE_ADD, reason: '--hub-site is already a hub' });
    } else {
      const capture = base(HUB_SITE_ADD, decodeURIComponent(new URL(hubSite).pathname.split('/').filter(Boolean)[1]));
      const target = `https://${tenantHost}${new URL(hubSite).pathname.replace(/\/+$/, '')}`;
      if (await sent(capture, 'Register-PnPHubSite', { Site: target })) {
        created.push({ kind: 'hubSite', name: capture.fixture });
        const readHub = async () => (await readFamilies(['hubSite'])).find((item) => item.kind === 'hubSite' && lc(item.fields?.SiteUrl).replace(/\/+$/, '') === lc(target)) ?? null;
        capture.readBackVerified = (await readUntil(readHub, Boolean, timing)).matched;
        capture.ok = capture.readBackVerified && capture.error === null;
      }
      finish(capture);
    }

    // 6. The site: a capture list, column, content type and link added, then the navigation put back.
    const template = first.find((item) => item.kind === 'siteTemplate');
    const capture = base(STRUCTURE_TEMPLATE_UPDATE, siteUrl);
    capture.putBack = true;
    let source = null;
    try { source = backedUpTemplate(template?.fields); } catch (error) { capture.error = `the site template could not be read: ${error.message}`; }
    const readSite = async () => (await readFamilies(['siteTemplate'], [siteUrl])).find((item) => item.kind === 'siteTemplate') ?? null;
    if (source) {
      const extended = captureSource(source, { suffix: suffix(), site: siteUrl });
      if (!extended.navigation) capture.error = 'the site has no structural navigation to put back; nothing was written';
      else {
        const built = buildRestoreTemplate(extended.xml, { ...extended.keys, navigation: true });
        capture.elements = [...new Set([...built.xml.matchAll(/<pnp:([A-Za-z]+)/g)].map((match) => match[1]))].sort();
        capture.added = { lists: built.included.lists, siteColumns: built.included.siteColumns, contentTypes: built.included.contentTypes };
        const originalNavigation = template.fields.navigation ?? [];
        const wantedNavigation = [...originalNavigation];
        if (unsupportedElements(built.xml).length || built.skipped.length || !built.included.navigation) capture.error = `the capture template could not be built: ${JSON.stringify(built.skipped)}`;
        else if (await sent(capture, 'Invoke-PnPSiteTemplate', { Url: siteUrl, TemplateGzip: gzipSync(Buffer.from(built.xml, 'utf8')).toString('base64') })) {
          created.push({ kind: 'siteTemplate', name: extended.names.list }, { kind: 'siteColumn', name: extended.names.column }, { kind: 'contentType', name: extended.names.type });
          const has = (entry) => entry
            && entry.fields.lists?.some((item) => lc(item.Url) === lc(extended.names.list))
            && entry.fields.siteColumns?.some((item) => lc(item.Name) === lc(extended.names.column))
            && entry.fields.contentTypes?.some((item) => lc(item.Name) === lc(extended.names.type))
            && entry.fields.navigation?.some((item) => item.Title === extended.names.node);
          const seen = await readUntil(readSite, has, timing);
          capture.readBackVerified = seen.matched;
          capture.navigation = true;
          // Put the navigation back as it was: the original template's navigation, alone.
          const back = buildRestoreTemplate(source, { navigation: true });
          let putBackError = null;
          try { await writeCmdlet('Invoke-PnPSiteTemplate', { Url: siteUrl, TemplateGzip: gzipSync(Buffer.from(back.xml, 'utf8')).toString('base64') }); } catch (error) { putBackError = error.message; }
          const restored = await readUntil(readSite, (entry) => JSON.stringify(entry?.fields?.navigation ?? []) === JSON.stringify(wantedNavigation), timing);
          capture.restoredToOriginal = restored.matched;
          if (!restored.matched) capture.error = `PUTTING THE NAVIGATION BACK FAILED${putBackError ? ` (${putBackError})` : ''}: remove the ${extended.names.node} link from ${siteUrl} by hand`;
          capture.ok = capture.error === null && capture.readBackVerified;
        }
      }
    }
    finish(capture);
  }
  if (refusal) skipped.push({ operationId: null, reason: refusal });

  const captureLog = `${JSON.stringify(log, null, 2)}\n`;
  const record = {
    contractVersion: QUALIFICATION_CONTRACT_VERSION,
    gate: STRUCTURE_WRITES_LIVE_GATE,
    tenantRef,
    build,
    operation: STRUCTURE_WRITES_LIVE_OPERATION,
    credentialMode: STRUCTURE_WRITES_CREDENTIAL_MODE,
    observedAt: now().toISOString(),
    evidenceLevel: 'live-qualified',
    synthetic: false,
    subject: {
      site: siteUrl,
      execution: { transport: STRUCTURE_WRITES_TRANSPORT, module: STRUCTURE_MODULE, moduleVersion },
      credentials: { collector: credentials.collector, restorer: credentials.restorer },
      grants,
      refusals,
      writes,
      skipped,
      created,
      requests: requests.map(({ at, ...request }) => request),
      captureLogSha256: sha256Hex(captureLog),
    },
  };
  const needsManualRevert = writes.filter((capture) => capture.putBack === true && capture.readBackVerified && capture.restoredToOriginal !== true);
  return { ...pseudonymizeCapture({ record, log }), needsManualRevert };
}

/**
 * The import seam: a record that passes the gate with --require-live becomes one live
 * write capture per proven write, the restorer's grants and the PnP version the
 * captures are bound to. Anything else yields none.
 */
export function ledgerEvidenceFromStructureWritesAcceptance(evidence, options = {}) {
  const result = verifyEvidence(evidence, { ...options, gate: STRUCTURE_WRITES_LIVE_GATE, requireLive: true });
  if (!result.ok) return { ok: false, failures: result.failures, reads: [], writes: [], grants: null, restorerGrants: null, runtime: null };
  const { subject, tenantRef } = evidence;
  const proofRef = `${STRUCTURE_WRITES_LIVE_GATE}@${subject.captureLogSha256}`;
  return {
    ok: true,
    failures: [],
    reads: [],
    writes: provenStructureWrites(subject).map((item) => ({
      operationId: item.operationId, kind: 'live-write-capture', synthetic: false, tenantRef, capturedAt: item.capturedAt,
      version: item.version, ok: true, readBackVerified: true, proofRef,
    })),
    grants: null,
    restorerGrants: { permissions: [...subject.grants.restorer.permissions], roles: [...(subject.grants.restorer.roles ?? [])] },
    runtime: { modules: { [STRUCTURE_MODULE]: subject.execution.moduleVersion } },
  };
}

function parseArgs(argv) {
  const [command = 'plan', ...rest] = argv;
  const options = { command, confirm: false };
  const names = {
    '--tenant-ref': 'tenantRef', '--site': 'site', '--hub-site': 'hubSite', '--collector-ref': 'collectorRef', '--restorer-ref': 'restorerRef',
    '--collector-config': 'collectorConfig', '--restorer-config': 'restorerConfig', '--grants': 'grants', '--out': 'out', '--build': 'build', '--powershell-image': 'image',
  };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === '--confirm-live-tenant-write') options.confirm = true;
    else if (names[arg]) options[names[arg]] = rest[++index];
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

const POWERSHELL_DOCKERFILE = new URL('../../ops/powershell/Dockerfile', import.meta.url);

export async function main(argv = process.argv.slice(2), {
  out = console.log, env = process.env, readFile = (path) => readFileSync(path, 'utf8'), capture = captureStructureWrites,
  pins = () => pinnedModuleVersions(readFileSync(POWERSHELL_DOCKERFILE, 'utf8')),
} = {}) {
  const options = parseArgs(argv);
  if (options.command === 'plan') {
    out(JSON.stringify(structureWritesCapturePlan(options), null, 2));
    return 0;
  }
  if (options.command !== 'capture') throw new Error('usage: sharepointStructureWritesLive.mjs plan|capture --site <url> ...');
  if (!options.confirm) {
    out(JSON.stringify(structureWritesCapturePlan(options), null, 2));
    out('refused: a capture adds KEEL-RT- fixtures in the tenant and puts each change back; rerun with --confirm-live-tenant-write');
    return 2;
  }
  for (const [flag, key] of [['--tenant-ref', 'tenantRef'], ['--site', 'site'], ['--collector-ref', 'collectorRef'], ['--restorer-ref', 'restorerRef'],
    ['--collector-config', 'collectorConfig'], ['--restorer-config', 'restorerConfig'], ['--grants', 'grants'], ['--out', 'out']]) {
    if (!options[key]) throw new Error(`capture needs ${flag}`);
  }
  if (options.collectorConfig === options.restorerConfig) throw new Error('the collector and restorer must use separate config files');
  if (basename(options.out) !== STRUCTURE_WRITES_RECORD_FILE) throw new Error(`--out must be named ${STRUCTURE_WRITES_RECORD_FILE}, where the import looks for it`);
  const build = options.build ?? env.KEEL_QUALIFICATION_BUILD;
  if (!build) throw new Error('capture needs --build (or KEEL_QUALIFICATION_BUILD): the build this capture qualifies');
  const collectorConfig = readConfigFile(options.collectorConfig, { readFile, what: 'SharePoint collector settings' });
  const restorerConfig = readConfigFile(options.restorerConfig, { readFile, what: 'SharePoint restorer settings' });
  if (typeof collectorConfig.tenantId !== 'string' || options.tenantRef !== tenantRefFor(collectorConfig.tenantId)) throw new Error('--tenant-ref is not the tenant the collector config names; nothing was sent');
  if (restorerConfig.tenantId !== collectorConfig.tenantId) throw new Error('the restorer config names another tenant; nothing was sent');
  if (restorerConfig.clientId && restorerConfig.clientId === collectorConfig.clientId) throw new Error('the restorer config is the collector app; nothing was sent');
  const moduleVersion = pins()[STRUCTURE_MODULE];
  if (!moduleVersion) throw new Error(`ops/powershell/Dockerfile pins no ${STRUCTURE_MODULE} version; nothing was sent`);
  const powershell = (tenantConfigPath) => ({ tenantConfigPath, ...(options.image ? { image: options.image } : {}) });
  const outPath = resolve(options.out);
  const { record, captureLog, needsManualRevert } = await capture({
    collector: powershell(options.collectorConfig), restorer: powershell(options.restorerConfig), site: options.site, hubSite: options.hubSite ?? null,
    tenantRef: options.tenantRef, build, moduleVersion, credentials: { collector: options.collectorRef, restorer: options.restorerRef },
    grants: JSON.parse(readFile(options.grants)),
  });
  const { evidence, logPath } = writeAcceptanceFiles({ record, captureLog, outPath, hmacKey: env.KEEL_QUALIFICATION_HMAC_KEY ?? null });
  const result = verifyEvidence(evidence, { gate: STRUCTURE_WRITES_LIVE_GATE, tenantRef: options.tenantRef, build, requireLive: true, evidenceDir: dirname(outPath) });
  const proven = provenStructureWrites(evidence.subject).map((item) => item.operationId);
  out(JSON.stringify({
    evidence: outPath, captureLog: logPath, proven, skipped: evidence.subject.skipped, created: evidence.subject.created,
    notProven: evidence.subject.writes.filter((item) => !proven.includes(item.operationId)).map(({ operationId, error }) => ({ operationId, error })),
    needsManualRevert: needsManualRevert.map(({ operationId, fixture, error }) => ({ operationId, fixture, error })),
    verify: result,
  }, null, 2));
  if (needsManualRevert.length) return 3;
  return result.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then((code) => { process.exitCode = code; }, (error) => { console.error(error.message); process.exitCode = 2; });
}

