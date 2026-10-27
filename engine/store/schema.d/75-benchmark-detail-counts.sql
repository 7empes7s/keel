-- How many settings a compliance result checked and how many failed, before the detail
-- lines were cut to MAX_DETAILS ({ checked, failing }, engine/benchmarks/evaluate.mjs).
-- Null for results stored before the counts existed; their lines are then the only count.
ALTER TABLE benchmark_evaluation ADD COLUMN IF NOT EXISTS detail_counts jsonb;
