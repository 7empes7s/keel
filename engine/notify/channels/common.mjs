// engine/notify/channels/common.mjs
//
// Roadmap task-84: helpers shared by the provider contracts and adapters.mjs.
import { createHash } from 'node:crypto';

// A credential reference names where the secret lives; it never is the secret.
const REFERENCE = /^env:[A-Za-z_][A-Za-z0-9_]*$/;
export function isCredentialReference(value) {
  return typeof value === 'string' && REFERENCE.test(value);
}

/** Deterministic, provider-length-safe key: short keys are kept, long ones hashed. */
export function boundedKey(key, max) {
  if (key.length <= max) return key;
  return `${key.slice(0, max - 65)}:${createHash('sha256').update(key).digest('hex')}`;
}

export function capText(text, max) {
  const value = String(text ?? '');
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** One line a person can read on any channel. */
export function eventSummary(event) {
  const severity = String(event.severity ?? 'notice').toUpperCase();
  const subject = [event.resourceKey, event.control && event.condition ? `${event.control}/${event.condition}` : null]
    .filter(Boolean).join(' ');
  return `[KEEL ${severity}] ${event.kind}${subject ? `: ${subject}` : ''}`;
}

export function parseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

/** The status classes every provider shares: 2xx sent, 408/429/5xx retry, other 4xx refused. */
export function httpOutcome(status) {
  if (status >= 200 && status < 300) return 'delivered';
  if (status === 408 || status === 429 || status >= 500) return 'retry';
  return 'rejected';
}

/** Config keys that must hold credential references, plus keys the contract does not know. */
export function configProblems(config, { references = [], allowed = [] }) {
  const problems = [];
  for (const key of references) {
    if (config[key] === undefined) problems.push(`${key} is required`);
    else if (!isCredentialReference(config[key])) problems.push(`${key} must be a credential reference such as env:NAME, not the secret itself`);
  }
  for (const key of Object.keys(config)) {
    if (!references.includes(key) && !allowed.includes(key)) problems.push(`${key} is not a setting for this channel`);
  }
  return problems;
}

export function httpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

export function snippet(text, max = 200) {
  return capText(String(text ?? '').replace(/\s+/g, ' ').trim(), max);
}
