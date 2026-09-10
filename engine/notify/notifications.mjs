// engine/notify/notifications.mjs
//
// §3.5, plan task 20: channels and subscriptions decide which events produce a
// delivery. A delivery is durable before its notify job is enqueued, and its outcome
// stays durable after the job ends. In particular, a failed transport never becomes a
// delivered row: it is either retrying at a visible next_attempt_at or terminally
// failed with its last_error recorded.
import { spawn } from 'node:child_process';
import { can } from '../authz/can.mjs';
import { findPrincipalById } from '../authz/principals.mjs';
import { enqueue } from '../jobs/queue.mjs';

export const DELIVERY_RETRY_BASE_MS = 30 * 1000;
export const DELIVERY_RETRY_MAX_MS = 60 * 60 * 1000;
export const DEFAULT_DELIVERY_MAX_ATTEMPTS = 5;

const SEVERITY_RANK = Object.freeze({ notice: 0, warning: 1, critical: 2 });

export class DeliveryAttemptError extends Error {
  constructor({ deliveryId, error, status }) {
    super(error);
    this.name = 'DeliveryAttemptError';
    this.deliveryId = deliveryId;
    this.status = status;
  }
}

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requireSeverity(value, label) {
  if (!(value in SEVERITY_RANK)) {
    throw new Error(`${label} must be one of notice, warning, critical`);
  }
  return value;
}

function requireEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw new Error('event must be an object');
  }
  requireNonEmptyString(event.kind, 'event.kind');
  requireSeverity(event.severity, 'event.severity');
  return event;
}

function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replaceAll('*', '.*').replaceAll('?', '.')}$`);
}

export function eventMatches(subscription, event) {
  return globToRegExp(subscription.event_glob).test(event.kind)
    && SEVERITY_RANK[event.severity] >= SEVERITY_RANK[subscription.min_severity];
}

export function retryDelayMs(attempt) {
  return Math.min(
    DELIVERY_RETRY_BASE_MS * (2 ** Math.max(0, attempt - 1)),
    DELIVERY_RETRY_MAX_MS,
  );
}

export async function createChannel(client, { kind, config, enabled = true }) {
  if (!['webhook', 'email'].includes(kind)) {
    throw new Error('channel.kind must be webhook or email');
  }
  const { rows } = await client.query(
    `INSERT INTO channel (kind, config, enabled)
     VALUES ($1,$2,$3)
     RETURNING *`,
    [kind, config ?? {}, enabled],
  );
  return rows[0];
}

export async function createSubscription(client, { channelId, eventGlob, minSeverity }) {
  requireNonEmptyString(channelId, 'channelId');
  requireNonEmptyString(eventGlob, 'eventGlob');
  requireSeverity(minSeverity, 'minSeverity');
  const { rows } = await client.query(
    `INSERT INTO subscription (channel_id, event_glob, min_severity)
     VALUES ($1,$2,$3)
     RETURNING *`,
    [channelId, eventGlob, minSeverity],
  );
  return rows[0];
}

// Create the durable delivery rows before enqueuing the jobs. The transaction ensures
// an event cannot be recorded as queued without a corresponding notify job (or the
// reverse). Multiple matching subscriptions for one channel produce one delivery.
export async function dispatchAlert(client, {
  event, requestedBy, maxAttempts = DEFAULT_DELIVERY_MAX_ATTEMPTS,
}) {
  requireEvent(event);
  requireNonEmptyString(requestedBy, 'requestedBy');
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('maxAttempts must be a positive integer');
  }
  // The durable delivery and its job are a mutating path, so reject an unregistered
  // or non-admin actor before writing either. keel-worker checks the same capability
  // again immediately before it invokes the notify handler.
  const requester = await findPrincipalById(client, requestedBy);
  if (!(await can(client, requester, 'configuration', new Date()))) {
    throw new Error('requester is not authorized to dispatch notifications');
  }

  await client.query('BEGIN');
  let committed = false;
  try {
    const { rows: subscriptions } = await client.query(
      `SELECT s.id AS subscription_id, s.event_glob, s.min_severity,
              c.id AS channel_id, c.kind AS channel_kind, c.config AS channel_config
         FROM subscription s
         JOIN channel c ON c.id = s.channel_id
        WHERE c.enabled = true
        ORDER BY s.created_at, s.id`,
    );
    const selectedChannels = new Map();
    for (const subscription of subscriptions) {
      if (eventMatches(subscription, event) && !selectedChannels.has(subscription.channel_id)) {
        selectedChannels.set(subscription.channel_id, subscription);
      }
    }

    const deliveries = [];
    for (const subscription of selectedChannels.values()) {
      const { rows } = await client.query(
        `INSERT INTO delivery (event, channel_id, requested_by, max_attempts)
         VALUES ($1,$2,$3,$4)
         RETURNING *`,
        [event, subscription.channel_id, requestedBy, maxAttempts],
      );
      const delivery = rows[0];
      const job = await enqueue(client, {
        kind: 'notify',
        params: { deliveryId: delivery.id },
        requestedBy,
        idempotencyKey: `delivery:${delivery.id}:attempt:1`,
      });
      deliveries.push({ delivery, job });
    }
    await client.query('COMMIT');
    committed = true;
    return deliveries;
  } finally {
    if (!committed) await client.query('ROLLBACK');
  }
}

// `dispatchEvent` is the notification-model name used by callers that do not think
// of their source event as an alert. Its payload contract is the same §3.5 event.
export const dispatchEvent = dispatchAlert;

export async function listDeliveries(client, { channelId, limit = 50 } = {}) {
  const { rows } = await client.query(
    `SELECT d.*, c.kind AS channel_kind
       FROM delivery d
       JOIN channel c ON c.id = d.channel_id
      WHERE ($1::uuid IS NULL OR d.channel_id = $1)
      ORDER BY d.created_at DESC
      LIMIT $2`,
    [channelId ?? null, limit],
  );
  return rows;
}

async function sendWebhook({ channel, event }) {
  const url = requireNonEmptyString(channel.config?.url, 'channel.config.url');
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('channel.config.url must use http or https');
  }
  const response = await fetch(parsed, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(event),
  });
  if (!response.ok) throw new Error(`webhook returned HTTP ${response.status}`);
}

async function sendEmail({ channel, event }) {
  const to = requireNonEmptyString(channel.config?.to, 'channel.config.to');
  const from = requireNonEmptyString(channel.config?.from, 'channel.config.from');
  const subject = channel.config?.subject
    ?? `[KEEL ${String(event.severity).toUpperCase()}] ${event.kind}`;
  const message = [
    `To: ${to}`,
    `From: ${from}`,
    `Subject: ${subject}`,
    'Content-Type: application/json; charset=utf-8',
    '',
    JSON.stringify(event),
    '',
  ].join('\n');

  await new Promise((resolve, reject) => {
    const child = spawn('/usr/sbin/sendmail', ['-t', '-i'], { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`sendmail exited with code ${code}${stderr ? `: ${stderr}` : ''}`));
    });
    child.stdin.end(message);
  });
}

export const DEFAULT_TRANSPORTS = Object.freeze({
  webhook: sendWebhook,
  email: sendEmail,
});

async function markUnavailableChannel(client, delivery, error) {
  const { rows } = await client.query(
    `UPDATE delivery
        SET status = 'cancelled', last_error = $2
      WHERE id = $1
      RETURNING *`,
    [delivery.id, error],
  );
  return rows[0];
}

// Execute one notify job. A row is claimed before any outbound transport is called;
// this also lets a requeued job recover an interrupted attempt left in `delivering`.
// A transport error is written to delivery first, then a future notify job is enqueued
// with exponential backoff. The current job still fails, making each failed attempt
// visible in both the delivery log and the job log.
export async function attemptDelivery(client, {
  deliveryId, transports = DEFAULT_TRANSPORTS, now = new Date(),
}) {
  requireNonEmptyString(deliveryId, 'deliveryId');
  const { rows: claimedRows } = await client.query(
    `UPDATE delivery
        SET status = 'delivering', attempts = attempts + 1
      WHERE id = $1
        AND status IN ('queued','retrying','delivering')
        AND next_attempt_at <= now()
      RETURNING *`,
    [deliveryId],
  );
  const delivery = claimedRows[0];
  if (!delivery) {
    const { rows } = await client.query('SELECT * FROM delivery WHERE id = $1', [deliveryId]);
    if (!rows[0]) throw new Error(`delivery not found: ${deliveryId}`);
    return { delivery: rows[0], attempted: false };
  }

  const { rows: channelRows } = await client.query('SELECT * FROM channel WHERE id = $1', [delivery.channel_id]);
  const channel = channelRows[0];
  if (!channel || !channel.enabled) {
    return {
      delivery: await markUnavailableChannel(
        client, delivery, channel ? 'channel disabled before delivery' : 'channel no longer exists',
      ),
      attempted: true,
    };
  }

  try {
    const transport = transports[channel.kind];
    if (typeof transport !== 'function') {
      throw new Error(`no transport registered for channel kind: ${channel.kind}`);
    }
    await transport({ channel, event: delivery.event });
    const { rows } = await client.query(
      `UPDATE delivery
          SET status = 'delivered', delivered_at = now(), last_error = NULL
        WHERE id = $1
        RETURNING *`,
      [delivery.id],
    );
    return { delivery: rows[0], attempted: true };
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause);
    const retry = delivery.attempts < delivery.max_attempts;
    const status = retry ? 'retrying' : 'failed';
    const nextAttemptAt = retry
      ? new Date(now.getTime() + retryDelayMs(delivery.attempts))
      : null;

    await client.query('BEGIN');
    let committed = false;
    try {
      const { rows } = await client.query(
        `UPDATE delivery
            SET status = $2, last_error = $3, next_attempt_at = COALESCE($4, next_attempt_at)
          WHERE id = $1
          RETURNING *`,
        [delivery.id, status, error, nextAttemptAt],
      );
      const failedDelivery = rows[0];
      if (retry) {
        await enqueue(client, {
          kind: 'notify',
          params: { deliveryId: delivery.id },
          requestedBy: delivery.requested_by,
          idempotencyKey: `delivery:${delivery.id}:attempt:${delivery.attempts + 1}`,
          notBefore: nextAttemptAt,
        });
      }
      await client.query('COMMIT');
      committed = true;
      throw new DeliveryAttemptError({ deliveryId: delivery.id, error, status: failedDelivery.status });
    } finally {
      if (!committed) await client.query('ROLLBACK');
    }
  }
}
