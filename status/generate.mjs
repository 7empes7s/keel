#!/usr/bin/env node
// status/generate.mjs
// node generate.mjs [--config /etc/keel/tenant.json] [--db-url $KEEL_STATUS_DB_URL]
//                    [--repo-dir /opt/keel] [--out status/out/index.html]
import { createHash } from 'node:crypto';
import {
  readFileSync, writeFileSync, renameSync, mkdirSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { connect } from './db.mjs';
import { collectGovernance } from './queries.mjs';
import { collectBuildProgress } from './buildProgress.mjs';
import { renderPage } from './render.mjs';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 ? process.argv[index + 1] : fallback;
}

function tenantRefFor(config) {
  return `sha256:${createHash('sha256').update(config.tenantId).digest('hex').slice(0, 16)}`;
}

export async function run({
  configPath, dbUrl, repoDir, outPath,
  connect, collectGovernance: fetchGovernance, collectBuildProgress: fetchProgress, now,
}) {
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const tenantRef = tenantRefFor(config);
  const client = await connect(dbUrl);
  try {
    const governance = await fetchGovernance(client, { tenantRef });
    const buildProgress = fetchProgress({ repoDir });
    const html = renderPage({ buildProgress, governance, generatedAt: now() });
    const tmpPath = `${outPath}.tmp`;
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(tmpPath, html);
    renameSync(tmpPath, outPath);
    return { status: 'ok' };
  } finally {
    await client.end();
  }
}

async function main() {
  const configPath = arg('config', '/etc/keel/tenant.json');
  const dbUrl = arg('db-url', process.env.KEEL_STATUS_DB_URL);
  if (!dbUrl) throw new Error('KEEL_STATUS_DB_URL not set (source /etc/keel/status-db.env)');
  const repoDir = arg('repo-dir', '/opt/keel');
  const outPath = arg('out', new URL('./out/index.html', import.meta.url).pathname);

  try {
    const result = await run({
      configPath, dbUrl, repoDir, outPath,
      connect, collectGovernance, collectBuildProgress, now: () => new Date(),
    });
    console.log(`keel-status-generate: ${result.status}, wrote ${outPath}`);
  } catch (error) {
    console.error(`keel-status-generate: FAILED — ${error.message}`);
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
