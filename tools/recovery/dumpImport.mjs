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
 * Tables load parents first, in the target's foreign-key order, since a full
 * dump orders data without regard to constraints it adds afterwards. Within a
 * table that references itself, rows load parents first too, so a child that
 * pg_dump wrote before its parent never lands in an earlier statement. Names
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
    if (ch === '\\') {
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
      // psql would run an unquoted backslash command even mid-statement.
      if (c === '\\') throw new DumpImportError('dump contains a psql meta-command inside a statement');
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
  if (item.kind === 'copy') {
    const names = item.columns ? copyColumnNames(item.columns) : null;
    return { kind: 'copy', key: tableKey(item.table), table: localName(item.table), columns: item.columns, names, rows: item.rows };
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

/** Single-column foreign keys from a table to itself: table → { column, references }. */
async function selfReferences(client) {
  const { rows } = await client.query(`
    SELECT rel.relname AS table, a.attname AS column, ra.attname AS references
      FROM pg_constraint c
      JOIN pg_class rel     ON rel.oid = c.conrelid
      JOIN pg_attribute a   ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
      JOIN pg_attribute ra  ON ra.attrelid = c.confrelid AND ra.attnum = c.confkey[1]
     WHERE c.contype = 'f' AND c.conrelid = c.confrelid AND cardinality(c.conkey) = 1
       AND rel.relnamespace = current_schema()::regnamespace`);
  return new Map(rows.map((row) => [row.table, row]));
}

/** Orders rows so each row's parent (same table) comes before it. */
function parentsFirst(rows, fkIndex, keyIndex) {
  const keys = new Set(rows.map((row) => row[keyIndex]));
  const children = new Map();
  const ordered = [];
  for (const row of rows) {
    const parent = row[fkIndex];
    if (parent === null || parent === row[keyIndex] || !keys.has(parent)) ordered.push(row);
    else {
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(row);
    }
  }
  for (let i = 0; i < ordered.length; i += 1) ordered.push(...(children.get(ordered[i][keyIndex]) ?? []));
  // Rows in a cycle are never reached; they go last so the foreign key check names them.
  if (ordered.length < rows.length) {
    const placed = new Set(ordered);
    ordered.push(...rows.filter((row) => !placed.has(row)));
  }
  return ordered;
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

async function insertCopyRows(client, item, selfReference) {
  if (item.rows.length === 0) return;
  let split = item.rows.map((line) => line.split('\t').map(decodeCopyField));
  const width = item.names?.length ?? split[0].length;
  if (split.some((row) => row.length !== width)) {
    throw new DumpImportError(`COPY data for ${item.table} has rows that do not match its ${width} columns`);
  }
  const fkIndex = selfReference ? item.names?.indexOf(selfReference.column) ?? -1 : -1;
  const keyIndex = selfReference ? item.names?.indexOf(selfReference.references) ?? -1 : -1;
  if (fkIndex >= 0 && keyIndex >= 0) split = parentsFirst(split, fkIndex, keyIndex);
  const perInsert = Math.max(1, Math.min(MAX_ROWS_PER_INSERT, Math.floor(MAX_PARAMS / width)));
  for (let at = 0; at < split.length; at += perInsert) {
    const batch = split.slice(at, at + perInsert);
    const tuples = batch.map((_, r) => `(${Array.from({ length: width }, (__, c) => `$${r * width + c + 1}`).join(', ')})`);
    await client.query(
      // COPY writes GENERATED ALWAYS identity values as given; INSERT needs the override.
      `INSERT INTO ${item.table} ${item.columns ?? ''} OVERRIDING SYSTEM VALUE VALUES ${tuples.join(', ')}`,
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
  const selfRefs = await selfReferences(client);
  for (const key of await loadOrder(client, [...byTable.keys()])) {
    for (const item of byTable.get(key)) {
      if (item.kind === 'copy') {
        await insertCopyRows(client, item, selfRefs.get(key));
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
