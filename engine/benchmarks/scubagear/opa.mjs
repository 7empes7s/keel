/**
 * Runs ScubaGear's own Rego rules, unchanged, in Node.
 *
 * The rules are compiled ahead of time to one WebAssembly module by OPA itself
 * (`node tools/scubagear-rules.mjs build-wasm`, which downloads the OPA release
 * ScubaGear v2.0.0 runs with and checks its SHA-256). build/rules.json records the OPA
 * version, the hash of every Rego file compiled and the hash of the module. Before the
 * module is used, every Rego hash is checked against the pinned MANIFEST.sha256 and the
 * module against its own hash, so a module built from any other Rego is refused.
 *
 * This file is a small host for OPA's documented WebAssembly ABI (version 1.2): it
 * writes the input as JSON, calls opa_eval, and reads the JSON answer. Five built-in
 * functions are not compiled into the module and are supplied here, written to give the
 * same answers as OPA's Go versions: sprintf, indexof_n, time.format, regex.split and
 * regex.find_n.
 *
 * Read-only: it evaluates an input document and returns ScubaGear's results.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openPinnedScubaGear } from './import.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const BUILD_DIR = join(HERE, 'build');
export const BUILD_MANIFEST = join(BUILD_DIR, 'rules.json');

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// --- Built-in functions the module asks the host for ------------------------------

// A value as OPA's sprintf prints it for %v: strings as they are, numbers as integers
// when they are whole, and anything else in Rego's own notation (["a", "b"]).
function regoText(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(regoText).join(', ')}]`;
  if (typeof value === 'object') return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}: ${regoText(item)}`).join(', ')}}`;
  return JSON.stringify(value);
}

// Go's %v for a float64 that is not whole: %g with the shortest digits, so the
// exponent form is used below 1e-4 and from 1e6 on (1.2345675e+06).
function goFloat(number) {
  if (!Number.isFinite(number)) return number > 0 ? '+Inf' : number < 0 ? '-Inf' : 'NaN';
  const [mantissa, exponentText] = number.toExponential().split('e');
  const exponent = Number(exponentText);
  if (exponent < -4 || exponent >= 6) return `${mantissa}e${exponent < 0 ? '-' : '+'}${String(Math.abs(exponent)).padStart(2, '0')}`;
  return String(number);
}

function sprintfArg(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isInteger(value) ? BigInt(value).toString() : goFloat(value);
  return regoText(value);
}

export function goSprintf(format, args) {
  if (typeof format !== 'string' || !Array.isArray(args)) throw new TypeError('sprintf: operand must be a string and an array');
  let next = 0;
  return format.replace(/%([-+# 0]*)(\d*)(?:\.(\d+))?([a-zA-Z%])/g, (match, flags, width, precision, verb) => {
    if (verb === '%') return '%';
    if (next >= args.length) return `%!${verb}(MISSING)`;
    const value = args[next];
    next += 1;
    let text;
    if (verb === 'v' || verb === 's') text = sprintfArg(value);
    else if (verb === 'd' && typeof value === 'number' && Number.isInteger(value)) text = BigInt(value).toString();
    else if (verb === 'f' && typeof value === 'number') text = value.toFixed(precision === undefined ? 6 : Number(precision));
    else text = `%!${verb}(${regoText(value)})`;
    if (width) text = flags.includes('-') ? text.padEnd(Number(width)) : text.padStart(Number(width), flags.includes('0') ? '0' : ' ');
    return text;
  }) + (next < args.length ? `%!(EXTRA ${args.slice(next).map(regoText).join(', ')})` : '');
}

// OPA counts string positions in Unicode code points.
export function indexOfN(text, search) {
  const chars = Array.from(text);
  const needle = Array.from(search);
  const out = [];
  if (needle.length === 0) return out;
  for (let i = 0; i + needle.length <= chars.length; i += 1) {
    if (needle.every((char, j) => chars[i + j] === char)) out.push(i);
  }
  return out;
}

// time.format(ns) in UTC, RFC 3339 with nanoseconds and trailing zeros dropped, as Go's
// time.RFC3339Nano. Only the UTC form is supported; ScubaGear passes a bare number.
export function timeFormat(value) {
  let ns = value;
  if (Array.isArray(value)) {
    if (value.length > 1 && value[1] !== 'UTC' && value[1] !== '') throw new Error('time.format: only UTC is supported');
    if (value.length > 2) throw new Error('time.format: a custom layout is not supported');
    [ns] = value;
  }
  if (typeof ns !== 'number' || !Number.isFinite(ns)) throw new TypeError('time.format: operand must be a number of nanoseconds');
  const whole = BigInt(Math.trunc(ns));
  const ms = Number(whole / 1000000n) - (whole % 1000000n < 0n ? 1 : 0);
  const iso = new Date(ms).toISOString();
  const nanos = ((whole % 1000000000n) + 1000000000n) % 1000000000n;
  const fraction = nanos === 0n ? '' : `.${nanos.toString().padStart(9, '0').replace(/0+$/, '')}`;
  return `${iso.slice(0, 19)}${fraction}Z`;
}

/**
 * regex.find_n: Go's Regexp.FindAllString. Matches do not overlap; an empty match right
 * where the previous match ended is skipped, as Go does. n < 0 means every match.
 */
export function regexFindN(pattern, text, n) {
  const found = [];
  if (n === 0) return found;
  let previousEnd = -1;
  for (const match of text.matchAll(new RegExp(pattern, 'gu'))) {
    if (match[0] === '' && match.index === previousEnd) continue;
    found.push(match[0]);
    previousEnd = match.index + match[0].length;
    if (n > 0 && found.length === n) break;
  }
  return found;
}

export const HOST_BUILTINS = Object.freeze({
  sprintf: goSprintf,
  indexof_n: indexOfN,
  'time.format': timeFormat,
  'regex.split': (pattern, text) => text.split(new RegExp(pattern)),
  'regex.find_n': regexFindN,
});

// --- The module ----------------------------------------------------------------------

/** Reads build/rules.json and checks it against the pinned Rego and the module bytes. */
export function readBuild({ manifestPath = BUILD_MANIFEST, pinPath } = {}) {
  const build = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const pinned = openPinnedScubaGear(pinPath ? { pinPath } : {});
  if (build.scubaGearVersion !== pinned.pin.version || build.scubaGearCommit !== pinned.pin.commitSha) {
    throw new Error('build/rules.json was built from another ScubaGear release than pin.json');
  }
  if (!Array.isArray(build.sources) || build.sources.length === 0) throw new Error('build/rules.json lists no Rego sources');
  for (const source of build.sources) {
    const text = pinned.read(source.path);
    if (sha256(Buffer.from(text, 'utf8')) !== source.sha256) throw new Error(`build/rules.json: ${source.path} differs from the pinned copy`);
  }
  const wasm = readFileSync(join(dirname(manifestPath), build.module));
  if (sha256(wasm) !== build.moduleSha256) throw new Error('build/rules.wasm does not match its hash in build/rules.json');
  return { build, wasm };
}

function readCString(memory, addr) {
  const bytes = new Uint8Array(memory.buffer);
  let end = addr;
  while (bytes[end] !== 0) end += 1;
  return new TextDecoder().decode(bytes.subarray(addr, end));
}

/**
 * Loads the compiled rules. Returns { entrypoints, evaluate(entrypoint, input) }, where
 * evaluate gives the value of that entrypoint (ScubaGear's `tests` set, as an array).
 */
export function loadRules(options = {}) {
  const { build, wasm } = readBuild(options);
  const memory = new WebAssembly.Memory({ initial: 16 });
  let exports = null;
  let builtinNames = {};
  const dump = (addr) => JSON.parse(readCString(memory, exports.opa_json_dump(addr)));
  const load = (value) => {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    const raw = exports.opa_malloc(bytes.byteLength);
    new Uint8Array(memory.buffer).set(bytes, raw);
    const parsed = exports.opa_json_parse(raw, bytes.byteLength);
    if (parsed === 0) throw new Error('OPA could not read a built-in result');
    return parsed;
  };
  const call = (id, ...args) => {
    const name = builtinNames[id];
    const impl = HOST_BUILTINS[name];
    if (!impl) throw new Error(`ScubaGear rules need the built-in ${name}, which this host does not supply`);
    return load(impl(...args.map(dump)));
  };
  const instance = new WebAssembly.Instance(new WebAssembly.Module(wasm), {
    env: {
      memory,
      opa_abort: (addr) => { throw new Error(`OPA aborted: ${readCString(memory, addr)}`); },
      opa_println: () => {},
      opa_builtin0: (id) => call(id),
      opa_builtin1: (id, _ctx, a) => call(id, a),
      opa_builtin2: (id, _ctx, a, b) => call(id, a, b),
      opa_builtin3: (id, _ctx, a, b, c) => call(id, a, b, c),
      opa_builtin4: (id, _ctx, a, b, c, d) => call(id, a, b, c, d),
    },
  });
  exports = instance.exports;
  const version = (global) => (typeof global === 'number' ? global : global?.value);
  if (version(exports.opa_wasm_abi_version) !== 1 || version(exports.opa_wasm_abi_minor_version) < 2) {
    throw new Error('the rules module does not use OPA WebAssembly ABI 1.2 or later');
  }
  builtinNames = Object.fromEntries(Object.entries(dump(exports.builtins())).map(([name, id]) => [id, name]));
  const missing = Object.values(builtinNames).filter((name) => !HOST_BUILTINS[name]);
  if (missing.length) throw new Error(`ScubaGear rules need built-ins this host does not supply: ${missing.join(', ')}`);
  const entrypoints = dump(exports.entrypoints());
  const dataAddr = load({});
  const heapBase = exports.opa_heap_ptr_get();

  return Object.freeze({
    build,
    entrypoints: Object.freeze(Object.keys(entrypoints)),
    evaluate(entrypoint, input) {
      if (!Object.hasOwn(entrypoints, entrypoint)) throw new Error(`no compiled entrypoint ${entrypoint}`);
      exports.opa_heap_ptr_set(heapBase);
      const bytes = new TextEncoder().encode(JSON.stringify(input));
      const shortBy = heapBase + bytes.byteLength - memory.buffer.byteLength;
      if (shortBy > 0) memory.grow(Math.ceil(shortBy / 65536));
      new Uint8Array(memory.buffer).set(bytes, heapBase);
      const result = exports.opa_eval(0, entrypoints[entrypoint], dataAddr, heapBase, bytes.byteLength, heapBase + bytes.byteLength, 0);
      const answer = JSON.parse(readCString(memory, result));
      // One result set entry with the entrypoint's value; none when it is undefined.
      return answer.length ? answer[0].result : undefined;
    },
  });
}

let shared = null;
/** The rules, loaded once per process. */
export function scubaRules() {
  shared ??= loadRules();
  return shared;
}
