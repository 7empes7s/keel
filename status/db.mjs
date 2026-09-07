// status/db.mjs
import pg from 'pg';

/** Read-only connection for the keel_status role. A 5s statement_timeout bounds how long any
 * single query can hold the connection — this runs unattended every 60s and must never pile up. */
export async function connect(url) {
  const client = new pg.Client({ connectionString: url, statement_timeout: 5000 });
  await client.connect();
  return client;
}
