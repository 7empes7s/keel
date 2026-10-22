-- Which object and setting made a compliance control fail ({ subject, setting, value,
-- expected } lines, engine/benchmarks/evaluate.mjs). Null for results without them.
ALTER TABLE benchmark_evaluation ADD COLUMN IF NOT EXISTS details jsonb;
