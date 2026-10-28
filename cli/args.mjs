// Strict argv parsing shared by every CLI in cli/ (follow-up to security audit finding 4).
//
// A CLI used to read flags with argv.includes / argv.indexOf, so a value that looked like
// a flag (a restore target "--allow-tenant-wide-test-writes") switched that flag on, and a
// mistyped flag was silently ignored. parseCliArgs wraps node:util parseArgs in strict
// mode and refuses:
//   - an unknown flag, or more positionals than the CLI takes;
//   - a single-value option or a switch given twice;
//   - an empty value, or a value that starts with "-" (including "--name=--x").
// Free text a person types (a label, a reason) may start with "-" when it holds
// whitespace, as in "- copied from prod": a flag never holds whitespace.
//
// cli/args.test.mjs blocks any CLI from going back to hand-rolled flag parsing.
import { parseArgs } from 'node:util';

/**
 * @param {string[]} args argv after the script path (process.argv.slice(2)).
 * @param {object} spec
 * @param {string} spec.name CLI name used as the error prefix (e.g. "keel-collect").
 * @param {string[]} [spec.strings] single-value options.
 * @param {string[]} [spec.text] single-value free-text options (see above).
 * @param {string[]} [spec.repeatable] options that may be given more than once; read as arrays.
 * @param {string[]} [spec.booleans] switches; read as true/false.
 * @param {Record<string,string>} [spec.short] one-letter aliases, e.g. { h: 'help' }.
 * @param {number} [spec.positionals] how many positionals (subcommand, id) the CLI takes.
 * @returns {{ values: Record<string, string|string[]|boolean|undefined>, positionals: string[] }}
 */
export function parseCliArgs(args, {
  name, strings = [], text = [], repeatable = [], booleans = [], short = {}, positionals: maxPositionals = 0,
}) {
  const fail = (message) => { throw new Error(`${name}: ${message}`); };
  const singles = [...strings, ...text];
  const options = Object.fromEntries([
    ...[...singles, ...repeatable].map((option) => [option, { type: 'string', multiple: true }]),
    ...booleans.map((option) => [option, { type: 'boolean', multiple: true }]),
  ]);
  for (const [letter, option] of Object.entries(short)) {
    if (!options[option]) throw new Error(`${name}: short flag -${letter} names unknown option --${option}`);
    options[option].short = letter;
  }

  // parseArgs reads any dash-leading value as ambiguous. Free text that holds whitespace
  // cannot be a flag, so it is joined to its option ("--reason=- copied from prod").
  const joined = [];
  for (let index = 0; index < args.length; index += 1) {
    const option = typeof args[index] === 'string' && args[index].startsWith('--') ? args[index].slice(2) : null;
    const value = args[index + 1];
    if (option && text.includes(option) && typeof value === 'string' && value.startsWith('-') && /\s/.test(value)) {
      joined.push(`--${option}=${value}`);
      index += 1;
    } else {
      joined.push(args[index]);
    }
  }

  let parsed;
  try {
    parsed = parseArgs({ args: joined, options, strict: true, allowPositionals: true });
  } catch (err) {
    fail(err.message.split('\n')[0]);
  }
  const { values } = parsed;
  if (parsed.positionals.length > maxPositionals) {
    fail(`Unexpected argument '${parsed.positionals[maxPositionals]}'`);
  }
  for (const option of [...singles, ...booleans]) {
    if ((values[option] ?? []).length > 1) fail(`--${option} may be given only once`);
  }
  for (const option of [...singles, ...repeatable]) {
    for (const value of values[option] ?? []) {
      const freeText = text.includes(option) && /\s/.test(value);
      if (value.length === 0 || (value.startsWith('-') && !freeText)) {
        fail(`--${option} needs a value that does not start with "-"`);
      }
    }
  }

  const result = {};
  for (const option of singles) result[option] = values[option]?.[0];
  for (const option of repeatable) result[option] = values[option] ?? [];
  for (const option of booleans) result[option] = values[option] !== undefined;
  return { values: result, positionals: parsed.positionals };
}

/**
 * For a module that passes the raw argv array between its functions: returns
 * (argv) => values, parsed strictly once per array.
 */
export function argvParser(spec) {
  const cache = new WeakMap();
  return (argv) => {
    if (!cache.has(argv)) cache.set(argv, parseCliArgs(argv, spec).values);
    return cache.get(argv);
  };
}
