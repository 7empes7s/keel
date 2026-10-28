#!/usr/bin/env node
// /opt/keel/cli/keel-dispose.mjs
//
// node keel-dispose.mjs --approval-id ID --actor PRINCIPAL [--db-url $KEEL_DB_URL]
//
// Worker-dispatch wrapper for an approved accept or ignore (security audit run 2,
// finding 3). The decision (which change, accept or ignore, the reason, the end of an
// ignore) is read from the approval row, never from argv, and the engine checks that
// row again (dispositionReview.mjs#assertDispositionApproval) before it writes.
import { pathToFileURL } from 'node:url';
import { applyDisposition } from '../engine/govern/disposition.mjs';
import { DISPOSE_APPROVAL_ACTION } from '../engine/govern/dispositionReview.mjs';
import { acceptServiceChange } from '../engine/govern/workloadApproved.mjs';
import { resolveAlert } from '../engine/notify/alerts.mjs';
import { connect } from '../engine/store/db.mjs';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}

function requireArg(name) {
  const value = arg(name);
  if (typeof value !== 'string' || value.length === 0) throw new Error(`--${name} is required`);
  return value;
}

/** Applies the approved decision. Exported for tests. */
export async function runApprovedDisposition(client, { approvalId, actor }) {
  const { rows: [request] } = await client.query(
    'SELECT id, action, params FROM approval_request WHERE id::text = $1',
    [approvalId],
  );
  if (!request || request.action !== DISPOSE_APPROVAL_ACTION) throw new Error(`no decision approval ${approvalId}`);
  const params = request.params ?? {};
  if (typeof params.serviceChangeId === 'string') {
    const accepted = await acceptServiceChange(client, {
      tenantRef: params.tenantRef, changeId: params.serviceChangeId, actor, reason: params.reason, approvalId,
    });
    if (accepted.alertId) {
      await resolveAlert(client, {
        tenantRef: params.tenantRef, alertId: accepted.alertId, actor, reason: `Accepted into the approved setup: ${String(params.reason).trim()}`,
      }).catch(() => {
        // The next read matches the approved setup and resolves it.
      });
    }
    return { serviceChange: params.serviceChangeId, action: 'accept' };
  }
  const [driftId] = Array.isArray(params.driftIds) ? params.driftIds : [];
  await applyDisposition(client, {
    driftId, action: params.action, actor, reason: params.reason, expiresAt: params.expiresAt, approvalId,
  });
  return { drift: driftId, action: params.action };
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log('usage: keel-dispose.mjs --approval-id ID --actor PRINCIPAL [--db-url $KEEL_DB_URL]');
    return;
  }
  const dbUrl = arg('db-url', process.env.KEEL_DB_URL);
  if (!dbUrl) throw new Error('KEEL_DB_URL not set (source /etc/keel/db.env or pass --db-url)');
  const client = await connect(dbUrl);
  try {
    const done = await runApprovedDisposition(client, { approvalId: requireArg('approval-id'), actor: requireArg('actor') });
    console.log(`approved ${done.action} applied`);
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
