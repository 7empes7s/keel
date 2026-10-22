-- Job page redesign: a running backup reports each type as it is read, so the Job page
-- can show progress, counts, timings and problems while the job runs. Written only by
-- the job's own child process; NULL for every other job and for jobs from before.
ALTER TABLE job ADD COLUMN IF NOT EXISTS progress jsonb;
