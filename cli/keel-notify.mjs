#!/usr/bin/env node
// /opt/keel/cli/keel-notify.mjs
//
// node keel-notify.mjs --delivery-id ID [--db-url $KEEL_DB_URL]
// node keel-notify.mjs --list [--channel-id ID]
//   [--status queued|retrying|delivering|delivered|failed|cancelled] [--limit N]
//
// Thin worker-dispatch wrapper around the Task 20 notification delivery path. The
// worker owns the job result; this process owns the delivery log transition. A failed
// transport exits non-zero only after attemptDelivery has persisted the error and, when
// applicable, its backoff retry job.
import { pathToFileURL } from 'node:url';
import { attemptDelivery, listDeliveries } from '../engine/notify/notifications.mjs';
import { connect } from '../engine/store/db.mjs';

const DELIVERY_STATUSES = new Set([
  'queued', 'retrying', 'delivering', 'delivered', 'failed', 'cancelled',
]);

const USAGE = `usage:
  keel-notify.mjs --delivery-id ID [--db-url $KEEL_DB_URL]
  keel-notify.mjs --list [--channel-id ID] [--status queued|retrying|delivering|delivered|failed|cancelled] [--limit N] [--db-url $KEEL_DB_URL]`;

function arg(name, fallback, argv = process.argv) {
  const index = argv.indexOf(`--${name}`);
  return index > -1 ? argv[index + 1] : fallback;
}

export async function main({
  argv = process.argv,
  dbUrl = process.env.KEEL_DB_URL,
  dependencies = {},
  logger = console,
} = {}) {
  if (argv.includes('--help')) {
    logger.log(USAGE);
    return;
  }
  const shouldList = argv.includes('--list');
  const deliveryId = arg('delivery-id', undefined, argv);
  if (shouldList && typeof deliveryId === 'string' && deliveryId.length > 0) {
    throw new Error('--list and --delivery-id are mutually exclusive');
  }
  if (!shouldList && (typeof deliveryId !== 'string' || deliveryId.length === 0)) {
    logger.log(USAGE);
    throw new Error('--delivery-id is required');
  }

  const channelId = arg('channel-id', undefined, argv);
  const status = arg('status', undefined, argv);
  if (shouldList && status !== undefined && !DELIVERY_STATUSES.has(status)) {
    throw new Error('--status must be queued, retrying, delivering, delivered, failed, or cancelled');
  }
  const limit = Number(arg('limit', 50, argv));
  if (shouldList && (!Number.isSafeInteger(limit) || limit < 1)) {
    throw new Error('--limit must be a positive integer');
  }

  const resolvedDbUrl = arg('db-url', dbUrl, argv);
  if (!resolvedDbUrl) throw new Error('KEEL_DB_URL not set (source /etc/keel/db.env or pass --db-url)');

  const connectFn = dependencies.connect ?? connect;
  const client = await connectFn(resolvedDbUrl);
  try {
    if (shouldList) {
      const listDeliveriesFn = dependencies.listDeliveries ?? listDeliveries;
      const deliveries = await listDeliveriesFn(client, { channelId, status, limit });
      for (const delivery of deliveries) {
        logger.log([
          `id=${delivery.id}`,
          `channel=${delivery.channel_id}`,
          `status=${delivery.status}`,
          `attempts=${delivery.attempts}/${delivery.max_attempts}`,
          `next_attempt_at=${delivery.next_attempt_at ?? 'null'}`,
          `last_error=${delivery.last_error ?? 'null'}`,
        ].join(' '));
      }
      return deliveries;
    }

    const attemptDeliveryFn = dependencies.attemptDelivery ?? attemptDelivery;
    const result = await attemptDeliveryFn(client, { deliveryId });
    logger.log(`delivery ${deliveryId}: ${result.delivery.status}`);
    return result;
  } finally {
    await client.end();
  }
}

export async function runCli(options = {}) {
  try {
    await main(options);
    return 0;
  } catch (error) {
    (options.logger ?? console).error(error);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().then((exitCode) => { process.exitCode = exitCode; });
}
