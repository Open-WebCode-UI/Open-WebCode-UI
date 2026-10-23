import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createKnex, engineOf } from '../src/db/knex.js';
import { trx, insertId, dayOf, isoOf, groupConcat, nullSafeEq, affected } from '../src/db/dialect.js';

let k;
beforeAll(async () => {
  k = createKnex({ client: 'sqlite', file: ':memory:' });
  await k.schema.createTable('t', (t) => { t.increments('id'); t.string('name'); t.integer('ts'); t.integer('parent'); });
});
afterAll(() => k.destroy());

describe('knex layer (sqlite)', () => {
  it('reports the engine and enforces foreign keys', async () => {
    expect(engineOf(k)).toBe('sqlite');
    expect((await k.raw('PRAGMA foreign_keys'))[0].foreign_keys).toBe(1);
  });

  it('insertId returns a numeric id', async () => {
    const id = await insertId(k('t'), { name: 'a', ts: 86400 + 5 });
    expect(id).toBe(1);
    expect(await insertId(k('t'), { name: 'b', ts: 86400 })).toBe(2);
  });

  it('trx commits and rolls back', async () => {
    await trx(k, (x) => x('t').insert({ name: 'in-trx' }));
    await expect(trx(k, async (x) => { await x('t').insert({ name: 'gone' }); throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await k('t').where({ name: 'in-trx' }).first()).toBeTruthy();
    expect(await k('t').where({ name: 'gone' }).first()).toBeUndefined();
  });

  it('affected counts updates', async () => {
    expect(affected(await k('t').where({ name: 'a' }).update({ name: 'a2' }))).toBe(1);
  });

  it('dialect helpers produce valid SQLite', async () => {
    const row = await k('t').where({ id: 1 }).select({ d: dayOf(k, 'ts'), i: isoOf(k, 'ts') }).first();
    expect(row).toEqual({ d: '1970-01-02', i: '1970-01-02T00:00:05Z' });
    expect((await k('t').select({ g: groupConcat(k, 'name') }).first()).g).toContain('b');
    expect(await k('t').where(nullSafeEq(k, 'parent', null)).count({ n: '*' }).first()).toEqual({ n: 3 });
  });
});
