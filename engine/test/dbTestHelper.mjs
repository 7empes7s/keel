import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';

function quoteIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

export function requireTestDatabaseUrl(url = process.env.KEEL_DB_TEST_URL) {
  const testUrl = process.env.KEEL_DB_TEST_URL;
  if (!testUrl) throw new Error('KEEL_DB_TEST_URL not set — source /etc/keel/db.env first');
  if (!url || url !== testUrl || url === process.env.KEEL_DB_URL) {
    throw new Error('database tests must use KEEL_DB_TEST_URL only');
  }
  return testUrl;
}

function urlForSchema(url, schema) {
  const scoped = new URL(url);
  const options = scoped.searchParams.get('options');
  const searchPath = `-c search_path=${quoteIdentifier(schema)}`;
  scoped.searchParams.set('options', options ? `${options} ${searchPath}` : searchPath);
  return scoped.toString();
}

function urlForRole(url, { user, password }) {
  const roleUrl = new URL(url);
  roleUrl.username = user;
  roleUrl.password = password;
  return roleUrl.toString();
}

export async function createIsolatedTestDatabase(testFile) {
  const url = requireTestDatabaseUrl();
  const suffix = createHash('sha256')
    .update(`${testFile}:${process.pid}:${randomUUID()}`)
    .digest('hex')
    .slice(0, 32);
  const schema = `keel_test_${suffix}`;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);

  const scopedUrl = urlForSchema(url, schema);
  return {
    schema,
    url: scopedUrl,
    urlForRole({ user, password }) {
      return urlForRole(scopedUrl, { user, password });
    },
    async connect(options = {}) {
      const client = new pg.Client({ connectionString: scopedUrl, ...options });
      await client.connect();
      return client;
    },
    async cleanup() {
      try {
        await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
      } finally {
        await admin.end();
      }
    },
  };
}

export { quoteIdentifier };
