/**
 * Small RFC 4180-style CSV parser (quoted fields, escaped quotes, CRLF/LF).
 * Delimiter is auto-detected between "," and ";" from the header line.
 */
export interface CsvParseResult {
  header: string[];
  rows: { line: number; cells: string[] }[];
}

export class CsvError extends Error {}

export function parseCsv(text: string, limits = { maxRows: 20_000, maxCellLength: 1000 }): CsvParseResult {
  const src = text.replace(/^\uFEFF/, ''); // strip UTF-8 BOM (Excel)
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';

  const records: { line: number; cells: string[] }[] = [];
  let cells: string[] = [];
  let cell = '';
  let inQuotes = false;
  let line = 1;
  let recordLine = 1;

  const pushCell = () => {
    if (cell.length > limits.maxCellLength) throw new CsvError(`line ${recordLine}: cell too long`);
    cells.push(cell);
    cell = '';
  };
  const pushRecord = () => {
    pushCell();
    if (!(cells.length === 1 && cells[0] === '')) records.push({ line: recordLine, cells });
    if (records.length > limits.maxRows + 1) throw new CsvError(`too many rows (max ${limits.maxRows})`);
    cells = [];
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQuotes = false;
      } else {
        if (ch === '\n') line++;
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell === '') inQuotes = true;
    else if (ch === delimiter) pushCell();
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      pushRecord();
      line++;
      recordLine = line;
    } else cell += ch;
  }
  if (inQuotes) throw new CsvError(`line ${recordLine}: unterminated quoted field`);
  if (cell !== '' || cells.length > 0) pushRecord();

  const [head, ...rows] = records;
  if (!head) throw new CsvError('empty file');
  return { header: head.cells.map((h) => h.trim()), rows };
}
