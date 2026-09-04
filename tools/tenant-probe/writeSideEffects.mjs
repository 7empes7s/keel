#!/usr/bin/env node
/**
 * Fields that changed as a SIDE EFFECT of a write: read an object, PATCH exactly one
 * writable field, re-read, and report every OTHER path that moved. Those are server-owned
 * by measurement, and must not be inside the drift hash (spec M2.3).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GraphWriter } from '../../engine/restore/graphWriter.mjs';
import { getToken } from './auth.mjs';
import { GraphReader } from './graph.mjs';

/** Fields that changed as a SIDE EFFECT of a write: read an object, PATCH exactly one
 * writable field, re-read, and report every OTHER path that moved. Those are server-owned
 * by measurement, and must not be inside the drift hash (spec M2.3). */
export function sideEffectPaths(before, after, { patchedField }) {
  const paths = new Set();
  walk(before, after, '', paths);
  paths.delete(patchedField);
  return paths;
}

function walk(before, after, path, paths) {
  if (Object.is(before, after)) return;

  if (Array.isArray(before) && Array.isArray(after)) {
    const length = Math.max(before.length, after.length);
    for (let index = 0; index < length; index++) {
      if (index >= before.length || index >= after.length) {
        paths.add(path);
      } else {
        walk(before[index], after[index], path, paths);
      }
    }
    return;
  }

  if (isObject(before) && isObject(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of keys) {
      const dottedPath = path ? `${path}.${key}` : key;
      if (!(key in before) || !(key in after)) {
        paths.add(dottedPath);
      } else {
        walk(before[key], after[key], dottedPath, paths);
      }
    }
    return;
  }

  paths.add(path);
}

function isObject(value) {
  return value !== null && typeof value === 'object';
}

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 ? process.argv[index + 1] : fallback;
}

function flag(name) {
  return process.argv.includes(`--${name}`);
}

function assertDisposableNaturalKey(naturalKey) {
  if (!naturalKey?.startsWith('group:keel-rehearsal-')) {
    throw new Error('refusing to mutate a non-disposable group: --natural-key must start with group:keel-rehearsal-');
  }
}

function readConfig(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function assertCredentialSeparation(collectorConfig, restorerConfig) {
  if (
    collectorConfig.clientId === restorerConfig.clientId
    || collectorConfig.certPath === restorerConfig.certPath
    || collectorConfig.keyPath === restorerConfig.keyPath
  ) {
    throw new Error('Collector and Restorer credentials must be separate');
  }
}

function groupMailNickname(naturalKey) {
  return naturalKey.slice('group:'.length);
}

function odataString(value) {
  return value.replace(/'/g, "''");
}

async function readGroup(reader, naturalKey) {
  const mailNickname = groupMailNickname(naturalKey);
  const result = await reader.get(
    'v1.0',
    `/groups?$filter=mailNickname%20eq%20'${encodeURIComponent(odataString(mailNickname))}'&$select=id,displayName,mailNickname,modifiedDateTime`,
  );
  if (!result.ok) throw new Error(`read failed: ${result.error ?? result.status}`);
  if (result.body?.value?.length !== 1) {
    throw new Error(`expected exactly one group for ${naturalKey}, found ${result.body?.value?.length ?? 0}`);
  }
  return result.body.value[0];
}

async function runLive(naturalKey, restorerConfigPath) {
  assertDisposableNaturalKey(naturalKey);
  if (!restorerConfigPath) throw new Error('--restorer-config is required with --live');

  const collectorConfig = readConfig('/etc/keel/tenant.json');
  const restorerConfig = readConfig(restorerConfigPath);
  assertCredentialSeparation(collectorConfig, restorerConfig);

  const collectorToken = await getToken(collectorConfig);
  const reader = new GraphReader(async () => collectorToken.accessToken);
  const before = await readGroup(reader, naturalKey);

  const restorerToken = await getToken(restorerConfig);
  const writer = new GraphWriter(async () => restorerToken.accessToken);
  const patchedField = 'displayName';
  const writeResult = await writer.write('v1.0', `/groups/${before.id}`, {
    method: 'PATCH',
    body: { [patchedField]: `${before.displayName} (write-side-effect probe)` },
  });
  if (!writeResult.ok) throw new Error(`patch failed: ${JSON.stringify(writeResult.body)}`);

  const after = await readGroup(reader, naturalKey);
  process.stdout.write(`${JSON.stringify([...sideEffectPaths(before, after, { patchedField })].sort(), null, 2)}\n`);
}

async function main() {
  const dryRun = flag('dry-run');
  const live = flag('live');
  if (dryRun && live) throw new Error('choose either --dry-run or --live');

  if (dryRun) {
    process.stdout.write('dry-run: read → patch → re-read\n');
    return;
  }

  if (!live) throw new Error('--dry-run or --live is required');
  await runLive(arg('natural-key'), arg('restorer-config'));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
