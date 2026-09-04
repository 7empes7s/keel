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
