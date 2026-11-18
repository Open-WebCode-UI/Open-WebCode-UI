import { describe, it, expect } from 'vitest';
import { insertRow, insertColumn, deleteRow, deleteColumn, clearRange, mergeRange } from '../src/components/ide/csvOps.js';

const rows = [['a', 'b'], ['c']];
describe('CSV row, column and range edits', () => {
  it('inserts and deletes rows and columns, padding short rows', () => {
    expect(insertRow(rows, 1, 2)).toEqual([['a', 'b'], ['', ''], ['c']]);
    expect(insertColumn(rows, 0, 2)).toEqual([['', 'a', 'b'], ['', 'c', '']]);
    expect(deleteRow(rows, 0)).toEqual([['c']]);
    expect(deleteColumn(rows, 1)).toEqual([['a'], ['c']]);
    expect(rows).toEqual([['a', 'b'], ['c']]); // the input is not changed
  });
  it('clears a range', () => {
    expect(clearRange([['a', 'b'], ['c', 'd']], { r1: 0, c1: 1, r2: 1, c2: 1 })).toEqual([['a', ''], ['c', '']]);
  });
  it('merges a range into its top-left cell, joining the values that are not empty', () => {
    expect(mergeRange([['a', ''], ['', 'd']], { r1: 0, c1: 0, r2: 1, c2: 1 }, 2)).toEqual([['a d', ''], ['', '']]);
    expect(mergeRange([['x', 'y', 'z']], { r1: 0, c1: 1, r2: 0, c2: 2 }, 3)).toEqual([['x', 'y z', '']]);
  });
});
