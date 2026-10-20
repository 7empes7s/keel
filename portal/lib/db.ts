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

// Kept on globalThis so a development reload reuses the pools instead of leaking them.
const registry: PoolRegistry = ((globalThis as { __keelPortalPools?: PoolRegistry }).__keelPortalPools ??= new Map());

function poolFor(url: string): pg.Pool {
  let pool = registry.get(url);
  if (!pool) {
    pool = new pg.Pool({
      connectionString: url,
      max: 8,
      idleTimeoutMillis: 30_000,
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
  const leased = await poolFor(url).connect();
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
