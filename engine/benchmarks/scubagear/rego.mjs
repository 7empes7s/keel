/**
 * Reads ScubaGear's Rego files without running them, to answer one question per rule:
 * which keys of ScubaGear's input document does it read?
 *
 * ScubaGear's rules read one JSON document per run (its "provider" output, keys such
 * as `conditional_access_policies` or `SPO_tenant`). Each rule is one or more
 * `tests contains {...} if {...}` statements carrying a `PolicyId`. A rule reads the
 * keys its own statements name plus every key named by the helper rules and functions
 * they call, followed through the package and the imported `data.utils.*` helpers.
 *
 * The answer can only over-state what a rule reads, never under-state it: a helper's
 * keys count even when the rule takes a branch that skips it, and a local variable that
 * shares a helper's name counts as a call. Any use of `input` other than a named key
 * (for example passing the whole document on) is an error, so a rule that could read
 * everything is never reported as reading a few keys.
 */

const IDENT = /[A-Za-z_][A-Za-z0-9_]*/g;
const KEYWORDS = new Set([
  'package', 'import', 'default', 'if', 'else', 'contains', 'some', 'every', 'in', 'not', 'with', 'as',
  'true', 'false', 'null', 'input', 'data', 'rego', 'v1', 'future', 'keywords',
]);

/** Removes comments and splits string literals out, so code scanning never sees text inside a string. */
function scan(source) {
  let code = '';
  const strings = [];
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (char === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      code += '\n';
    } else if (char === '"' || char === '`') {
      const quote = char;
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== quote) {
        if (quote === '"' && source[i] === '\\') { value += source[i] + source[i + 1]; i += 2; continue; }
        if (quote === '"' && source[i] === '\n') throw new Error('unterminated string in Rego source');
        value += source[i];
        i += 1;
      }
      if (i >= source.length) throw new Error('unterminated string in Rego source');
      code += `"\u0000${strings.length}"`;
      strings.push(value);
    } else {
      code += char;
    }
  }
  return { code, strings };
}

const STRING_REF = /"\u0000(\d+)"/g;
const restore = (text, strings) => text.replace(STRING_REF, (_, index) => JSON.stringify(strings[Number(index)]));

/** Top-level statements: a statement starts at column 0 with the bracket depth back at 0. */
function statements(code) {
  const out = [];
  let current = null;
  let depth = 0;
  for (const line of code.split('\n')) {
    // `else` and a body's `if {` on its own line continue the statement above.
    const startsStatement = depth === 0 && /^[A-Za-z_]/.test(line) && !/^(else|if)\b/.test(line);
    if (startsStatement) {
      if (current) out.push(current);
      current = line;
    } else if (current !== null) {
      current += `\n${line}`;
    } else if (line.trim()) {
      throw new Error(`Rego text before the first statement: ${line.trim()}`);
    }
    for (const char of line) {
      if ('([{'.includes(char)) depth += 1;
      else if (')]}'.includes(char)) depth -= 1;
    }
    if (depth < 0) throw new Error('unbalanced brackets in Rego source');
  }
  if (depth !== 0) throw new Error('unbalanced brackets in Rego source');
  if (current) out.push(current);
  return out;
}

function inputKeys(code, strings) {
  const keys = new Set();
  let rest = code;
  for (const pattern of [
    /\binput\.([A-Za-z_][A-Za-z0-9_]*)/g,
    /\binput\[\s*"\u0000(\d+)"\s*\]/g,
    /\bobject\.get\(\s*input\s*,\s*"\u0000(\d+)"/g,
    // object.get(input, ["key", ...]): the first path element is the key.
    /\bobject\.get\(\s*input\s*,\s*\[\s*"\u0000(\d+)"/g,
  ]) {
    const quoted = pattern.source.includes('u0000');
    rest = rest.replace(pattern, (_, key) => {
      keys.add(quoted ? strings[Number(key)] : key);
      return ' ';
    });
  }
  if (/\binput\b/.test(rest)) {
    throw new Error(`Rego reads the input document other than by a named key: ${restore(rest, strings).trim().split('\n')[0]}`);
  }
  return keys;
}

/**
 * Parses one Rego file. Returns its package, its import aliases, its statements
 * (name, input keys, identifiers used) and, for `tests` statements, the rule id and
 * criticality each one reports.
 */
export function parseRegoFile(source, { file = 'rego' } = {}) {
  const { code, strings } = scan(source);
  const parsed = { file, package: null, imports: new Map(), statements: [] };
  for (const statement of statements(code)) {
    const text = restore(statement, strings);
    if (/^package\s/.test(statement)) {
      parsed.package = /^package\s+([A-Za-z0-9_.]+)/.exec(statement)[1];
      continue;
    }
    if (/^import\s/.test(statement)) {
      const match = /^import\s+(data\.[A-Za-z0-9_.]+)(?:\s+as\s+([A-Za-z_]\w*))?/.exec(statement);
      if (match) {
        const path = match[1].slice('data.'.length);
        parsed.imports.set(match[2] ?? path.split('.').pop(), path);
      }
      continue;
    }
    const head = /^(?:default\s+)?([A-Za-z_][A-Za-z0-9_]*)/.exec(statement);
    const name = head[1];
    if (KEYWORDS.has(name)) throw new Error(`${file}: a statement starts with the keyword '${name}'`);
    const withoutStrings = statement.replace(STRING_REF, ' ');
    const identifiers = new Set();
    const qualified = new Set();
    for (const match of withoutStrings.matchAll(/\bdata\.((?:[A-Za-z_]\w*\.)+[A-Za-z_]\w*)/g)) qualified.add(match[1]);
    for (const match of withoutStrings.replace(/\bdata\.[A-Za-z0-9_.]+/g, ' ').matchAll(IDENT)) {
      if (!KEYWORDS.has(match[0])) identifiers.add(match[0]);
    }
    // Member names: what follows a `.` (Policy.State), plus the keys object.get() is
    // given as strings. Built-in namespaces (object.get, regex.match) are not members.
    const members = new Set();
    const memberCode = statement
      .replace(/\bdata\.[A-Za-z0-9_.]+/g, ' ')
      .replace(/\b(?:object|regex|time|array|json|strings|units|crypto|net|io|rego|future|glob|graph|semver|uuid|base64|urlquery|yaml|numbers|bits)\.[A-Za-z_]\w*/g, ' ');
    for (const match of memberCode.matchAll(/\.\s*([A-Za-z_]\w*)/g)) members.add(match[1]);
    for (const match of statement.matchAll(/\bobject\.get\(\s*[^,()]+,\s*(?:"\u0000(\d+)"|\[([^\]]*)\])/g)) {
      if (match[1] !== undefined) members.add(strings[Number(match[1])]);
      else for (const quoted of match[2].matchAll(/"\u0000(\d+)"/g)) members.add(strings[Number(quoted[1])]);
    }
    const entry = { name, keys: inputKeys(statement, strings), identifiers, qualified, members };
    if (name === 'tests') {
      const policyIds = new Set([
        ...[...text.matchAll(/"PolicyId"\s*:\s*"([^"]+)"/g)].map((m) => m[1]),
        ...[...text.matchAll(/\bPolicyId\s*:=\s*"([^"]+)"/g)].map((m) => m[1]),
      ]);
      if (policyIds.size !== 1) throw new Error(`${file}: a tests statement names ${policyIds.size} rule ids, expected 1`);
      const criticality = /"Criticality"\s*:\s*"([^"]+)"/.exec(text);
      if (!criticality) throw new Error(`${file}: tests statement for ${[...policyIds][0]} has no Criticality`);
      entry.policyId = [...policyIds][0];
      entry.criticality = criticality[1];
    }
    parsed.statements.push(entry);
  }
  if (!parsed.package) throw new Error(`${file}: no package line`);
  return parsed;
}

/**
 * For every rule id in the product files, the input keys it reads (directly or through
 * helpers), the member names its code uses anywhere on the way (`members`: a superset
 * of the fields it reads from those inputs) and the criticality of each statement that
 * reports it.
 * `files` is a list of { file, source }; product and util files together.
 */
export function regoRuleInputs(files) {
  const parsed = files.map(({ file, source }) => parseRegoFile(source, { file }));
  // Every named rule or function, by `package.name`.
  const definitions = new Map();
  for (const unit of parsed) {
    for (const statement of unit.statements) {
      if (statement.name === 'tests') continue;
      const id = `${unit.package}.${statement.name}`;
      if (!definitions.has(id)) definitions.set(id, []);
      definitions.get(id).push({ unit, statement });
    }
  }
  const resolve = (unit, statement) => {
    const targets = new Set();
    for (const identifier of statement.identifiers) {
      if (definitions.has(`${unit.package}.${identifier}`)) targets.add(`${unit.package}.${identifier}`);
      const imported = unit.imports.get(identifier);
      if (imported && definitions.has(imported)) targets.add(imported);
    }
    for (const path of statement.qualified) if (definitions.has(path)) targets.add(path);
    return targets;
  };
  // Everything reachable from a statement, walked breadth-first (a name that only looks
  // like a call can make a loop; the visited set ends it).
  const reachable = (unit, statement) => {
    const keys = new Set(statement.keys);
    const members = new Set(statement.members);
    const visited = new Set();
    const queue = [...resolve(unit, statement)];
    while (queue.length) {
      const id = queue.shift();
      if (visited.has(id)) continue;
      visited.add(id);
      for (const definition of definitions.get(id)) {
        for (const key of definition.statement.keys) keys.add(key);
        for (const member of definition.statement.members) members.add(member);
        queue.push(...resolve(definition.unit, definition.statement));
      }
    }
    return { keys, members };
  };

  const rules = new Map();
  for (const unit of parsed) {
    for (const statement of unit.statements) {
      if (statement.name !== 'tests') continue;
      const rule = rules.get(statement.policyId) ?? { policyId: statement.policyId, file: unit.file, inputs: new Set(), members: new Set(), criticalities: new Set() };
      if (rule.file !== unit.file) throw new Error(`${statement.policyId} is reported from two files`);
      const found = reachable(unit, statement);
      for (const key of found.keys) rule.inputs.add(key);
      for (const member of found.members) rule.members.add(member);
      rule.criticalities.add(statement.criticality);
      rules.set(statement.policyId, rule);
    }
  }
  return rules;
}
