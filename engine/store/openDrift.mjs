/** SQL predicate for an open drift. Consumers must alias the drift table as `d`. */
export const OPEN_DRIFT_PREDICATE = `
  (
    NOT EXISTS (
      SELECT 1 FROM disposition p WHERE p.drift_id = d.id
    )
    OR (
      EXISTS (
        SELECT 1 FROM disposition p
        WHERE p.drift_id = d.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM disposition p
        WHERE p.drift_id = d.id
          AND (p.action <> 'ignore' OR p.expires_at IS NULL OR p.expires_at > now())
      )
    )
  )
`;

/**
 * SQL predicate: something has already acted on this drift row (alias `d`): a decision
 * (any disposition, even an expired ignore) or an auto remediation that has finished,
 * including one whose job ended without recording its outcome (a cancelled job).
 * Drift detection never reuses such a row for a change it sees again.
 */
export const DRIFT_ACTED_ON_PREDICATE = `
  (
    EXISTS (SELECT 1 FROM disposition p WHERE p.drift_id = d.id)
    OR EXISTS (
      SELECT 1 FROM auto_remediation_execution e
        JOIN job j ON j.id = e.job_id
       WHERE e.drift_id = d.id
         AND (e.status IN ('executed', 'failed') OR j.status IN ('succeeded', 'failed', 'cancelled'))
    )
  )
`;
