import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ENGINES, makeTestKnex } from './engines.js';
import { migrateToLatest } from '../src/db/migrator.js';
import { trx, insertId, dayOf, isoOf, groupConcat, nullSafeEq, nowEpoch, affected } from '../src/db/dialect.js';

// The same checks on every engine in TEST_DB (default: SQLite). Run all three with `npm run test:db` after starting docker-compose.test.yml.
describe.each(ENGINES)('schema and dialect helpers on %s', (engine) => {
  let k, drop;
  beforeAll(async () => { ({ knex: k, drop } = await makeTestKnex(engine)); await migrateToLatest(k); }, 60000);
  afterAll(async () => { await drop?.(); });

  const user = (o = {}) => insertId(k('users'), { source: 'local', username: `u${Math.random()}`, ...o });
  const rejects = (p) => expect(p).rejects.toThrow();

  it('applies the baseline once', async () => {
    expect(await migrateToLatest(k)).toEqual([]);
  });

  it('keeps usernames unique per source, and case-sensitive', async () => {
    await k('users').insert({ source: 'local', username: 'Ann' });
    await k('users').insert({ source: 'local', username: 'ann' }); // different case: distinct, as on SQLite
    await rejects(k('users').insert({ source: 'local', username: 'ann' }));
    await k('users').insert({ source: 'saml', username: 'ann', idp_entity_id: 'idp', name_id: 'n1' }); // same name, other source
    await rejects(k('users').insert({ source: 'saml', idp_entity_id: 'idp', name_id: 'n1' }));
    await k('users').insert([{ source: 'saml', idp_entity_id: 'idp', name_id: null }, { source: 'saml', idp_entity_id: 'idp', name_id: null }]); // NULLs never collide
  });

  it('keeps MCP server names unique per scope', async () => {
    const u1 = await user(), u2 = await user();
    await k('mcp_servers').insert({ scope: 'tenant', name: 'docs', url: 'https://a' });
    await rejects(k('mcp_servers').insert({ scope: 'tenant', name: 'docs', url: 'https://b' }));
    await k('mcp_servers').insert({ scope: 'user', user_id: u1, name: 'docs', url: 'https://a' }); // same name, user scope
    await k('mcp_servers').insert({ scope: 'user', user_id: u2, name: 'docs', url: 'https://a' });
    await rejects(k('mcp_servers').insert({ scope: 'user', user_id: u1, name: 'docs', url: 'https://c' }));
  });

  it('enforces foreign keys and their actions', async () => {
    await rejects(k('role_permissions').insert({ role_id: 987654, permission: 'x' }));
    const [cat] = [await insertId(k('badge_categories'), { name: 'tier' })];
    const badge = await insertId(k('badges'), { category_id: cat, label: 'secret' });
    await k('badge_categories').where({ id: cat }).del(); // ON DELETE SET NULL
    expect((await k('badges').where({ id: badge }).first()).category_id).toBeNull();
    const role = await insertId(k('roles'), { name: `r${Math.random()}` });
    await k('role_permissions').insert({ role_id: role, permission: 'p' });
    await k('roles').where({ id: role }).del(); // ON DELETE CASCADE
    expect(await k('role_permissions').where({ role_id: role })).toEqual([]);
  });

  it('fills in defaults, including on text columns', async () => {
    const id = await insertId(k('providers'), { name: `p${Math.random()}`, type: 'openai' });
    expect(await k('providers').where({ id }).first()).toMatchObject({ config: '{}', allowed_roles: '[]', help_text: '', enabled: 1, position: 0 });
    const uid = await user();
    expect(Math.abs((await k('users').where({ id: uid }).first()).created_at - Math.floor(Date.now() / 1000))).toBeLessThan(120);
    expect(await k('users').where({ id: uid }).first()).toMatchObject({ web_search_enabled: 1, memory_enabled: 0, is_break_glass: 0 });
  });

  it('stores long text and returns numbers as numbers', async () => {
    const uid = await user();
    const conv = await insertId(k('conversations'), { user_id: uid, kind: 'chat' });
    const big = 'x'.repeat(200_000) + 'é✓';
    const mid = await insertId(k('messages'), { conversation_id: conv, role: 'assistant', content: big });
    expect((await k('messages').where({ id: mid }).first()).content).toBe(big);
    await k('usage').insert([{ user_id: uid, input_tokens: 5, output_tokens: 7, cost: 0.25 }, { user_id: uid, input_tokens: 1, output_tokens: 2, cost: 0.5 }]);
    const row = await k('usage').where({ user_id: uid }).first({ n: k.raw('COUNT(*)'), tokens: k.raw('SUM(input_tokens)'), cost: k.raw('SUM(cost)') });
    expect(row).toEqual({ n: 2, tokens: 6, cost: 0.75 });
    expect(typeof mid).toBe('number');
  });

  it('commits and rolls back transactions', async () => {
    await trx(k, (t) => t('settings').insert({ key: 'tx-ok', value: '1' }));
    await rejects(trx(k, async (t) => { await t('settings').insert({ key: 'tx-gone', value: '1' }); throw new Error('boom'); }));
    expect(await k('settings').where({ key: 'tx-ok' }).first()).toBeTruthy();
    expect(await k('settings').where({ key: 'tx-gone' }).first()).toBeUndefined();
    expect(affected(await k('settings').where({ key: 'tx-ok' }).update({ value: '2' }))).toBe(1);
  });

  it('supports upsert and insert-ignore', async () => {
    await k('settings').insert({ key: 'up', value: 'a' }).onConflict('key').merge();
    await k('settings').insert({ key: 'up', value: 'b' }).onConflict('key').merge();
    expect((await k('settings').where({ key: 'up' }).first()).value).toBe('b');
    const role = await insertId(k('roles'), { name: `r${Math.random()}` });
    await k('role_permissions').insert({ role_id: role, permission: 'p' }).onConflict(['role_id', 'permission']).ignore();
    await k('role_permissions').insert({ role_id: role, permission: 'p' }).onConflict(['role_id', 'permission']).ignore();
    expect(await k('role_permissions').where({ role_id: role })).toHaveLength(1);
  });

  it('dialect helpers agree across engines', async () => {
    const uid = await user();
    await k('usage').insert({ user_id: uid, ts: 86400 + 5, model_id: 'm-a' });
    await k('usage').insert({ user_id: uid, ts: 86400 + 9, model_id: 'm-b' });
    const r = await k('usage').where({ user_id: uid }).orderBy('ts').first({ d: dayOf(k, 'ts'), i: isoOf(k, 'ts') });
    expect(r).toEqual({ d: '1970-01-02', i: '1970-01-02T00:00:05Z' });
    const g = (await k('usage').where({ user_id: uid }).first({ g: groupConcat(k, 'model_id') })).g.split(',').sort();
    expect(g).toEqual(['m-a', 'm-b']);
    const nulls = await k('badges').where(nullSafeEq(k, 'category_id', null)).count({ n: '*' }).first();
    expect(Number(nulls.n)).toBeGreaterThanOrEqual(1);
    const { now } = await k('users').where({ id: uid }).first({ now: nowEpoch(k) });
    expect(Math.abs(Number(now) - Date.now() / 1000)).toBeLessThan(120);
  });
});
