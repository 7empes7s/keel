/**
 * The full database schema: engine/store/schema.sql, then every
 * engine/store/schema.d/*.sql fragment in file-name order. This is the one
 * place the schema is assembled; tests, the recovery schema pin and anyone
 * applying the schema go through it, so a new fragment is picked up everywhere
 * without editing a list.
 *
 * Fragments are named NN-topic.sql (for example 30-retention.sql) and, like
 * schema.sql, must be additive and safe to re-apply (CREATE ... IF NOT EXISTS).
 * Each package owns its own fragment, so parallel changes do not collide in
 * one file.
 *
 * The bytes are schema.sql followed by "\n" and each fragment. With no
 * fragments they are exactly schema.sql, so existing schema pins still match.
 *
 *   node engine/store/loadSchema.mjs | psql "$KEEL_DB_URL"   # apply
 *   node engine/store/loadSchema.mjs | sha256sum              # schema pin
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolved on use, from schema.sql's own URL, so bundlers that import this module
// (the portal build) can still trace it.
const storeDirectory = () => dirname(fileURLToPath(new URL('./schema.sql', import.meta.url)));
const FRAGMENT = /^[^.].*\.sql$/;

/** Absolute paths of schema.sql and its fragments, in apply order. */
export function schemaFiles({ storeDir = storeDirectory(), readdirFn = readdirSync } = {}) {
  let fragments = [];
  try {
    fragments = readdirFn(join(storeDir, 'schema.d')).filter((name) => FRAGMENT.test(name)).sort();
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return [join(storeDir, 'schema.sql'), ...fragments.map((name) => join(storeDir, 'schema.d', name))];
}

/** The full schema as bytes (what the schema pin hashes). */
export function schemaBytes({ storeDir = storeDirectory(), readFileFn = readFileSync, readdirFn = readdirSync } = {}) {
  const parts = [];
  for (const [index, path] of schemaFiles({ storeDir, readdirFn }).entries()) {
    if (index > 0) parts.push(Buffer.from('\n'));
    parts.push(Buffer.from(readFileFn(path)));
  }
  return Buffer.concat(parts);
}

/** The full schema as SQL text, ready for client.query(). */
export function schemaSql(options) {
  return schemaBytes(options).toString('utf8');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.stdout.write(schemaBytes());
}
