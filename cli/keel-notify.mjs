#!/usr/bin/env node
// /opt/keel/cli/keel-notify.mjs
//
// node keel-notify.mjs --delivery-id ID [--db-url $KEEL_DB_URL]
//
// Thin worker-dispatch wrapper around the Task 20 notification delivery path. The
// worker owns the job result; this process owns the delivery log transition. A failed
// transport exits non-zero only after attemptDelivery has persisted the error and, when
// applicable, its backoff retry job.
import { pathToFileURL } from 'node:url';
import { attemptDelivery } from '../engine/notify/notifications.mjs';
import { connect } from '../engine/store/db.mjs';

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
    logger.log('usage: keel-notify.mjs --delivery-id ID [--db-url $KEEL_DB_URL]');
    return;
  }
  const deliveryId = arg('delivery-id', undefined, argv);
  if (typeof deliveryId !== 'string' || deliveryId.length === 0) {
    throw new Error('--delivery-id is required');
  }
  const resolvedDbUrl = arg('db-url', dbUrl, argv);
  if (!resolvedDbUrl) throw new Error('KEEL_DB_URL not set (source /etc/keel/db.env or pass --db-url)');

  const connectFn = dependencies.connect ?? connect;
  const attemptDeliveryFn = dependencies.attemptDelivery ?? attemptDelivery;
  const client = await connectFn(resolvedDbUrl);
  try {
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
