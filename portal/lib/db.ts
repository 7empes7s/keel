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

/** Said to the person whenever a full pool turns a request away. */
export const BUSY_MESSAGE = "Keel is busy, try again in a moment.";
/** The retry-after a busy answer carries. */
export const BUSY_RETRY_SECONDS = 5;

/** Whether an error is a full pool (checked by name too, across module copies). */
export function isDatabaseBusy(error: unknown): boolean {
  return error instanceof DatabaseBusyError || (error as Error | null)?.name === "DatabaseBusyError";
}

/** Said to the person when the database can't be reached at all. */
export const UNREACHABLE_MESSAGE = "Keel can't reach its database right now.";
/** The retry-after an unreachable-database answer carries. */
export const UNREACHABLE_RETRY_SECONDS = 60;

// Socket errors from connecting (node's `code`), and Postgres refusing the connection:
// SQLSTATE class 08 (connection exception), 28 (wrong user or password) and the
// shutdown / starting-up codes 57P01-57P03.
const UNREACHABLE_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "EPIPE"]);
const UNREACHABLE_SQLSTATE = /^(08|28)[0-9A-Z]{3}$|^57P0[123]$/;
// pg's own messages when a connection drops or never finishes opening.
const UNREACHABLE_MESSAGES = /^Connection terminated( unexpectedly| due to connection timeout)?$/;

/**
 * The short name of why the database can't be reached (an error code, or "connection
 * terminated"), or null when the error is something else. Live 2026-11-04 (#1005): the
 * port forward in front of Postgres died, every sign-in got `connect ECONNREFUSED`, and
 * the portal said "forbidden" instead of saying the database was down.
 */
export function databaseUnreachableReason(error: unknown): string | null {
  const seen = new Set<unknown>();
  const visit = (value: unknown): string | null => {
    if (!value || typeof value !== "object" || seen.has(value)) return null;
    seen.add(value);
    const { code, message, errors, cause } = value as { code?: unknown; message?: unknown; errors?: unknown; cause?: unknown };
    if (typeof code === "string" && (UNREACHABLE_CODES.has(code) || UNREACHABLE_SQLSTATE.test(code))) return code;
    if (typeof message === "string" && UNREACHABLE_MESSAGES.test(message)) return "connection terminated";
    // Node reports a refused connection to every address of a host as one AggregateError.
    for (const inner of Array.isArray(errors) ? errors : []) {
      const reason = visit(inner);
      if (reason) return reason;
    }
    return visit(cause);
  };
  return visit(error);
}

// When each pooled connection was handed out, so a full pool can say how long the
// holders have had theirs: many short holds mean too many requests at once, one very
// old hold means a caller that never gave its connection back.
const leases: Set<{ at: number }> = ((globalThis as { __keelPortalLeases?: Set<{ at: number }> }).__keelPortalLeases ??= new Set());

/** How many pooled connections are handed out, and the oldest one's age in ms. */
export function leaseSummary(now = Date.now()): { held: number; oldestMs: number | null } {
  let oldest: number | null = null;
  for (const { at } of leases) oldest = oldest === null ? at : Math.min(oldest, at);
  return { held: leases.size, oldestMs: oldest === null ? null : now - oldest };
}

// Kept on globalThis so a development reload reuses the pools instead of leaking them.
const registry: PoolRegistry = ((globalThis as { __keelPortalPools?: PoolRegistry }).__keelPortalPools ??= new Map());

/** A new connection's setup query, until it has answered. */
const settingUp = new WeakMap<pg.PoolClient, Promise<void>>();

function poolFor(url: string): pg.Pool {
  let pool = registry.get(url);
  if (!pool) {
    pool = new pg.Pool({
      connectionString: url,
      // Names the portal's connections in pg_stat_activity.
      application_name: "keel-portal",
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
    // No JIT compilation: the portal's reads are short, but a read the planner
    // over-estimates (a correlated subquery, an unnest of unknown length) crossed
    // jit_above_cost and spent most of a second compiling before it ran. Set per new
    // connection, ahead of its first query, whatever options the database URL carries.
    // The caller waits for it (connect below), so it never overlaps the first query.
    pool.on("connect", (client) => {
      settingUp.set(client, client.query("SET jit = off").then(
        () => undefined,
        (error: unknown) => console.error("[keel-portal] could not turn off JIT on a new connection", error),
      ));
    });
    registry.set(url, pool);
  }
  return pool;
}

/** A statement slower than this is logged, so slow pages can be traced on live. */
export const SLOW_QUERY_MS = 1_000;

/** The first words of a statement, one line, never its parameter values. */
export function queryLabel(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 120);
}

function logIfSlow(text: string, ms: number): void {
  if (ms >= SLOW_QUERY_MS) console.warn(`[keel-portal] slow query ${ms} ms: ${queryLabel(text)}`);
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
      const { held, oldestMs } = leaseSummary();
      console.error(`[keel-portal] database pool full: gave up waiting for a connection (${held} held, oldest ${oldestMs ?? 0} ms, ${pool.waitingCount} waiting)`);
      throw new DatabaseBusyError(error);
    }
    throw error;
  }
  const setup = settingUp.get(leased);
  if (setup) {
    settingUp.delete(leased);
    await setup;
  }
  const lease = { at: Date.now() };
  leases.add(lease);
  let released = false;
  let discard = false;
  let inTransaction = false;
  return {
    async query(...args: unknown[]) {
      const text = typeof args[0] === "string" ? args[0] : (args[0] as { text?: string } | undefined)?.text ?? "";
      const startedAt = Date.now();
      try {
        const result = await (leased.query as (...q: unknown[]) => Promise<unknown>)(...args);
        logIfSlow(text, Date.now() - startedAt);
        if (TRANSACTION_START.test(text)) inTransaction = true;
        else if (TRANSACTION_END.test(text)) inTransaction = false;
        return result;
      } catch (error) {
        discard = true;
        throw error;
      }
    },
    async end() {
      if (released) return;
      released = true;
      leases.delete(lease);
      leased.release(discard || inTransaction);
    },
  };
}
