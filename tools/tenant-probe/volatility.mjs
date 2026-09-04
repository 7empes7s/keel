#!/usr/bin/env node
/**
 * Measure fields that change between two unchanged M1 collections.
 *
 * This module uses the Collector configuration and GraphReader, whose public
 * API issues GET requests only. Its JSON output is intentionally the only
 * stdout output so the prescribed redirection produces a usable artifact.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { collectM1 } from '../../engine/collect/entraAdapter.mjs';
import { getToken } from './auth.mjs';
import { GraphReader } from './graph.mjs';

/** Returns the set of dotted field paths that differed between two collections of the
 * same unchanged tenant — i.e. the fields that are volatile by measurement. */
export function volatilePaths(collectionA, collectionB) {
  const a = new Map(collectionA);
  const b = new Map(collectionB);
  const volatile = new Map();

  for (const [resourceType, objectsA] of a) {
    const objectsB = b.get(resourceType);
    if (!objectsB) continue;

    const paths = new Set();
    volatile.set(resourceType, paths);
    const byIdA = new Map(objectsA.filter((object) => object?.id).map((object) => [object.id, object]));
    const byIdB = new Map(objectsB.filter((object) => object?.id).map((object) => [object.id, object]));

    for (const [id, objectA] of byIdA) {
      const objectB = byIdB.get(id);
      if (!objectB) continue;
      walk(objectA, objectB, '', paths);
    }
  }

  return volatile;
}

function walk(valueA, valueB, path, paths) {
  if (Object.is(valueA, valueB)) return;

  if (Array.isArray(valueA) && Array.isArray(valueB)) {
    const length = Math.max(valueA.length, valueB.length);
    for (let index = 0; index < length; index++) {
      if (index >= valueA.length || index >= valueB.length) {
        paths.add(path);
      } else {
        walk(valueA[index], valueB[index], path, paths);
      }
    }
    return;
  }

  if (isObject(valueA) && isObject(valueB)) {
    const keys = new Set([...Object.keys(valueA), ...Object.keys(valueB)]);
    for (const key of keys) {
      const dottedPath = path ? `${path}.${key}` : key;
      if (!(key in valueA) || !(key in valueB)) {
        paths.add(dottedPath);
      } else {
        walk(valueA[key], valueB[key], dottedPath, paths);
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

async function collect(config) {
  let token = await getToken(config);
  const reader = new GraphReader(async () => {
    if (Date.now() > token.expiresAt - 120_000) token = await getToken(config);
    return token.accessToken;
  });
  return collectM1(reader);
}

function jsonMap(paths) {
  return Object.fromEntries(
    [...paths].map(([resourceType, fields]) => [resourceType, [...fields].sort()]),
  );
}

async function main() {
  const configPath = arg('config', '/etc/keel/tenant.json');
  const gapSeconds = Number(arg('gap-seconds', '20'));
  if (!Number.isFinite(gapSeconds) || gapSeconds < 0) {
    throw new Error('--gap-seconds must be a non-negative number');
  }

  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const collectionA = await collect(config);
  await new Promise((resolve) => setTimeout(resolve, gapSeconds * 1000));
  const collectionB = await collect(config);
  process.stdout.write(`${JSON.stringify(jsonMap(volatilePaths(collectionA, collectionB)), null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
