-- The approved setup's match percentage over time (engine/govern/baselineScore.mjs).
--
-- One row per finished run: drift detection after a backup ('backup', source_id the
-- snapshot) or a run of service reads ('service-read'). matching and judged are the
-- whole tenant's settings that match the approved setup and the settings judged;
-- services holds the same pair per service code ({"Entra": {"matching": 9, "judged": 10}}).
-- The percentage is worked out on reading (rounded down), never stored.
-- baseline_id names the approved setup in use at the time; no foreign key, so a point
-- outlives a setup that is later removed.
CREATE TABLE IF NOT EXISTS baseline_score_point (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_ref  text NOT NULL,
  baseline_id uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  trigger     text NOT NULL CHECK (trigger IN ('backup', 'service-read')),
  source_id   text,
  matching    integer NOT NULL CHECK (matching >= 0),
  judged      integer NOT NULL CHECK (judged >= matching),
  services    jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS baseline_score_point_recent_idx ON baseline_score_point (tenant_ref, recorded_at DESC);
