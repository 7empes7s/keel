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

const OBJECTIVES_SOURCE = 'docs/release/objectives-source.md';
/**
 * Objective gaps hold readiness unless the ledger run passes --accept-objective-gaps.
 * Accepted gaps are listed by name and reason, never counted as qualified, and a
 * failed or pending live gate still holds or blocks its objective.
 */
export const OBJECTIVE_GAPS_DECISION = 'accepted by operator decision 2026-10-09 09:05 UTC';
const tasks = (...ids) => ids.map((id) => `task-${id}`);
const roadmap = (...names) => names.map((name) => `engine/roadmap/${name}.test.mjs`);
const NO_LIVE_GATE = 'no live gate is defined for it, so it is fixture-tested only';

/**
 * D1-D10 and G1-G8, as the 2026-09-15 final review defines them: an id, a short
 * title and the owner tasks that close it or explicitly qualify it (copied in
 * OBJECTIVES_SOURCE). An objective is qualified only through its live gates. One
 * with no live gate, or whose own qualification says it stays unproven, is an
 * explicit gap that names why; it is never reported as qualified.
 */
export const RELEASE_OBJECTIVES = Object.freeze([
  { id: 'D1', definition: 'Actual deployment.', source: OBJECTIVES_SOURCE,
    owners: tasks(45, 46, 113), tests: roadmap('foundation', 'portal-parity', 'deployed-acceptance'),
    evidence: ['deployed-acceptance'], gap: null },
  { id: 'D2', definition: 'Native CA credential support; manual until proven.', source: OBJECTIVES_SOURCE,
    owners: tasks(64, 115), tests: roadmap('native-recovery', 'native-live-acceptance'),
    evidence: ['native-live-acceptance'], gap: null },
  { id: 'D3', definition: 'Dynamic group feasibility/cost; conservative unknown until measured (docs/roadmap/dynamic-impact.md).',
    source: OBJECTIVES_SOURCE, owners: tasks(60), tests: roadmap('dynamic-impact'), evidence: [],
    gap: 'D3 stays unmeasured until a non-synthetic sizing record exists; no live sizing gate is defined' },
  { id: 'D4', definition: 'Workload qualification; explicit sequential gates.', source: OBJECTIVES_SOURCE,
    owners: tasks(101, 102, 103, 104, 105, 106, 120, 121, 122, 123),
    tests: roadmap('workload-contract', 'sharepoint-read', 'sharepoint-write', 'teams-config', 'exchange-config', 'onedrive-purview',
      'sharepoint-live-acceptance', 'teams-live-acceptance', 'exchange-live-acceptance', 'onedrive-purview-live-acceptance'),
    evidence: ['sharepoint-live-acceptance', 'teams-live-acceptance', 'exchange-live-acceptance', 'onedrive-purview-live-acceptance'],
    gap: null },
  { id: 'D5', definition: 'CIS distribution permission; synthetic/custom controls until rights exist (no CIS content ships).',
    source: OBJECTIVES_SOURCE, owners: tasks(86, 119), tests: roadmap('nist-benchmark-acceptance'),
    evidence: ['nist-benchmark-acceptance'], gap: null },
  { id: 'D6', definition: 'ServiceNow workflow, proven live through the canonical KEEL decision (docs/roadmap/servicenow-live-acceptance.md).',
    source: OBJECTIVES_SOURCE, owners: tasks(96, 97, 118), tests: roadmap('servicenow', 'servicenow-live-acceptance'),
    evidence: ['servicenow-live-acceptance'], gap: null },
  { id: 'D7', definition: 'Audit sizing/retention; optional bounded ingestion, not assumed free/full.', source: OBJECTIVES_SOURCE,
    owners: tasks(88), tests: roadmap('audit-ingestion'), evidence: [],
    gap: `D7: ${NO_LIVE_GATE}; audit volume and retention are not measured on a real tenant` },
  { id: 'D8', definition: 'Independent immutable storage.', source: OBJECTIVES_SOURCE,
    owners: tasks(69, 114), tests: roadmap('immutable-storage', 'storage-live-acceptance'), evidence: [],
    gap: 'D8: gate 114 proves an independent recovery read, but retention lock and immutability are reported unqualified by operator decision 2026-09-30' },
  { id: 'D9', definition: 'External evidence anchor.', source: OBJECTIVES_SOURCE,
    owners: tasks(78, 114), tests: roadmap('evidence-anchors', 'storage-live-acceptance'), evidence: [],
    gap: 'D9: checkpoint publication is fixture-tested only and disabled in production pending storage/key qualification (docs/roadmap/evidence-anchors.md)' },
  { id: 'D10', definition: 'Observation non-atomicity: tiered observations are never presented as an atomic tenant-wide snapshot.',
    source: OBJECTIVES_SOURCE, owners: tasks(45, 51, 54, 73, 112),
    tests: roadmap('foundation', 'semantic-projection', 'coverage-ui', 'recovery-metrics', 'acceptance-harness'), evidence: [],
    gap: `D10: ${NO_LIVE_GATE}` },
  { id: 'G1', definition: 'Lineage.', source: OBJECTIVES_SOURCE,
    owners: tasks(48, 50), tests: roadmap('lineage', 'symbol-context'), evidence: [], gap: `G1: ${NO_LIVE_GATE}` },
  { id: 'G2', definition: 'Relationships.', source: OBJECTIVES_SOURCE, owners: tasks(57, 58, 59, 60, 61),
    tests: roadmap('relationship-observations', 'privilege-relationships', 'impact-graph', 'dynamic-impact', 'relationship-restore'),
    evidence: [], gap: `G2: ${NO_LIVE_GATE}` },
  { id: 'G3', definition: 'Change intent.', source: OBJECTIVES_SOURCE,
    owners: tasks(93, 96), tests: roadmap('change-intents', 'itsm-contract'), evidence: [], gap: `G3: ${NO_LIVE_GATE}` },
  { id: 'G4', definition: 'Incident-qualified points.', source: OBJECTIVES_SOURCE,
    owners: tasks(71), tests: roadmap('incident-recovery'), evidence: [], gap: `G4: ${NO_LIVE_GATE}` },
  { id: 'G5', definition: 'Human identity completion.', source: OBJECTIVES_SOURCE,
    owners: tasks(65), tests: roadmap('identity-completion'), evidence: [], gap: `G5: ${NO_LIVE_GATE}` },
  { id: 'G6', definition: 'Native mechanism selection.', source: OBJECTIVES_SOURCE,
    owners: tasks(64, 115), tests: roadmap('native-recovery', 'native-live-acceptance'),
    evidence: ['native-live-acceptance'], gap: null },
  { id: 'G7', definition: 'Irreversible configuration effects.', source: OBJECTIVES_SOURCE,
    owners: tasks(66, 103, 104, 105, 106), tests: roadmap('content-effects'), evidence: [],
    gap: `G7: ${NO_LIVE_GATE}; the workload gates prove restore round trips, not the irreversible-effect warnings` },
  { id: 'G8', definition: 'Keel self-recovery.', source: OBJECTIVES_SOURCE,
    owners: tasks(67, 68, 114, 116), tests: roadmap('keel-recovery', 'storage-contract', 'storage-live-acceptance', 'drill-live-acceptance'),
    evidence: ['storage-live-acceptance', 'drill-live-acceptance'], gap: null },
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
  const acceptedObjectiveGaps = [];
  for (const objective of objectives) {
    if (objective.status === 'qualified') continue;
    if (objective.status === 'failed') {
      blocked = true;
      reasons.push(`objective ${objective.id} has a failed gate`);
    } else if (objective.status === 'pending' || !objectiveGapsAllowed) {
      pending = true;
      reasons.push(`objective ${objective.id} is ${objective.status}`);
    } else {
      acceptedObjectiveGaps.push(`objective ${objective.id} is a gap, ${OBJECTIVE_GAPS_DECISION}: ${objective.gap}`);
    }
  }

  const label = blocked ? 'blocked' : pending ? 'pending' : 'ready';
  return {
    contractVersion: LEDGER_CONTRACT_VERSION,
    generatedAt: now.toISOString(),
    build,
    readiness: { label, reasons, acceptedGaps, acceptedObjectiveGaps, objectiveGapsAccepted: objectiveGapsAllowed },
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
    objectiveGapsAllowed: argv.includes('--accept-objective-gaps'),
  });
  const out = arg(argv, 'out');
  if (out) writeFileSync(out, `${JSON.stringify(ledger, null, 2)}\n`);
  logger.log(JSON.stringify(ledger, null, 2));
  return argv.includes('--require-ready') && ledger.readiness.label !== 'ready' ? 1 : 0;
}
