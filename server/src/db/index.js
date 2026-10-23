import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKnex } from './knex.js';
import { ALL_PERMISSIONS, BUILTIN_ROLES } from '../permissions.js';

const schema = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'schema.sql'), 'utf8');
let current;

export function openDb(file = ':memory:') {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  migrate(db);
  seedRoles(db);
  return db;
}

// Adds columns introduced after a database was first created (CREATE TABLE IF NOT EXISTS won't).
function migrate(db) {
  const has = (t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some((r) => r.name === c);
  if (!has('models', 'thinking_mode')) db.exec("ALTER TABLE models ADD COLUMN thinking_mode TEXT NOT NULL DEFAULT 'off'");
  if (!has('models', 'thinking_budget')) db.exec('ALTER TABLE models ADD COLUMN thinking_budget INTEGER');
  if (!has('conversations', 'updated_at')) { db.exec('ALTER TABLE conversations ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0'); db.exec('UPDATE conversations SET updated_at = created_at'); }
  if (!has('conversations', 'mode')) db.exec("ALTER TABLE conversations ADD COLUMN mode TEXT NOT NULL DEFAULT 'plan'");
  if (!has('conversations', 'model_id')) db.exec('ALTER TABLE conversations ADD COLUMN model_id INTEGER');
  if (!has('conversations', 'plan')) db.exec('ALTER TABLE conversations ADD COLUMN plan TEXT');
  if (!has('conversations', 'chat_type')) db.exec('ALTER TABLE conversations ADD COLUMN chat_type TEXT');
  if (!has('conversations', 'course_id')) db.exec('ALTER TABLE conversations ADD COLUMN course_id INTEGER REFERENCES courses(id) ON DELETE CASCADE');
  if (!has('conversations', 'page_id')) db.exec('ALTER TABLE conversations ADD COLUMN page_id INTEGER REFERENCES course_pages(id) ON DELETE CASCADE');
  if (!has('exercise_workspaces', 'policy_json')) db.exec('ALTER TABLE exercise_workspaces ADD COLUMN policy_json TEXT');
  if (!has('users', 'prompt_general')) db.exec('ALTER TABLE users ADD COLUMN prompt_general TEXT');
  if (!has('course_pages', 'module_id')) db.exec('ALTER TABLE course_pages ADD COLUMN module_id INTEGER REFERENCES course_modules(id) ON DELETE SET NULL');
  if (!has('users', 'prompt_course')) db.exec('ALTER TABLE users ADD COLUMN prompt_course TEXT');
  if (!has('messages', 'archived')) db.exec('ALTER TABLE messages ADD COLUMN archived INTEGER NOT NULL DEFAULT 0');
  if (!has('messages', 'rolled_back')) db.exec('ALTER TABLE messages ADD COLUMN rolled_back INTEGER NOT NULL DEFAULT 0');
  if (!has('messages', 'kind')) db.exec('ALTER TABLE messages ADD COLUMN kind TEXT');
  // Assessment modes. Before: max_attempts > 0 limited the tries and pass_pct always applied. Now a limited assessment has no pass score,
  // and an unlimited one keeps its pass mark only if every question is scored automatically (no written answers, no rubric exercises).
  if (!has('assessments', 'mode')) {
    db.exec("ALTER TABLE assessments ADD COLUMN mode TEXT NOT NULL DEFAULT 'unlimited'");
    db.exec('ALTER TABLE assessments ADD COLUMN pass_score INTEGER');
    db.exec("UPDATE assessments SET mode='limited' WHERE max_attempts > 0");
    db.exec(`UPDATE assessments SET pass_score=pass_pct WHERE max_attempts = 0 AND NOT EXISTS (
      SELECT 1 FROM questions q WHERE q.assessment_id=assessments.id
        AND (q.type='text' OR (q.type='exercise' AND json_array_length(json_extract(q.code_spec_json, '$.rubric')) > 0)))`);
  }
  // Assessments became pages. Each one that is not yet a page of its own gets one, right after the page it was attached to (or at the end
  // of the course), and the assessment now points at that new page. Learners who had already finished it keep their progress.
  {
    const old = db.prepare("SELECT a.* FROM assessments a LEFT JOIN course_pages p ON p.id=a.page_id AND p.layout='assessment' WHERE p.id IS NULL ORDER BY a.id").all();
    const after = new Map(); // attached page -> the last assessment page placed after it, so several stack in order
    const pageOf = db.prepare('SELECT * FROM course_pages WHERE id=?'), ins = db.prepare("INSERT INTO course_pages (course_id, module_id, position, title, layout) VALUES (?,?,?,?, 'assessment')");
    db.transaction(() => {
      for (const a of old) {
        const anchor = pageOf.get(after.get(a.page_id) ?? a.page_id ?? 0);
        let moduleId = null, pos;
        if (anchor) {
          moduleId = anchor.module_id; pos = anchor.position + 1;
          db.prepare('UPDATE course_pages SET position=position+1 WHERE course_id=? AND module_id IS ? AND position>=?').run(a.course_id, moduleId, pos);
          if (moduleId == null) db.prepare('UPDATE course_modules SET position=position+1 WHERE course_id=? AND position>=?').run(a.course_id, pos);
        } else {
          pos = Math.max(db.prepare('SELECT MAX(position) m FROM course_pages WHERE course_id=? AND module_id IS NULL').get(a.course_id).m ?? -1, db.prepare('SELECT MAX(position) m FROM course_modules WHERE course_id=?').get(a.course_id).m ?? -1) + 1;
        }
        const pid = Number(ins.run(a.course_id, moduleId, pos, a.title).lastInsertRowid);
        if (a.page_id) after.set(a.page_id, pid);
        db.prepare('UPDATE assessments SET page_id=? WHERE id=?').run(pid, a.id);
        db.prepare("INSERT OR IGNORE INTO course_progress (course_id, user_id, page_id) SELECT ?, user_id, ? FROM attempts WHERE assessment_id=? AND status='graded' AND (? IS NULL OR score >= ?)")
          .run(a.course_id, pid, a.id, a.pass_score, a.pass_score);
      }
    })();
  }
  if (!has('models', 'subagents')) db.exec('ALTER TABLE models ADD COLUMN subagents INTEGER NOT NULL DEFAULT 1');
  if (!has('models', 'attachments')) db.exec('ALTER TABLE models ADD COLUMN attachments INTEGER NOT NULL DEFAULT 0');
  // File and image uploads are separate switches (not every model can read images). A connection sets the default for its models; a model's own
  // value (NULL = inherit) overrides it. Models that had the old single 'attachments' switch on keep both, so nothing changes for them.
  if (!has('providers', 'file_uploads')) { db.exec('ALTER TABLE providers ADD COLUMN file_uploads INTEGER NOT NULL DEFAULT 0'); db.exec('ALTER TABLE providers ADD COLUMN image_uploads INTEGER NOT NULL DEFAULT 0'); }
  if (!has('models', 'file_uploads')) {
    db.exec('ALTER TABLE models ADD COLUMN file_uploads INTEGER'); db.exec('ALTER TABLE models ADD COLUMN image_uploads INTEGER');
    db.exec('UPDATE models SET file_uploads=1, image_uploads=1 WHERE attachments=1');
  }
  if (!has('users', 'memory_enabled')) db.exec('ALTER TABLE users ADD COLUMN memory_enabled INTEGER NOT NULL DEFAULT 0');
  if (!has('users', 'preferences')) db.exec('ALTER TABLE users ADD COLUMN preferences TEXT');
  // Profile switch defaults on: the tenant switch is off by default and each chat opts in on its own.
  if (!has('users', 'web_search_enabled')) db.exec('ALTER TABLE users ADD COLUMN web_search_enabled INTEGER NOT NULL DEFAULT 1');
  if (!has('conversations', 'web_search')) db.exec('ALTER TABLE conversations ADD COLUMN web_search INTEGER NOT NULL DEFAULT 0');
  if (!has('projects', 'memory_enabled')) db.exec('ALTER TABLE projects ADD COLUMN memory_enabled INTEGER NOT NULL DEFAULT 0');
  if (!has('models', 'input_price')) db.exec('ALTER TABLE models ADD COLUMN input_price REAL');
  if (!has('providers', 'help_text')) db.exec("ALTER TABLE providers ADD COLUMN help_text TEXT NOT NULL DEFAULT ''");
  if (!has('models', 'help_text')) db.exec("ALTER TABLE models ADD COLUMN help_text TEXT NOT NULL DEFAULT ''");
  if (!has('models', 'auto_context')) db.exec('ALTER TABLE models ADD COLUMN auto_context INTEGER NOT NULL DEFAULT 0');
  if (!has('usage', 'model_id')) {
    db.exec('ALTER TABLE usage ADD COLUMN model_id TEXT');
    db.exec('UPDATE usage SET model_id = COALESCE((SELECT m.model_id FROM models m WHERE m.id = usage.model_row_id), model_label)'); // older rows: the model's ID if it still exists, else the label they were saved with
  }
  if (!has('models', 'output_price')) db.exec('ALTER TABLE models ADD COLUMN output_price REAL');
  // The provider type CHECK constraint can't be altered in place: rebuild the table when it predates a type (latest: 'mistral').
  if (!db.prepare("SELECT sql FROM sqlite_master WHERE name='providers'").get().sql.includes("'mistral'")) {
    const cols = db.prepare('PRAGMA table_info(providers)').all().map((r) => r.name).join(',');
    db.pragma('foreign_keys = OFF');
    try {
      db.transaction(() => {
        const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE name='providers'").get().sql
          .replace(/CHECK \s*\(\s*type IN \([^)]*\)\s*\)/, "CHECK (type IN ('openai','anthropic','lmstudio','ollama','generic','gemini','vertex','mistral','bedrock','azure'))").replace(/CREATE TABLE (IF NOT EXISTS )?"?providers"?/, 'CREATE TABLE providers_new');
        db.exec(ddl);
        db.exec(`INSERT INTO providers_new (${cols}) SELECT ${cols} FROM providers`);
        db.exec('DROP TABLE providers');
        db.exec('ALTER TABLE providers_new RENAME TO providers');
      })();
    } finally { db.pragma('foreign_keys = ON'); }
  }
  // Skills are now kept separately for the Agent and the Chat page; the unique name is per scope, which needs a table rebuild.
  if (!has('skills', 'scope')) {
    db.transaction(() => {
      db.exec("CREATE TABLE skills_new (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, builtin_key TEXT, scope TEXT NOT NULL DEFAULT 'agent', name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', instructions TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')), UNIQUE (user_id, scope, name))");
      db.exec("INSERT INTO skills_new (id, user_id, builtin_key, scope, name, description, instructions, enabled, updated_at) SELECT id, user_id, builtin_key, 'agent', name, description, instructions, enabled, updated_at FROM skills");
      db.exec('DROP TABLE skills');
      db.exec('ALTER TABLE skills_new RENAME TO skills');
    })();
  }
  // One of a model's badges can be featured: shown on its card without expanding it. Cleared if the badge is deleted.
  if (!has('models', 'featured_badge_id')) db.exec('ALTER TABLE models ADD COLUMN featured_badge_id INTEGER REFERENCES badges(id) ON DELETE SET NULL');
  // Badge colors were first named after theme colors (which follow the branding); they are fixed colors now.
  if (!db.prepare("SELECT 1 FROM settings WHERE key='migr:badge-colors'").get()) {
    db.exec("UPDATE badges SET color = CASE color WHEN 'default' THEN 'gray' WHEN 'primary' THEN 'blue' WHEN 'secondary' THEN 'purple' WHEN 'info' THEN 'teal' WHEN 'success' THEN 'green' WHEN 'warning' THEN 'orange' WHEN 'error' THEN 'red' ELSE color END");
    db.prepare("INSERT INTO settings (key,value) VALUES ('migr:badge-colors','1')").run();
  }
  // Display order for providers and models (admin-chosen, shown in the model picker). Existing rows keep their creation order.
  for (const t of ['providers', 'models']) if (!has(t, 'position')) { db.exec(`ALTER TABLE ${t} ADD COLUMN position INTEGER NOT NULL DEFAULT 0`); db.exec(`UPDATE ${t} SET position=id`); }
  // New built-in permissions are only seeded into brand-new roles; grant them once to the existing built-in developer role.
  if (!db.prepare("SELECT 1 FROM settings WHERE key='migr:skills-perm'").get()) {
    const dev = db.prepare("SELECT id FROM roles WHERE name='developer'").get();
    if (dev) db.prepare('INSERT OR IGNORE INTO role_permissions VALUES (?,?)').run(dev.id, 'profile.skills.edit');
    db.prepare("INSERT INTO settings (key,value) VALUES ('migr:skills-perm','1')").run();
  }
  if (!db.prepare("SELECT 1 FROM settings WHERE key='migr:mcp-memory-perm'").get()) {
    const dev = db.prepare("SELECT id FROM roles WHERE name='developer'").get();
    if (dev) for (const p of ['mcp.use', 'profile.mcp.edit', 'memory.use']) db.prepare('INSERT OR IGNORE INTO role_permissions VALUES (?,?)').run(dev.id, p);
    db.prepare("INSERT INTO settings (key,value) VALUES ('migr:mcp-memory-perm','1')").run();
  }
  if (!db.prepare("SELECT 1 FROM settings WHERE key='migr:websearch-perm'").get()) {
    const dev = db.prepare("SELECT id FROM roles WHERE name='developer'").get();
    if (dev) db.prepare('INSERT OR IGNORE INTO role_permissions VALUES (?,?)').run(dev.id, 'websearch.use');
    db.prepare("INSERT INTO settings (key,value) VALUES ('migr:websearch-perm','1')").run();
  }
  // The chat page now has a General and a Coding tab, each with its own permissions. Chats made before are Coding chats, and a role
  // that could chat keeps the web search and memory it had there. Only the developer role gets the new General tab automatically.
  db.exec("UPDATE conversations SET chat_type='coding' WHERE kind='chat' AND chat_type IS NULL");
  if (!db.prepare("SELECT 1 FROM settings WHERE key='migr:chat-tabs-perm'").get()) {
    const grant = db.prepare('INSERT OR IGNORE INTO role_permissions VALUES (?,?)');
    for (const { role_id } of db.prepare("SELECT role_id FROM role_permissions WHERE permission='chat.use'").all()) {
      const has = (p) => db.prepare('SELECT 1 FROM role_permissions WHERE role_id=? AND permission=?').get(role_id, p);
      if (has('websearch.use')) grant.run(role_id, 'chat.coding.websearch');
      if (has('memory.use')) grant.run(role_id, 'chat.coding.memory');
    }
    const dev = db.prepare("SELECT id FROM roles WHERE name='developer'").get();
    if (dev) for (const p of ['chat.general.use', 'chat.general.websearch', 'chat.general.memory']) grant.run(dev.id, p);
    db.prepare("INSERT INTO settings (key,value) VALUES ('migr:chat-tabs-perm','1')").run();
  }
  // Courses: existing developer and general-chat roles can take courses they are enrolled in.
  if (!db.prepare("SELECT 1 FROM settings WHERE key='migr:course-perm'").get()) {
    for (const name of ['developer', 'chat-general']) {
      const r = db.prepare('SELECT id FROM roles WHERE name=?').get(name);
      if (r) db.prepare('INSERT OR IGNORE INTO role_permissions VALUES (?,?)').run(r.id, 'course.learn');
    }
    db.prepare("INSERT INTO settings (key,value) VALUES ('migr:course-perm','1')").run();
  }
}

export function seedRoles(db) {
  for (const [name, def] of Object.entries(BUILTIN_ROLES)) {
    let row = db.prepare('SELECT id FROM roles WHERE name=?').get(name);
    if (!row) {
      const r = db.prepare('INSERT INTO roles (name, description, builtin) VALUES (?,?,1)').run(name, def.description);
      row = { id: Number(r.lastInsertRowid) };
    }
    // Administrator is immutable: always resynced to the full permission list.
    if (name === 'administrator') {
      db.prepare('DELETE FROM role_permissions WHERE role_id=?').run(row.id);
      for (const p of ALL_PERMISSIONS) db.prepare('INSERT INTO role_permissions VALUES (?,?)').run(row.id, p);
    } else if (!db.prepare('SELECT 1 FROM role_permissions WHERE role_id=? LIMIT 1').get(row.id)) {
      for (const p of def.permissions) db.prepare('INSERT INTO role_permissions VALUES (?,?)').run(row.id, p);
    }
  }
}

export function initDb(file) { current = openDb(file); return current; }
export function getDb() { if (!current) throw new Error('DB not initialized'); return current; }
export function setDb(db) { current = db; }

// Knex handle for the multi-engine layer. Call sites move from getDb() (better-sqlite3, SQLite only) to getKnex() file by file.
let knex;
export function initKnex(dbConfig) { knex = createKnex(dbConfig); return knex; }
export function getKnex() { if (!knex) throw new Error('Knex not initialized'); return knex; }
export function setKnex(k) { knex = k; }
