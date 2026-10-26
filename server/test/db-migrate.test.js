import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db/index.js';
import { legacySchema } from '../src/db/legacy-migrate.js';

describe('providers type migration', () => {
  it('rebuilds a pre-Ollama providers table, keeping rows and allowing the new type', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mig-')), 'old.db');
    // A database from before the Knex move: the full legacy schema, with the providers table in its old shape.
    const old = new Database(file);
    old.exec(legacySchema);
    old.exec(`DROP TABLE providers;
      CREATE TABLE providers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL CHECK (type IN ('openai','anthropic','lmstudio','bedrock','azure')),
      config TEXT NOT NULL DEFAULT '{}', secret_enc TEXT, enabled INTEGER NOT NULL DEFAULT 1, allowed_roles TEXT NOT NULL DEFAULT '[]');
      INSERT INTO providers (name,type) VALUES ('keep','openai');`);
    old.close();
    const db = await openDb(file);
    expect(await db.raw('SELECT name,type FROM providers')).toEqual([{ name: 'keep', type: 'openai' }]);
    for (const t of ['ollama', 'generic', 'gemini', 'vertex', 'mistral']) await db('providers').insert({ name: t, type: t });
    await expect(db('providers').insert({ name: 'bad', type: 'nope' })).rejects.toThrow();
    expect(await db.raw("SELECT 1 FROM sqlite_master WHERE name='providers_new'")).toEqual([]);
    await db.destroy();
  });
});
