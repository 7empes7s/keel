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
 * - `SELECT [pg_catalog.]setval(…)` statements run last, so sequences resume
 *   after the restored rows;
 * - every other statement (CREATE, ALTER, SET, COMMENT, …) is not executed:
 *   the structure is the pinned schema's, never the dump's;
 * - `\restrict` / `\unrestrict` are skipped; any other meta-command is refused.
 *
 * Tables load parents first, in the target's foreign-key order, since a full
 * dump orders data without regard to constraints it adds afterwards. Names
 * qualified with `public.` (pg_dump's default) resolve through the target's
 * search_path instead, so a disposable target need not be the public schema.
 */

export class DumpImportError extends Error {}

const ALLOWED_META = new Set(['restrict', 'unrestrict']);
// Keep each INSERT under PostgreSQL's 65535 bind-parameter limit.
const MAX_PARAMS = 60000;
const MAX_ROWS_PER_INSERT = 1000;

/** Splits plain-format dump text into statements, COPY blocks and meta-commands. */
export function parseDump(text) {
  const items = [];
  let i = 0;
  const n = text.length;
  const atLineStart = (pos) => pos === 0 || text[pos - 1] === '\n';
  const lineEnd = (pos) => {
    const end = text.indexOf('\n', pos);
    return end === -1 ? n : end;
  };

  while (i < n) {
    const ch = text[i];
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') { i += 1; continue; }
    if (text.startsWith('--', i)) { i = lineEnd(i); continue; }
    if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) throw new DumpImportError('unterminated comment in dump');
      i = end + 2;
      continue;
    }
    if (ch === '\\' && atLineStart(i)) {
      const end = lineEnd(i);
      const line = text.slice(i + 1, end).trim();
      items.push({ kind: 'meta', name: line.split(/\s+/, 1)[0], line });
      i = end;
      continue;
    }

    const start = i;
    let quote = null; // "'", '"', 'E' (escape string) or a dollar tag
    while (i < n) {
      const c = text[i];
      if (quote === "'" || quote === 'E') {
        if (quote === 'E' && c === '\\') { i += 2; continue; }
        if (c === "'") {
          if (text[i + 1] === "'") { i += 2; continue; }
          quote = null;
        }
        i += 1;
        continue;
      }
      if (quote === '"') {
        if (c === '"') {
          if (text[i + 1] === '"') { i += 2; continue; }
          quote = null;
        }
        i += 1;
        continue;
      }
      if (quote !== null) {
        if (text.startsWith(quote, i)) { i += quote.length; quote = null; } else { i += 1; }
        continue;
      }
      if (c === "'") {
        quote = (i > start && /[eE]/.test(text[i - 1]) && !/[\w$]/.test(text[i - 2] ?? '')) ? 'E' : "'";
        i += 1;
        continue;
      }
      if (c === '"') { quote = '"'; i += 1; continue; }
      if (c === '$') {
        const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i, i + 64));
        if (tag) { quote = tag[0]; i += tag[0].length; continue; }
      }
      if (text.startsWith('--', i)) { i = lineEnd(i); continue; }
      if (text.startsWith('/*', i)) {
        const end = text.indexOf('*/', i + 2);
        if (end === -1) throw new DumpImportError('unterminated comment in dump');
        i = end + 2;
        continue;
      }
      if (c === ';') break;
      i += 1;
    }
    if (quote !== null) throw new DumpImportError('unterminated quoted text in dump');
    const statement = text.slice(start, i).trim();
    i += 1; // past ';' (or end of text)

    const copy = /^COPY\s+(.+?)\s*(\(.*\))?\s+FROM\s+stdin$/is.exec(statement);
    if (copy) {
      i = lineEnd(i) + 1; // data starts on the next line
      const rows = [];
      for (;;) {
        if (i > n) throw new DumpImportError(`COPY data for ${copy[1]} has no terminating \\.`);
        const end = lineEnd(i);
        const line = text.slice(i, end).replace(/\r$/, '');
        i = end + 1;
        if (line === '\\.') break;
        rows.push(line);
      }
      items.push({ kind: 'copy', table: copy[1], columns: copy[2] ?? null, rows });
      continue;
    }
    if (statement) items.push({ kind: 'sql', text: statement });
  }
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
  if (item.kind === 'copy') {
    const width = item.columns ? item.columns.slice(1, -1).split(',').length : null;
    return { kind: 'copy', key: tableKey(item.table), table: localName(item.table), columns: item.columns, width, rows: item.rows };
  }
  const insert = /^INSERT\s+INTO\s+((?:"(?:[^"]|"")*"|[\w$]+)(?:\.(?:"(?:[^"]|"")*"|[\w$]+))?)/i.exec(item.text);
  if (insert) {
    return { kind: 'insert', key: tableKey(insert[1]), text: `INSERT INTO ${localName(insert[1])}${item.text.slice(insert[0].length)}` };
  }
  if (/^SELECT\s+(?:pg_catalog\.)?setval\s*\(/i.test(item.text)) {
    return { kind: 'setval', text: item.text.replace(/setval\s*\(\s*'public\./i, "setval('") };
  }
  return { kind: 'skipped' };
}

/** Orders table keys parents-first by the target's foreign keys, else dump order. */
async function loadOrder(client, keys) {
  const { rows } = await client.query(`
    SELECT child.relname AS child, parent.relname AS parent
      FROM pg_constraint c
      JOIN pg_class child  ON child.oid  = c.conrelid
      JOIN pg_class parent ON parent.oid = c.confrelid
     WHERE c.contype = 'f' AND child.relnamespace = current_schema()::regnamespace`);
  const present = new Set(keys);
  const parents = new Map(keys.map((key) => [key, new Set()]));
  for (const { child, parent } of rows) {
    if (child !== parent && present.has(child) && present.has(parent)) parents.get(child).add(parent);
  }
  const ordered = [];
  const done = new Set();
  while (ordered.length < keys.length) {
    const ready = keys.find((key) => !done.has(key) && [...parents.get(key)].every((p) => done.has(p)));
    // A foreign-key cycle falls back to dump order for what is left.
    const next = ready ?? keys.find((key) => !done.has(key));
    done.add(next);
    ordered.push(next);
  }
  return ordered;
}

async function insertCopyRows(client, item) {
  if (item.rows.length === 0) return;
  const split = item.rows.map((line) => line.split('\t').map(decodeCopyField));
  const width = item.width ?? split[0].length;
  if (split.some((row) => row.length !== width)) {
    throw new DumpImportError(`COPY data for ${item.table} has rows that do not match its ${width} columns`);
  }
  const perInsert = Math.max(1, Math.min(MAX_ROWS_PER_INSERT, Math.floor(MAX_PARAMS / width)));
  for (let at = 0; at < split.length; at += perInsert) {
    const batch = split.slice(at, at + perInsert);
    const tuples = batch.map((_, r) => `(${Array.from({ length: width }, (__, c) => `$${r * width + c + 1}`).join(', ')})`);
    await client.query(
      `INSERT INTO ${item.table} ${item.columns ?? ''} VALUES ${tuples.join(', ')}`,
      batch.flat(),
    );
  }
}

/**
 * Imports the dump's data into the connected database, whose schema must
 * already be applied. Returns counts of what was loaded and skipped.
 */
export async function importDump(client, text) {
  const classified = parseDump(text).map(classify).filter(Boolean);
  const byTable = new Map();
  const setvals = [];
  let skipped = 0;
  for (const item of classified) {
    if (item.kind === 'setval') setvals.push(item);
    else if (item.kind === 'skipped') skipped += 1;
    else {
      if (!byTable.has(item.key)) byTable.set(item.key, []);
      byTable.get(item.key).push(item);
    }
  }
  let rows = 0;
  for (const key of await loadOrder(client, [...byTable.keys()])) {
    for (const item of byTable.get(key)) {
      if (item.kind === 'copy') {
        await insertCopyRows(client, item);
        rows += item.rows.length;
      } else {
        const result = await client.query(item.text);
        rows += result.rowCount ?? 0;
      }
    }
  }
  for (const item of setvals) await client.query(item.text);
  return { tables: byTable.size, rows, sequences: setvals.length, skippedStatements: skipped };
}
