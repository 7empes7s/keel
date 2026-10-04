/**
 * Release qualification ledger (roadmap task-112).
 *
 * Joins two kinds of result and keeps them apart:
 *
 * - fixture results: the six journeys of tools/release/journeys.mjs, run against
 *   local fakes and an isolated database. They prove code behavior only;
 * - live acceptance: the externally captured records in
 *   docs/release/qualifications/, each verified with `--require-live` semantics
 *   through verifyEvidence. A record is live-qualified only when it verifies.
 *
 * Readiness is 'ready' only when every fixture journey passed, every live gate
 * verified (or is an accepted gap by operator decision) and no objective is left open. Any unknown (missing record, pending
 * placeholder, unverifiable without key/tenant/build) makes it 'pending'. Any
 * failed gate or journey makes it 'blocked'. The ledger still reports every
 * other result in full, so one failed gate never hides independent work.
 *
 * Nothing here captures, signs or upgrades evidence.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { verifyEvidence } from './qualification.mjs';

export const LEDGER_CONTRACT_VERSION = 1;
const QUALIFICATIONS_DIR = new URL('../../docs/release/qualifications/', import.meta.url).pathname;

/**
 * The externally qualified gates the release consumes. A gate that is not
 * live-qualified keeps readiness pending, unless an operator decision descoped
 * it: then it is reported as an accepted gap (never as qualified) and does not
 * hold readiness. A descoped gate whose record fails verification still blocks.
 */
export const LIVE_ACCEPTANCE_GATES = Object.freeze([
  { task: 'task-113', gate: 'deployed-acceptance', title: 'Authenticated deployed release acceptance' },
  { task: 'task-114', gate: 'storage-live-acceptance', title: 'Independent recovery read from a local copy',
    note: 'Retention lock and immutability are reported unqualified by operator decision 2026-09-30.' },
  { task: 'task-115', gate: 'native-live-acceptance', title: 'Native recovery credential qualification' },
  { task: 'task-116', gate: 'drill-live-acceptance', title: 'Bounded same-tenant drill and KEEL recovery' },
  { task: 'task-117', gate: 'sentinel-live-acceptance', title: 'Sentinel workspace ingestion',
    note: 'Fixture-tested, live-unqualified. Deferred 2026-09-30, then descoped by operator decision 2026-10-04.',
    acceptedGap: 'descoped by operator decision 2026-10-04 12:36 UTC (D-117: no Sentinel test workspace); Sentinel export ships live-unqualified' },
  { task: 'task-118', gate: 'servicenow-live-acceptance', title: 'ServiceNow non-default workflow' },
  { task: 'task-119', gate: 'nist-benchmark-acceptance', title: 'NIST SP 800-53 benchmark pack' },
  { task: 'task-120', gate: 'sharepoint-live-acceptance', title: 'SharePoint configuration workload' },
  { task: 'task-121', gate: 'teams-live-acceptance', title: 'Teams configuration workload' },
  { task: 'task-122', gate: 'exchange-live-acceptance', title: 'Exchange configuration workload' },
  { task: 'task-123', gate: 'onedrive-purview-live-acceptance', title: 'OneDrive and Purview configuration' },
].map((entry) => Object.freeze(entry)));

const DEFINITION_GAP = 'objective definition is not in this repository (the 2026-09-15 final review lives outside git); '
  + 'it cannot be mapped to an owner, test or evidence until its text is supplied';

function undefinedObjective(id) {
  return { id, definition: null, owners: [], tests: [], evidence: [], gap: DEFINITION_GAP };
}

/**
 * D1-D10 and G1-G8. Only objectives whose meaning the repository itself records
 * are mapped; the rest are explicit qualification gaps, never guessed.
 */
export const RELEASE_OBJECTIVES = Object.freeze([
  undefinedObjective('D1'),
  undefinedObjective('D2'),
  {
    id: 'D3', definition: 'Dynamic group impact is measured on real tenant sizing (docs/roadmap/dynamic-impact.md).',
    owners: ['task-60'], tests: ['engine/roadmap/dynamic-impact.test.mjs'], evidence: [],
    gap: 'D3 stays unmeasured until a non-synthetic sizing record exists; no live sizing gate is defined',
  },
  undefinedObjective('D4'),
  undefinedObjective('D5'),
  {
    id: 'D6', definition: 'A ServiceNow workflow is proven live through the canonical KEEL decision (docs/roadmap/servicenow-live-acceptance.md).',
    owners: ['task-96', 'task-97', 'task-118'],
    tests: ['engine/roadmap/servicenow.test.mjs', 'engine/roadmap/servicenow-live-acceptance.test.mjs'],
    evidence: ['servicenow-live-acceptance'], gap: null,
  },
  undefinedObjective('D7'),
  undefinedObjective('D8'),
  undefinedObjective('D9'),
  undefinedObjective('D10'),
  ...Array.from({ length: 8 }, (_, index) => undefinedObjective(`G${index + 1}`)),
].map((entry) => Object.freeze(entry)));

/** Read the checked-in record of every live gate (null when no file exists). */
export function loadLiveRecords({ dir = QUALIFICATIONS_DIR } = {}) {
  return LIVE_ACCEPTANCE_GATES.map((spec) => {
    const path = join(dir, `${spec.gate}.json`);
    if (!existsSync(path)) return { ...spec, record: null, evidenceDir: dir };
    try {
      return { ...spec, record: JSON.parse(readFileSync(path, 'utf8')), evidenceDir: dirname(resolve(path)) };
    } catch (error) {
      return { ...spec, record: { unreadable: error.message }, evidenceDir: dir };
    }
  });
}

/**
 * One live gate's status: 'live-qualified' only when verifyEvidence passes with
 * --require-live semantics for the expected tenant and build. Otherwise
 * 'missing', 'pending' (a placeholder), 'unverified' (no key, tenant or build to
 * check it with) or 'failed' (it was checked and did not verify).
 */
export function classifyLiveRecord(spec, record, { hmacKey = null, tenantRef = null, build = null, evidenceDir = QUALIFICATIONS_DIR, now = new Date() } = {}) {
  if (!record) return { status: 'missing', failures: [`no ${spec.gate} record has been captured`] };
  if (record.unreadable) return { status: 'failed', failures: [`record unreadable: ${record.unreadable}`] };
  if (record.status !== undefined) {
    const reasons = Array.isArray(record.pendingReasons) ? record.pendingReasons : [];
    return { status: 'pending', failures: [`${spec.gate} external evidence ${record.status}`, ...reasons] };
  }
  if (!hmacKey || !tenantRef || !build) {
    const missing = [!hmacKey && 'verification key', !tenantRef && 'tenant', !build && 'build'].filter(Boolean);
    return { status: 'unverified', failures: [`cannot verify ${spec.gate} without its ${missing.join(', ')}`] };
  }
  const result = verifyEvidence(record, { gate: spec.gate, tenantRef, build, requireLive: true, hmacKey, evidenceDir, now });
  return result.ok ? { status: 'live-qualified', failures: [] } : { status: 'failed', failures: result.failures };
}

function objectiveStatus(objective, liveByGate) {
  if (objective.gap) return 'gap';
  const statuses = objective.evidence.map((gate) => liveByGate.get(gate)?.status ?? 'missing');
  if (statuses.some((status) => status === 'failed')) return 'failed';
  if (statuses.length > 0 && statuses.every((status) => status === 'live-qualified')) return 'qualified';
  return 'pending';
}

/**
 * Build the ledger. `live` entries are either raw ({ gate, record }) or already
 * classified ({ gate, status }). Gates absent from `live` count as missing.
 */
export function buildReleaseLedger({
  fixture, live, hmacKey = null, tenantRef = null, build = null, now = new Date(), objectiveGapsAllowed = false,
}) {
  const reasons = [];
  let blocked = false;
  let pending = false;

  // Fixture results: reported as fixture-tested only.
  const fixtureValid = fixture && fixture.evidenceLevel === 'fixture-tested' && Array.isArray(fixture.journeys);
  if (!fixtureValid) {
    pending = true;
    reasons.push('no fixture journey results were supplied');
  } else {
    for (const journey of fixture.journeys) {
      if (journey.outcome !== 'passed') {
        blocked = true;
        reasons.push(`journey ${journey.journey} failed: ${(journey.failures ?? []).join('; ')}`);
      }
    }
    const seen = new Set(fixture.journeys.map((journey) => journey.journey));
    for (const id of ['J1', 'J2', 'J3', 'J4', 'J5', 'J6'].filter((entry) => !seen.has(entry))) {
      pending = true;
      reasons.push(`journey ${id} has no fixture result`);
    }
  }

  // Live acceptance: every required gate, verified or explicitly not.
  const supplied = new Map((live ?? []).map((entry) => [entry.gate, entry]));
  const liveRows = LIVE_ACCEPTANCE_GATES.map((spec) => {
    const entry = supplied.get(spec.gate);
    const classified = !entry
      ? { status: 'missing', failures: [`no ${spec.gate} record was supplied`] }
      : entry.status
        ? { status: entry.status, failures: entry.failures ?? [] }
        : classifyLiveRecord(spec, entry.record, { hmacKey, tenantRef, build, evidenceDir: entry.evidenceDir, now });
    return { task: spec.task, gate: spec.gate, title: spec.title, note: spec.note ?? null, acceptedGap: spec.acceptedGap ?? null, ...classified };
  });
  const acceptedGaps = [];
  for (const row of liveRows) {
    if (row.status === 'live-qualified') continue;
    if (row.acceptedGap && row.status !== 'failed') {
      acceptedGaps.push(`${row.gate} (${row.task}) is ${row.status}, an accepted gap: ${row.acceptedGap}`);
      continue;
    }
    if (row.status === 'failed') {
      blocked = true;
      reasons.push(`${row.gate} (${row.task}) failed live verification`);
    } else {
      pending = true;
      reasons.push(`${row.gate} (${row.task}) is ${row.status}`);
    }
  }

  const liveByGate = new Map(liveRows.map((row) => [row.gate, row]));
  const objectives = RELEASE_OBJECTIVES.map((objective) => ({ ...objective, status: objectiveStatus(objective, liveByGate) }));
  for (const objective of objectives) {
    if (objective.status === 'qualified') continue;
    if (objective.status === 'failed') {
      blocked = true;
      reasons.push(`objective ${objective.id} has a failed gate`);
    } else if (objective.status === 'pending' || !objectiveGapsAllowed) {
      pending = true;
      reasons.push(`objective ${objective.id} is ${objective.status}`);
    }
  }

  const label = blocked ? 'blocked' : pending ? 'pending' : 'ready';
  return {
    contractVersion: LEDGER_CONTRACT_VERSION,
    generatedAt: now.toISOString(),
    build,
    readiness: { label, reasons, acceptedGaps },
    fixture: fixtureValid
      ? { evidenceLevel: 'fixture-tested', synthetic: true, build: fixture.build ?? null, ranAt: fixture.ranAt ?? null,
        journeys: fixture.journeys }
      : null,
    live: liveRows,
    objectives,
  };
}

function arg(argv, name, fallback) {
  const index = argv.indexOf(`--${name}`);
  return index > -1 ? argv[index + 1] : fallback;
}

/**
 * `qualification.mjs ledger --fixture <journeys result> [--tenant <ref>] [--build <rev>] [--out <file>]`.
 * Exits 0 whatever the label (the ledger is a report); --require-ready exits 1 unless ready.
 */
export function runLedgerCommand(argv = process.argv, { env = process.env, logger = console } = {}) {
  const fixturePath = arg(argv, 'fixture');
  const fixture = fixturePath ? JSON.parse(readFileSync(fixturePath, 'utf8')) : null;
  const ledger = buildReleaseLedger({
    fixture,
    live: loadLiveRecords({ dir: arg(argv, 'qualifications', QUALIFICATIONS_DIR) }),
    hmacKey: env.KEEL_QUALIFICATION_HMAC_KEY ?? null,
    tenantRef: arg(argv, 'tenant', env.KEEL_QUALIFICATION_TENANT_REF ?? null),
    build: arg(argv, 'build', env.KEEL_QUALIFICATION_BUILD ?? null),
  });
  const out = arg(argv, 'out');
  if (out) writeFileSync(out, `${JSON.stringify(ledger, null, 2)}\n`);
  logger.log(JSON.stringify(ledger, null, 2));
  return argv.includes('--require-ready') && ledger.readiness.label !== 'ready' ? 1 : 0;
}
