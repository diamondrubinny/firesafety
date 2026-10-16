/**
 * CSV for spreadsheet tools: UTF-8 BOM (Hebrew in Excel), CRLF, RFC 4180 quoting,
 * and formula-injection protection (cells starting with = + - @ TAB CR are prefixed with ').
 */
export function toCsv(headers: string[], rows: (string | number | null | undefined)[][]): string {
  const cell = (v: string | number | null | undefined): string => {
    if (v === null || v === undefined) return '';
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) || s.startsWith("'") ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers, ...rows].map((r) => r.map(cell).join(','));
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
