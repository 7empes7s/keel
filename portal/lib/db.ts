import pg from "pg";

// One connection pool per database URL, shared by every request the portal serves.
// Before this, each page, API call and middleware run opened its own Postgres
// connection and closed it again (about eleven per page load), which was most of the
// portal's server time. Callers keep the engine's client shape: query() and end().
// end() returns the connection to the pool; a connection that saw a failed query or
// was left inside a transaction is discarded instead, so the next caller never
// inherits broken state.

export interface DbClient {
  query(...args: unknown[]): Promise<unknown>;
  end(): Promise<void>;
}

type PoolRegistry = Map<string, pg.Pool>;

/** Connections each pool may open. */
export const POOL_MAX = 8;

/** How long a caller waits for a free pooled connection before giving up. */
export const POOL_WAIT_MS = 5_000;

/**
 * Thrown when every pooled connection stays busy for POOL_WAIT_MS. Pages already catch
 * read failures and show "could not be read" with a retry, so a full pool now ends in
 * that message instead of a page that never finishes loading.
 */
export class DatabaseBusyError extends Error {
  constructor(cause: unknown) {
    super(`Keel's database had no free connection within ${POOL_WAIT_MS / 1000} seconds`, { cause });
    this.name = "DatabaseBusyError";
  }
}

// Kept on globalThis so a development reload reuses the pools instead of leaking them.
const registry: PoolRegistry = ((globalThis as { __keelPortalPools?: PoolRegistry }).__keelPortalPools ??= new Map());

function poolFor(url: string): pg.Pool {
  let pool = registry.get(url);
  if (!pool) {
    pool = new pg.Pool({
      connectionString: url,
      max: POOL_MAX,
      idleTimeoutMillis: 30_000,
      // Without this, a caller waits forever when all connections are in use.
      connectionTimeoutMillis: POOL_WAIT_MS,
      // Idle pooled connections never keep a one-shot process (a test file) alive.
      allowExitOnIdle: true,
    });
    // An idle connection dropped by the server is removed from the pool; it must not
    // take the process down.
    pool.on("error", (error) => console.error("[keel-portal] idle database connection failed", error));
    registry.set(url, pool);
  }
  return pool;
}

const TRANSACTION_START = /^\s*(begin|start\s+transaction)\b/i;
const TRANSACTION_END = /^\s*(commit|rollback|end)\b/i;

/** A pooled connection with the engine client's shape: `query()` and `end()`. */
export async function connect(url: string): Promise<DbClient> {
  const pool = poolFor(url);
  let leased: pg.PoolClient;
  try {
    leased = await pool.connect();
  } catch (error) {
    // pg-pool's message when no connection came free in time. A slow new connection
    // fails with its own error and is passed on as it is.
    if (/timeout exceeded when trying to connect/i.test(String((error as Error)?.message))) {
      console.error("[keel-portal] database pool full: gave up waiting for a connection");
      throw new DatabaseBusyError(error);
    }
    throw error;
  }
  let discard = false;
  let inTransaction = false;
  return {
    async query(...args: unknown[]) {
      const text = typeof args[0] === "string" ? args[0] : (args[0] as { text?: string } | undefined)?.text ?? "";
      try {
        const result = await (leased.query as (...q: unknown[]) => Promise<unknown>)(...args);
        if (TRANSACTION_START.test(text)) inTransaction = true;
        else if (TRANSACTION_END.test(text)) inTransaction = false;
        return result;
      } catch (error) {
        discard = true;
        throw error;
      }
    },
    async end() {
      leased.release(discard || inTransaction);
    },
  };
}
