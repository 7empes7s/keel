/**
 * Loads a plain-format SQL dump into a database whose schema is already in
 * place (roadmap task-68, step 5 of tools/recovery/reconstruct.mjs).
 *
 * Real KEEL backups are `pg_dump` plain output, which a single node-postgres
 * query cannot run: table data arrives as `COPY … FROM stdin;` blocks ended by
 * `\.`, and pg_dump 16.10+ brackets the file with the psql meta-commands
 * `\restrict <key>` / `\unrestrict <key>`. Its DDL would also collide with the
 * pinned schema the reconstruction has just applied.
 *
 * So the dump contributes DATA only, against the pinned schema:
 * - `COPY … FROM stdin` rows are decoded from COPY text format and inserted
 *   with bound parameters (each value goes through its column type's input
 *   function, as COPY would);
 * - `INSERT INTO …` statements run as written;
 * - `SELECT [pg_catalog.]setval('<sequence>', <n>, true|false)` statements run
 *   last, so sequences resume after the restored rows;
 * - UPDATE, DELETE, TRUNCATE, MERGE, COPY other than FROM stdin, DO and CALL
 *   are refused: a plain dump never carries them;
 * - every other statement (CREATE, ALTER, SET, COMMENT, …) is not executed:
 *   the structure is the pinned schema's, never the dump's;
 * - `\restrict` / `\unrestrict` are skipped; any other meta-command is refused.
 *
 * The dump is read as a stream of lines, never as one string, so its size is
 * not bounded by the JavaScript string limit (a live dump passed 3.6 GB,
 * issue #634). It is read twice: once to refuse anything it must not carry
 * before the target is touched, then once to load it. Foreign keys are set
 * aside during the load and added back at the end, which checks every row,
 * so tables and self-referencing rows load in whatever order the dump wrote
 * them. Names qualified with `public.` (pg_dump's default) resolve through
 * the target's search_path instead, so a disposable target need not be the
 * public schema.
 */

import { StringDecoder } from 'node:string_decoder';

export class DumpImportError extends Error {}

const ALLOWED_META = new Set(['restrict', 'unrestrict']);
// Keep each INSERT under PostgreSQL's 65535 bind-parameter limit.
const MAX_PARAMS = 60000;
const MAX_ROWS_PER_INSERT = 1000;

/**
 * Incremental dump parser. Lines go in one at a time (without their '\n'),
 * so a dump of any size is read without ever holding it as one string.
 * Each push returns the events it completed:
 * - { kind: 'meta', name, line }
 * - { kind: 'sql', text }
 * - { kind: 'copy-start', table, columns } / { kind: 'copy-row', line } / { kind: 'copy-end' }
 */
export class DumpParser {
  #buf = '';
  #i = 0;
  #start = -1; // start of the statement being read; -1 between statements
  #quote = null; // "'", '"', 'E' (escape string) or a dollar tag
  #copy = null; // table of the COPY block being read

  push(line) {
    const events = [];
    if (this.#copy !== null) {
      const row = line.endsWith('\r') ? line.slice(0, -1) : line;
      if (row === '\\.') { this.#copy = null; events.push({ kind: 'copy-end' }); } else events.push({ kind: 'copy-row', line: row });
      return events;
    }
    this.#buf += `${line}\n`;
    this.#scan(events, false);
    return events;
  }

  end() {
    if (this.#copy !== null) throw new DumpImportError(`COPY data for ${this.#copy} has no terminating \\.`);
    const events = [];
    this.#scan(events, true);
    return events;
  }

  #lineEnd(pos) {
    const end = this.#buf.indexOf('\n', pos);
    return end === -1 ? this.#buf.length : end;
  }

  #compact() {
    const keep = this.#start === -1 ? this.#i : this.#start;
    if (keep > 0) {
      this.#buf = this.#buf.slice(keep);
      this.#i -= keep;
      if (this.#start !== -1) this.#start = 0;
    }
  }

  #scan(events, final) {
    const text = () => this.#buf;
    for (;;) {
      let t = text();
      let n = t.length;
      if (this.#start === -1) {
        while (this.#i < n) {
          const i = this.#i;
          const ch = t[i];
          if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') { this.#i += 1; continue; }
          if (t.startsWith('--', i)) { this.#i = this.#lineEnd(i); continue; }
          if (t.startsWith('/*', i)) {
            const end = t.indexOf('*/', i + 2);
            if (end === -1) {
              if (final) throw new DumpImportError('unterminated comment in dump');
              this.#compact();
              return;
            }
            this.#i = end + 2;
            continue;
          }
          if (ch === '\\') {
            const end = this.#lineEnd(i);
            const line = t.slice(i + 1, end).trim();
            events.push({ kind: 'meta', name: line.split(/\s+/, 1)[0], line });
            this.#i = end;
            continue;
          }
          this.#start = i;
          this.#quote = null;
          break;
        }
        if (this.#start === -1) { this.#compact(); return; }
      }

      // Inside a statement: find its ';' outside quotes and comments.
      let i = this.#i;
      const start = this.#start;
      let quote = this.#quote;
      let complete = false;
      while (i < n) {
        const c = t[i];
        if (quote === "'" || quote === 'E') {
          if (quote === 'E' && c === '\\') { i += 2; continue; }
          if (c === "'") {
            if (t[i + 1] === "'") { i += 2; continue; }
            quote = null;
          }
          i += 1;
          continue;
        }
        if (quote === '"') {
          if (c === '"') {
            if (t[i + 1] === '"') { i += 2; continue; }
            quote = null;
          }
          i += 1;
          continue;
        }
        if (quote !== null) {
          if (t.startsWith(quote, i)) { i += quote.length; quote = null; } else { i += 1; }
          continue;
        }
        if (c === "'") {
          quote = (i > start && /[eE]/.test(t[i - 1]) && !/[\w$]/.test(t[i - 2] ?? '')) ? 'E' : "'";
          i += 1;
          continue;
        }
        if (c === '"') { quote = '"'; i += 1; continue; }
        if (c === '$') {
          const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(t.slice(i, i + 64));
          if (tag) { quote = tag[0]; i += tag[0].length; continue; }
        }
        if (t.startsWith('--', i)) { i = this.#lineEnd(i); continue; }
        if (t.startsWith('/*', i)) {
          const end = t.indexOf('*/', i + 2);
          if (end === -1) {
            if (final) throw new DumpImportError('unterminated comment in dump');
            break; // wait for the rest of the comment
          }
          i = end + 2;
          continue;
        }
        if (c === ';') { complete = true; break; }
        // psql would run an unquoted backslash command even mid-statement.
        if (c === '\\') throw new DumpImportError('dump contains a psql meta-command inside a statement');
        i += 1;
      }
      if (!complete && !final) {
        // Resume from here when the next line arrives.
        this.#i = Math.min(i, n);
        this.#quote = quote;
        this.#compact();
        return;
      }
      if (!complete && quote !== null) throw new DumpImportError('unterminated quoted text in dump');
      const statement = t.slice(start, i).trim();
      i += 1; // past ';' (or end of text)
      this.#start = -1;
      this.#quote = null;

      const copy = /^COPY\s+(.+?)\s*(\(.*\))?\s+FROM\s+stdin$/is.exec(statement);
      if (copy) {
        if (!complete) throw new DumpImportError(`COPY data for ${copy[1]} has no terminating \\.`);
        // Data starts on the next line; the rest of this one is ignored.
        this.#buf = t.slice(Math.min(this.#lineEnd(i) + 1, n));
        this.#i = 0;
        this.#copy = copy[1];
        events.push({ kind: 'copy-start', table: copy[1], columns: copy[2] ?? null });
        // Lines already buffered after the COPY line are its rows.
        const pending = this.#buf;
        this.#buf = '';
        if (pending) {
          const lines = pending.split('\n');
          lines.pop(); // the buffer always ends with '\n'
          for (const line of lines) events.push(...this.push(line));
        }
        return;
      }
      if (statement) events.push({ kind: 'sql', text: statement });
      this.#i = Math.min(i, n);
      t = text();
      n = t.length;
      if (this.#i >= n) { this.#buf = ''; this.#i = 0; return; }
    }
  }
}

/** Yields arrays of lines (without '\n') from string or Buffer chunks. */
async function* lineBatches(chunks) {
  let parts = [];
  // A Buffer chunk can end inside a multi-byte character; the decoder holds it over.
  const decoder = new StringDecoder('utf8');
  for await (const chunk of chunks) {
    const s = typeof chunk === 'string' ? chunk : decoder.write(chunk);
    let from = 0;
    let nl = s.indexOf('\n');
    if (nl === -1) { parts.push(s); continue; }
    const lines = [];
    lines.push(parts.length ? parts.join('') + s.slice(0, nl) : s.slice(0, nl));
    parts = [];
    from = nl + 1;
    while ((nl = s.indexOf('\n', from)) !== -1) { lines.push(s.slice(from, nl)); from = nl + 1; }
    if (from < s.length) parts.push(s.slice(from));
    yield lines;
  }
  const last = decoder.end();
  if (last) parts.push(last);
  if (parts.length) yield parts.join('').split('\n');
}

/** A dump source is its text, or a function that opens a fresh stream of its text each time. */
function openSource(source) {
  if (typeof source === 'string') return [source];
  if (typeof source === 'function') return source();
  throw new TypeError('a dump source is its text or a function that opens a stream of it');
}

/** Streams parser events for a whole dump source. */
async function* dumpEvents(source) {
  const parser = new DumpParser();
  for await (const lines of lineBatches(openSource(source))) {
    for (const line of lines) yield* parser.push(line);
  }
  yield* parser.end();
}

/** Splits plain-format dump text into statements, COPY blocks and meta-commands. */
export function parseDump(text) {
  const items = [];
  const parser = new DumpParser();
  const take = (events) => {
    for (const event of events) {
      if (event.kind === 'copy-start') items.push({ kind: 'copy', table: event.table, columns: event.columns, rows: [] });
      else if (event.kind === 'copy-row') items.at(-1).rows.push(event.line);
      else if (event.kind !== 'copy-end') items.push(event);
    }
  };
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  for (const line of lines) take(parser.push(line));
  take(parser.end());
  return items;
}

const ESCAPES = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' };

/** Decodes one COPY text-format field; `\N` is NULL. */
export function decodeCopyField(field) {
  if (field === '\\N') return null;
  if (!field.includes('\\')) return field;
  const bytes = [];
  const pushText = (s) => { for (const b of Buffer.from(s, 'utf8')) bytes.push(b); };
  for (let i = 0; i < field.length; i += 1) {
    const c = field[i];
    if (c !== '\\') {
      // Copy a run of plain characters at once.
      let j = i;
      while (j < field.length && field[j] !== '\\') j += 1;
      pushText(field.slice(i, j));
      i = j - 1;
      continue;
    }
    const next = field[i + 1];
    if (next === undefined) { bytes.push(0x5c); continue; }
    let m;
    if ((m = /^[0-7]{1,3}/.exec(field.slice(i + 1, i + 4)))) {
      bytes.push(parseInt(m[0], 8) & 0xff);
      i += m[0].length;
    } else if (next === 'x' && (m = /^[0-9A-Fa-f]{1,2}/.exec(field.slice(i + 2, i + 4)))) {
      bytes.push(parseInt(m[0], 16));
      i += 1 + m[0].length;
    } else {
      pushText(ESCAPES[next] ?? next);
      i += 1;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/** Splits a COPY column list `(a, "b,c")` into names, unquoted names folded to lower case. */
export function copyColumnNames(list) {
  const names = [];
  const re = /\s*(?:"((?:[^"]|"")*)"|([^\s,"]+))\s*(?:,|$)/gy;
  const inner = list.slice(1, -1);
  let m;
  while (re.lastIndex < inner.length && (m = re.exec(inner))) {
    names.push(m[1] !== undefined ? m[1].replaceAll('""', '"') : m[2].toLowerCase());
  }
  if (re.lastIndex < inner.length) throw new DumpImportError(`cannot read the COPY column list ${list}`);
  return names;
}

/** `public.foo` → `foo`; other names are left as written. */
function localName(name) {
  return name.trim().replace(/^(?:public|"public")\./, '');
}

/** Comparable table key: unquoted names fold to lower case, as PostgreSQL does. */
function tableKey(name) {
  const local = localName(name);
  const quoted = /^"((?:[^"]|"")*)"$/.exec(local);
  return quoted ? quoted[1].replaceAll('""', '"') : local.toLowerCase();
}

function classify(item) {
  if (item.kind === 'meta') {
    if (!ALLOWED_META.has(item.name)) {
      throw new DumpImportError(`dump contains the psql meta-command \\${item.name}; only \\restrict and \\unrestrict are accepted`);
    }
    return null;
  }
  if (item.kind === 'copy-start') {
    const names = item.columns ? copyColumnNames(item.columns) : null;
    return { kind: 'copy', key: tableKey(item.table), table: localName(item.table), columns: item.columns, names };
  }
  const insert = /^INSERT\s+INTO\s+((?:"(?:[^"]|"")*"|[\w$]+)(?:\.(?:"(?:[^"]|"")*"|[\w$]+))?)/i.exec(item.text);
  if (insert) {
    return { kind: 'insert', key: tableKey(insert[1]), text: `INSERT INTO ${localName(insert[1])}${item.text.slice(insert[0].length)}` };
  }
  if (/^SELECT\s+(?:pg_catalog\.)?setval\b/i.test(item.text)) {
    const setval = /^SELECT\s+(?:pg_catalog\.)?setval\s*\(\s*'(?:public\.)?((?:[^']|'')+)'\s*,\s*(\d+)\s*,\s*(true|false)\s*\)$/i.exec(item.text);
    if (!setval) throw new DumpImportError(`dump contains a setval this import does not accept: ${item.text.slice(0, 120)}`);
    return { kind: 'setval', text: `SELECT pg_catalog.setval('${setval[1]}', ${setval[2]}, ${setval[3].toLowerCase()})` };
  }
  const refused = /^(UPDATE|DELETE|TRUNCATE|MERGE|COPY|DO|CALL)\b/i.exec(item.text);
  if (refused) throw new DumpImportError(`dump contains a ${refused[1].toUpperCase()} statement; a plain dump only loads data`);
  return { kind: 'skipped' };
}

/**
 * Reads the whole dump once without touching any database: every refusal
 * (meta-commands, statements a plain dump never carries, bad COPY column
 * lists, unterminated text) surfaces here, before anything is written.
 * Returns the plan the import pass needs: tables, setvals and skipped count.
 */
export async function scanDump(source) {
  const tables = new Set();
  const setvals = [];
  let skipped = 0;
  for await (const event of dumpEvents(source)) {
    if (event.kind === 'copy-row' || event.kind === 'copy-end') continue;
    const item = classify(event);
    if (item === null) continue;
    if (item.kind === 'setval') setvals.push(item.text);
    else if (item.kind === 'skipped') skipped += 1;
    else tables.add(item.key);
  }
  return { tables: tables.size, setvals, skippedStatements: skipped };
}

/** Foreign keys of the target's tables, so they can be set aside during the load. */
async function foreignKeys(client) {
  const { rows } = await client.query(`
    SELECT c.conrelid::regclass::text AS table, quote_ident(c.conname) AS name, pg_get_constraintdef(c.oid) AS definition
      FROM pg_constraint c
      JOIN pg_class rel ON rel.oid = c.conrelid
     WHERE c.contype = 'f' AND c.conparentid = 0 -- a partition's copy goes with its parent's key
       AND rel.relnamespace = current_schema()::regnamespace
     ORDER BY c.conrelid, c.conname`);
  return rows;
}

/** Loads one COPY block's rows in bounded batches as they stream past. */
class CopyLoader {
  constructor(client, item) {
    this.client = client;
    this.item = item;
    this.width = item.names?.length ?? null;
    this.batch = [];
    this.rows = 0;
  }

  async add(line) {
    const row = line.split('\t').map(decodeCopyField);
    if (this.width === null) this.width = row.length;
    if (row.length !== this.width) {
      throw new DumpImportError(`COPY data for ${this.item.table} has rows that do not match its ${this.width} columns`);
    }
    this.batch.push(row);
    if (this.batch.length >= this.perInsert()) await this.flush();
  }

  perInsert() {
    return Math.max(1, Math.min(MAX_ROWS_PER_INSERT, Math.floor(MAX_PARAMS / this.width)));
  }

  async flush() {
    if (this.batch.length === 0) return;
    const { width } = this;
    const batch = this.batch;
    this.batch = [];
    const tuples = batch.map((_, r) => `(${Array.from({ length: width }, (__, c) => `$${r * width + c + 1}`).join(', ')})`);
    await this.client.query(
      // COPY writes GENERATED ALWAYS identity values as given; INSERT needs the override.
      `INSERT INTO ${this.item.table} ${this.item.columns ?? ''} OVERRIDING SYSTEM VALUE VALUES ${tuples.join(', ')}`,
      batch.flat(),
    );
    this.rows += batch.length;
  }
}

/**
 * Imports the dump's data into the connected database, whose schema must
 * already be applied. `source` is the dump text, or a function that opens a
 * fresh stream of it (string or Buffer chunks); a stream is read twice, once
 * to check it and once to load it, and is never held whole in memory.
 *
 * The load runs in one transaction. Foreign keys are set aside for the load
 * and added back at the end, which checks every row against them (as
 * pg_restore does), so a full dump loads in its own order whatever order it
 * wrote parents and children in. Returns counts of what was loaded and skipped.
 */
export async function importDump(client, source, plan) {
  const checked = plan ?? await scanDump(source);
  let rows = 0;
  await client.query('BEGIN');
  try {
    const keys = await foreignKeys(client);
    for (const fk of keys) await client.query(`ALTER TABLE ${fk.table} DROP CONSTRAINT ${fk.name}`);
    let copy = null;
    for await (const event of dumpEvents(source)) {
      if (event.kind === 'copy-row') { await copy.add(event.line); continue; }
      if (event.kind === 'copy-end') { await copy.flush(); rows += copy.rows; copy = null; continue; }
      const item = classify(event);
      if (item === null || item.kind === 'setval' || item.kind === 'skipped') continue;
      if (item.kind === 'copy') copy = new CopyLoader(client, item);
      else {
        const result = await client.query(item.text);
        rows += result.rowCount ?? 0;
      }
    }
    for (const fk of keys) await client.query(`ALTER TABLE ${fk.table} ADD CONSTRAINT ${fk.name} ${fk.definition}`);
    for (const text of checked.setvals) await client.query(text);
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* the original error matters */ }
    throw error;
  }
  return { tables: checked.tables, rows, sequences: checked.setvals.length, skippedStatements: checked.skippedStatements };
}
