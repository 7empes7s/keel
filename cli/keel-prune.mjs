#!/usr/bin/env node
// /opt/keel/cli/keel-prune.mjs
//
// node keel-prune.mjs [--config /etc/keel/tenant.json] [--db-url $KEEL_DB_URL] [--report out.json] [--apply]
//
// Without --apply this is a dry run: it saves a prune report (what would go, what
// stays and why) and deletes nothing. --dry-run is accepted and means the same. With
// --apply it saves the same report, then deletes exactly what the report lists.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { connect } from '../engine/store/db.mjs';
import { runPrune } from '../engine/store/retention.mjs';

const USAGE = 'usage: keel-prune.mjs [--config /etc/keel/tenant.json] [--db-url $KEEL_DB_URL] [--report out.json] [--apply]';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}

const totals = (counts) => Object.entries(counts).map(([kind, n]) => `${kind} ${n}`).join(', ') || 'none';

async function main() {
  if (process.argv.includes('--help')) {
    console.log(USAGE);
    return;
  }

  const apply = process.argv.includes('--apply');
  if (apply && process.argv.includes('--dry-run')) throw new Error('--apply and --dry-run cannot be used together');
  const config = JSON.parse(readFileSync(arg('config', '/etc/keel/tenant.json'), 'utf8'));
  const dbUrl = arg('db-url', process.env.KEEL_DB_URL);
  if (!dbUrl) throw new Error('KEEL_DB_URL not set (source /etc/keel/db.env or pass --db-url)');

  const tenantRef = `sha256:${createHash('sha256').update(config.tenantId).digest('hex').slice(0, 16)}`;
  const client = await connect(dbUrl);
  try {
    const { reportId, report } = await runPrune(client, { tenantRef, now: new Date(), apply });
    const reportPath = arg('report');
    if (reportPath) writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    const verb = apply ? 'pruned' : 'would prune';
    const snapshotIds = report.snapshots.delete;
    const { content } = report;
    console.log(`${verb} ${snapshotIds.length} snapshot(s)${snapshotIds.length ? `: ${snapshotIds.join(', ')}` : ''}`);
    console.log(`${verb} ${content.delete.length} content version(s) and ${content.chunks.length} chunk(s) of ${content.freedBytes} bytes`);
    console.log(`kept snapshots: ${totals(report.snapshots.kept)}`);
    console.log(`kept content versions: ${totals(content.kept)}; ${content.singleVersionItems} item(s) with one version`);
    console.log(`policies: ${report.policies.join('; ')}`);
    if (report.holds.length) console.log(`legal holds: ${report.holds.map((hold) => `${hold.scope} (${hold.reason})`).join('; ')}`);
    console.log(`report ${reportId} saved${reportPath ? ` and written to ${reportPath}` : ''}`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
