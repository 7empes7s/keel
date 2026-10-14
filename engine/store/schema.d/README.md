# Schema fragments

`engine/store/loadSchema.mjs` applies `../schema.sql` first, then every `*.sql` file
here in file-name order. Use a fragment for new tables so parallel changes don't
collide in `schema.sql`.

- Name it `NN-topic.sql` (for example `30-retention.sql`). One owner per fragment.
- Keep it additive and safe to re-apply: `CREATE TABLE IF NOT EXISTS`,
  `ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`.
- A fragment may reference tables in `schema.sql` and in lower-numbered fragments.
- Fragments are part of the recovery schema pin, so changing one changes the pin.
- Apply the whole schema with `node engine/store/loadSchema.mjs | psql "$KEEL_DB_URL"`.
