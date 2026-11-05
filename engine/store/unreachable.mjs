// Why a database error means "can't reach the database", shared by the portal's sign-in
// check (portal/lib/db.ts), keel-scheduler and the database watchdog (#1005, #1010).

// Socket errors from connecting (node's `code`), and Postgres refusing the connection:
// SQLSTATE class 08 (connection exception), 28 (wrong user or password) and the
// shutdown / starting-up codes 57P01-57P03.
const UNREACHABLE_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE']);
const UNREACHABLE_SQLSTATE = /^(08|28)[0-9A-Z]{3}$|^57P0[123]$/;
// pg's own messages when a connection drops or never finishes opening.
const UNREACHABLE_MESSAGES = /^Connection terminated( unexpectedly| due to connection timeout)?$/;

/**
 * The short name of why the database can't be reached (an error code, or "connection
 * terminated"), or null when the error is something else. Live 2026-11-04 (#1005): the
 * port forward in front of Postgres died, every sign-in got `connect ECONNREFUSED`, and
 * the portal said "forbidden" instead of saying the database was down.
 * @param {unknown} error
 * @returns {string | null}
 */
export function databaseUnreachableReason(error) {
  const seen = new Set();
  const visit = (value) => {
    if (!value || typeof value !== 'object' || seen.has(value)) return null;
    seen.add(value);
    const { code, message, errors, cause } = value;
    if (typeof code === 'string' && (UNREACHABLE_CODES.has(code) || UNREACHABLE_SQLSTATE.test(code))) return code;
    if (typeof message === 'string' && UNREACHABLE_MESSAGES.test(message)) return 'connection terminated';
    // Node reports a refused connection to every address of a host as one AggregateError.
    for (const inner of Array.isArray(errors) ? errors : []) {
      const reason = visit(inner);
      if (reason) return reason;
    }
    return visit(cause);
  };
  return visit(error);
}
