import { describe, it, expect } from 'vitest';
import { parseCsv, toCsv, isCsvPath } from '../src/components/ide/csv.js';

describe('CSV text', () => {
  it('reads quoted fields, doubled quotes, line breaks inside quotes, and CRLF', () => {
    expect(parseCsv('a,"b,c","say ""hi""","x\ny"\r\n1,2,,3\r\n')).toEqual([['a', 'b,c', 'say "hi"', 'x\ny'], ['1', '2', '', '3']]);
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv('a,b')).toEqual([['a', 'b']]);
  });
  it('writes back the same text, quoting only the fields that need it', () => {
    const text = 'Name,Note\nAda,"likes ""tea"", not coffee"\nBob,\n';
    expect(toCsv(parseCsv(text))).toBe(text);
    expect(toCsv([['plain', 'two words']])).toBe('plain,two words\n');
    expect(toCsv([['a'], ['b']], false)).toBe('a\nb');
  });
  it('recognises CSV files by name', () => {
    expect(isCsvPath('data/sales.CSV')).toBe(true);
    expect(isCsvPath('notes.txt')).toBe(false);
  });
});
