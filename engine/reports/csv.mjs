// One CSV cell for every spreadsheet export (engine and portal).
//
// A text cell that starts with = + - @, a tab or a carriage return is read as a
// formula by Excel, Sheets and LibreOffice, so a name such as =HYPERLINK(...)
// could run when an auditor opens the file. Such text gets a leading single
// quote, which spreadsheets show as plain text. Numbers stay as they are, so a
// real -3 is still a number.
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * @param {unknown} value
 * @param {{ always?: boolean }} [options] always: wrap every cell in quotes.
 * @returns {string}
 */
export function csvCell(value, options = {}) {
  if (value === null || value === undefined) return options.always ? '""' : '';
  let text = Array.isArray(value) ? value.join(' ') : String(value);
  if (typeof value !== 'number' && typeof value !== 'bigint' && FORMULA_START.test(text)) text = `'${text}`;
  return options.always || /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * @param {unknown[]} values
 * @param {{ always?: boolean }} [options]
 * @returns {string}
 */
export function csvLine(values, options = {}) {
  return values.map((value) => csvCell(value, options)).join(',');
}
