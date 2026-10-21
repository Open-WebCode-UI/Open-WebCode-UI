CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL CHECK (source IN ('saml','local')),
  username TEXT,
  email TEXT, first_name TEXT, last_name TEXT, display_name TEXT,
  idp_entity_id TEXT, name_id TEXT,
  password_hash TEXT,
  is_break_glass INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0,
  lockouts INTEGER NOT NULL DEFAULT 0,
  totp_secret_enc TEXT,
  mfa_enrolled INTEGER NOT NULL DEFAULT 0,
  totp_confirmed INTEGER NOT NULL DEFAULT 0,
  totp_last_step INTEGER NOT NULL DEFAULT 0,
  prompt_plan TEXT, prompt_act TEXT, prompt_chat TEXT, prompt_general TEXT, prompt_course TEXT,
  last_login INTEGER,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS users_local_username ON users(username) WHERE source='local';
CREATE UNIQUE INDEX IF NOT EXISTS users_saml_id ON users(idp_entity_id, name_id) WHERE source='saml';

CREATE TABLE IF NOT EXISTS roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE, description TEXT DEFAULT '',
  builtin INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS role_permissions (
  role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission TEXT NOT NULL, PRIMARY KEY (role_id, permission)
);
CREATE TABLE IF NOT EXISTS user_roles (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  source TEXT NOT NULL DEFAULT 'manual', PRIMARY KEY (user_id, role_id, source)
);
CREATE TABLE IF NOT EXISTS group_role_map (
  group_value TEXT NOT NULL, role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (group_value, role_id)
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS providers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('openai','anthropic','lmstudio','ollama','generic','gemini','vertex','mistral','bedrock','azure')),
  config TEXT NOT NULL DEFAULT '{}',
  secret_enc TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  allowed_roles TEXT NOT NULL DEFAULT '[]',
  position INTEGER NOT NULL DEFAULT 0   -- admin-chosen display order (also the model picker order)
);
CREATE TABLE IF NOT EXISTS models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL, label TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  max_tokens INTEGER NOT NULL DEFAULT 4096,
  temperature REAL, context_size INTEGER,
  auto_context INTEGER NOT NULL DEFAULT 0,   -- 1 = the provider sizes the context window itself (context_size is ignored)
  thinking_mode TEXT NOT NULL DEFAULT 'off', thinking_budget INTEGER,
  subagents INTEGER NOT NULL DEFAULT 1,
  input_price REAL, output_price REAL,   -- USD per 1M tokens (NULL = not priced)
  position INTEGER NOT NULL DEFAULT 0,   -- admin-chosen display order within the provider
  UNIQUE (provider_id, model_id)
);

-- Badges an administrator attaches to models; shown on the model's card in the model picker (data classification tier, strengths, ...).
CREATE TABLE IF NOT EXISTS badge_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS badges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER REFERENCES badge_categories(id) ON DELETE SET NULL,   -- NULL = uncategorized
  label TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT 'gray',
  position INTEGER NOT NULL DEFAULT 0,
  UNIQUE (category_id, label)
);
CREATE TABLE IF NOT EXISTS model_badges (
  model_id INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  badge_id INTEGER NOT NULL REFERENCES badges(id) ON DELETE CASCADE,
  PRIMARY KEY (model_id, badge_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT 'full',
  created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL,
  auth_time INTEGER NOT NULL, stepup_at INTEGER NOT NULL DEFAULT 0,
  mfa_satisfied INTEGER NOT NULL DEFAULT 0,
  revoked INTEGER NOT NULL DEFAULT 0,
  ip TEXT, ua TEXT, webauthn_challenge TEXT
);
CREATE TABLE IF NOT EXISTS recovery_codes (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hash TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, hash)
);
CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE, public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0, transports TEXT DEFAULT '[]', name TEXT
);
CREATE TABLE IF NOT EXISTS relay_states (
  id TEXT PRIMARY KEY, target TEXT NOT NULL, expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS saml_replay (id TEXT PRIMARY KEY, expires INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, dir TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  UNIQUE (user_id, name)
);
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, title TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  mode TEXT NOT NULL DEFAULT 'plan', plan TEXT, model_id INTEGER, chat_type TEXT
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL, content TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0, kind TEXT, rolled_back INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
-- Where each session stood when a checkpoint was taken: messages after last_message_id are rolled back with it.
CREATE TABLE IF NOT EXISTS checkpoint_marks (
  checkpoint_id TEXT NOT NULL,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  last_message_id INTEGER NOT NULL,
  PRIMARY KEY (checkpoint_id, conversation_id)
);
-- Checkpoints the agent or system took during a session, shown in its timeline after the message with id anchor_message_id.
CREATE TABLE IF NOT EXISTS checkpoint_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  checkpoint_id TEXT NOT NULL, label TEXT NOT NULL, author TEXT NOT NULL,
  anchor_message_id INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL, actor TEXT, action TEXT NOT NULL, target TEXT, detail TEXT,
  prev_hash TEXT NOT NULL, hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS saml_requests (id TEXT PRIMARY KEY, value TEXT NOT NULL, expires INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS skills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  builtin_key TEXT,
  scope TEXT NOT NULL DEFAULT 'agent', -- 'agent' (the Agent page) or 'chat' (the Chat page): each has its own skills
  name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', instructions TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  UNIQUE (user_id, scope, name)
);

-- One row per model request. Cost is fixed at the prices in force when the request ran, so later price edits don't rewrite history.
CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  model_row_id INTEGER, provider_name TEXT, model_label TEXT, model_id TEXT, -- model_id: the provider's model identifier, which reports group by (the label is only a display name)
  kind TEXT NOT NULL DEFAULT 'agent',
  input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
  estimated INTEGER NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS usage_conv ON usage(conversation_id);
CREATE INDEX IF NOT EXISTS usage_ts ON usage(ts);

-- Onboarding tutorial progress. No row means the user has never started the tour (treated as incomplete, step 0).
CREATE TABLE IF NOT EXISTS tutorial_status (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  is_completed INTEGER NOT NULL DEFAULT 0,
  last_step_index INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- MCP servers (remote, Streamable HTTP). scope 'tenant' rows are configured by an administrator for everyone; scope 'user' rows
-- belong to one user. Auth headers are stored encrypted. A user can switch a tenant server off for themselves (mcp_user_prefs).
CREATE TABLE IF NOT EXISTS mcp_servers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL CHECK (scope IN ('tenant','user')),
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, url TEXT NOT NULL,
  headers_enc TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  allow_private INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS mcp_tenant_name ON mcp_servers(name) WHERE scope='tenant';
CREATE UNIQUE INDEX IF NOT EXISTS mcp_user_name ON mcp_servers(user_id, name) WHERE scope='user';
CREATE TABLE IF NOT EXISTS mcp_user_prefs (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  server_id INTEGER NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  disabled INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (user_id, server_id)
);

-- Files a user attached to an agent/chat message. Bytes live on disk (never in the database or the message history); rows are
-- unattached (conversation_id NULL) until a turn uses them.
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
  name TEXT NOT NULL, mime TEXT NOT NULL, kind TEXT NOT NULL, size INTEGER NOT NULL, file TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS attachments_user ON attachments(user_id);

-- What the agent has learned. project_id NULL = about the user in general; otherwise about that project.
CREATE TABLE IF NOT EXISTS memory_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  text TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'agent',
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS memory_scope ON memory_entries(user_id, project_id);

-- Courses. An instructor (role with course.author) owns a course made of pages; learners reach it by enrollment.
CREATE TABLE IF NOT EXISTS courses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE TABLE IF NOT EXISTS course_instructors (
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, PRIMARY KEY (course_id, user_id)
);
-- layout: content | chat | agent | agent_file. content_json is a TipTap document; config_json holds chat/tutor settings and enabled subpanels.
-- A module groups pages inside a course. Top-level pages and modules share one order (position).
CREATE TABLE IF NOT EXISTS course_modules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0, title TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS course_modules_course ON course_modules(course_id, position);
CREATE TABLE IF NOT EXISTS course_pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  module_id INTEGER REFERENCES course_modules(id) ON DELETE SET NULL, -- NULL = top level
  position INTEGER NOT NULL DEFAULT 0, title TEXT NOT NULL, layout TEXT NOT NULL DEFAULT 'content',
  content_json TEXT NOT NULL DEFAULT '{}', config_json TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS course_pages_course ON course_pages(course_id, position);
-- subject_type: user (subject_id = user id), role (role name) or saml_group (group name from the IdP).
CREATE TABLE IF NOT EXISTS course_enrollments (
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL, subject_id TEXT NOT NULL,
  assigned_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (course_id, subject_type, subject_id)
);
-- A learner's copy of the file on an 'agent_file' page. No row = they have not changed the instructor's starting text.
CREATE TABLE IF NOT EXISTS course_page_files (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  page_id INTEGER NOT NULL REFERENCES course_pages(id) ON DELETE CASCADE,
  content TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')), PRIMARY KEY (user_id, page_id)
);
CREATE TABLE IF NOT EXISTS course_progress (
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  page_id INTEGER NOT NULL REFERENCES course_pages(id) ON DELETE CASCADE,
  completed_at INTEGER NOT NULL DEFAULT (strftime('%s','now')), PRIMARY KEY (user_id, page_id)
);
CREATE TABLE IF NOT EXISTS assessments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  page_id INTEGER REFERENCES course_pages(id) ON DELETE SET NULL,
  title TEXT NOT NULL, pass_pct INTEGER NOT NULL DEFAULT 70, max_attempts INTEGER NOT NULL DEFAULT 0, -- pass_pct is legacy: pass_score replaces it
  mode TEXT NOT NULL DEFAULT 'unlimited', -- unscored | limited (max_attempts >= 1, best score counts) | unlimited
  pass_score INTEGER -- minimum percent to pass; NULL = none. Only unscored/unlimited, and only when every question is auto-scored
);
-- type: mcq | tf | text | exercise (agentic-coding exercise; code_spec_json holds starter files, brief, rubric, checks).
CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assessment_id INTEGER NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0, type TEXT NOT NULL, prompt TEXT NOT NULL,
  options_json TEXT NOT NULL DEFAULT '[]', answer_key_json TEXT NOT NULL DEFAULT 'null',
  points INTEGER NOT NULL DEFAULT 1, code_spec_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assessment_id INTEGER NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'in_progress', score REAL,
  started_at INTEGER NOT NULL DEFAULT (strftime('%s','now')), submitted_at INTEGER
);
CREATE INDEX IF NOT EXISTS attempts_user ON attempts(user_id, assessment_id);
CREATE TABLE IF NOT EXISTS answers (
  attempt_id INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  response_json TEXT NOT NULL DEFAULT 'null', score REAL, feedback TEXT,
  graded_by INTEGER REFERENCES users(id) ON DELETE SET NULL, PRIMARY KEY (attempt_id, question_id)
);

-- SAML groups from the user's last login, kept so group-based course enrollment can be resolved without the IdP.
CREATE TABLE IF NOT EXISTS user_saml_groups (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_value TEXT NOT NULL, PRIMARY KEY (user_id, group_value)
);

-- A learner's private notes on one course page (the "notes" tutor subpanel).
CREATE TABLE IF NOT EXISTS course_notes (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  page_id INTEGER NOT NULL REFERENCES course_pages(id) ON DELETE CASCADE,
  text TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')), PRIMARY KEY (user_id, page_id)
);

-- An agentic-coding exercise gives each attempt its own workspace (a normal project owned by the learner, so the agent runs under
-- their own permissions). On submit the workspace and the agent transcript are copied to `snapshot` (relative to the data dir) as evidence.
CREATE TABLE IF NOT EXISTS exercise_workspaces (
  attempt_id INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  snapshot TEXT, policy_json TEXT, PRIMARY KEY (attempt_id, question_id)
);

-- Keys for the provider API (/v1). Only a hash is kept; the key is shown once, when it is created.
CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,          -- first characters of the key, so a person can recognise it in a list
  key_hash TEXT NOT NULL UNIQUE,
  model_ids TEXT,                -- JSON array of models.id this key may use; NULL = every model its owner may use
  expires_at INTEGER,            -- NULL = never
  last_used_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS api_keys_user ON api_keys(user_id);
