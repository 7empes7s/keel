/**
 * Reading Keel's own settings files under /etc/keel (tenant.json, restorer.json, the
 * PowerShell collector and restorer files, workload-scope.json).
 *
 * A missing or broken file used to stop a run with a raw `ENOENT` or `SyntaxError`.
 * readConfigFile still stops the run (it never falls back to another file), but with a
 * plain sentence that names the file, what is wrong with it and what to do:
 *
 *   Keel can't read the Exchange collector settings file (/etc/keel/exchange-collector.json):
 *   the file is missing. Fix the file on the Keel server, or remove it from workload-scope.json.
 *
 * The portal turns that sentence into its plain cause and next step
 * (portal/lib/error-words.ts), so keep the "Keel can't read the <what> file (<path>): "
 * shape.
 *
 * The parser's own message is never repeated: Node quotes part of the file in a
 * SyntaxError, and these files can hold secrets.
 */

export class ConfigFileError extends Error {
  constructor(message, { path, problem, code } = {}) {
    super(message);
    this.name = 'ConfigFileError';
    this.path = path;
    this.problem = problem;
    if (code) this.code = code;
  }
}

export const DEFAULT_FIX = 'Fix the file on the Keel server, then try again.';
export const SCOPE_LISTED_FIX = 'Fix the file on the Keel server, or remove it from workload-scope.json.';

const OPEN_PROBLEMS = {
  ENOENT: 'the file is missing',
  ENOTDIR: 'the file is missing',
  EACCES: 'Keel is not allowed to open it',
  EPERM: 'Keel is not allowed to open it',
  EISDIR: 'it is a folder, not a file',
};

/** The plain sentence for one unreadable settings file. */
export function configFileMessage({ what, path, problem, fix = DEFAULT_FIX }) {
  return `Keel can't read the ${what} file (${path}): ${problem}. ${fix}`;
}

/**
 * The settings object in one file. Throws a ConfigFileError when the file cannot be
 * opened, is empty, is not valid JSON, or holds something other than a JSON object.
 *   what: the file's plain name, e.g. "Exchange collector settings".
 *   fix:  the next step, one sentence (default DEFAULT_FIX).
 */
export function readConfigFile(path, { readFile, what = 'settings', fix = DEFAULT_FIX }) {
  const fail = (problem, code) => new ConfigFileError(configFileMessage({ what, path, problem, fix }), { path, problem, code });
  let text;
  try {
    text = readFile(path, 'utf8');
  } catch (error) {
    throw fail(OPEN_PROBLEMS[error?.code] ?? 'it could not be opened', error?.code);
  }
  if (Buffer.isBuffer(text)) text = text.toString('utf8');
  if (typeof text !== 'string' || text.trim() === '') throw fail('the file is empty');
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw fail('it is not valid JSON');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw fail('it does not hold settings (a JSON object)');
  }
  return value;
}
