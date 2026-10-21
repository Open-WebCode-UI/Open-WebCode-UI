import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db/index.js';

describe('providers type migration', () => {
  it('rebuilds a pre-Ollama providers table, keeping rows and allowing the new type', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mig-')), 'old.db');
    const old = new Database(file);
    old.exec(`CREATE TABLE providers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL CHECK (type IN ('openai','anthropic','lmstudio','bedrock','azure')),
      config TEXT NOT NULL DEFAULT '{}', secret_enc TEXT, enabled INTEGER NOT NULL DEFAULT 1, allowed_roles TEXT NOT NULL DEFAULT '[]');
      INSERT INTO providers (name,type) VALUES ('keep','openai');`);
    old.close();
    const db = openDb(file);
    expect(db.prepare('SELECT name,type FROM providers').all()).toEqual([{ name: 'keep', type: 'openai' }]);
    for (const t of ['ollama', 'generic', 'gemini', 'vertex', 'mistral']) db.prepare('INSERT INTO providers (name,type) VALUES (?,?)').run(t, t);
    expect(() => db.prepare("INSERT INTO providers (name,type) VALUES ('bad','nope')").run()).toThrow();
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='providers_new'").get()).toBeUndefined();
    db.close();
  });
});
