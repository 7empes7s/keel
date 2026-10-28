// Every portal CSV export builds its cells here, so text that a spreadsheet would
// run as a formula (= + - @, tab, carriage return) is always neutralised.
import { csvCell as engineCsvCell, csvLine as engineCsvLine } from "../../engine/reports/csv.mjs";

export type CsvOptions = { always?: boolean };

export function csvCell(value: unknown, options: CsvOptions = {}): string {
  return engineCsvCell(value, options);
}

export function csvLine(values: readonly unknown[], options: CsvOptions = {}): string {
  return engineCsvLine([...values], options);
}
