import { engineOf } from '../knex.js';
import { nowDefault } from '../dialect.js';

// The full schema as of the move to Knex: schema.sql plus every column the old migrate() added later. Written with the schema builder so
// the same migration produces correct DDL for SQLite, PostgreSQL and MariaDB.
//
// Conventions:
//  - Timestamps are epoch seconds in BIGINT columns (default: the database clock), flags are INTEGER 0/1, JSON is stored as text.
//  - Anything indexed or used as a key is a bounded string (MariaDB cannot index unbounded TEXT); other text is unbounded (LONGTEXT on
//    MariaDB, where plain TEXT stops at 64 KB).
//  - MariaDB tables use utf8mb4_bin so comparisons are case-sensitive, as they are in SQLite and PostgreSQL.
//  - The old CHECK (... IN ...) constraints on users.source, providers.type and mcp_servers.scope are validated in the application instead.

export async function up(knex) {
  const engine = engineOf(knex);
  // A database created before Knex is already complete (the legacy upgrade ran first): adopt it as is. SQLite DDL is transactional,
  // so a partly applied baseline cannot be mistaken for one.
  if (engine === 'sqlite' && await knex.schema.hasTable('users')) return;

  const now = () => nowDefault(knex);
  let current; // table being built (tables are created one after another)
  const create = (name, fn) => knex.schema.createTable(name, (t) => {
    current = name;
    if (engine === 'mariadb') { t.charset('utf8mb4'); t.collate('utf8mb4_bin'); }
    fn(t);
  });
  const ts = (t, col, withDefault = true) => { const c = t.bigInteger(col).notNullable(); if (withDefault) c.defaultTo(now()); return c; };
  const flag = (t, col, dflt = 0) => t.integer(col).notNullable().defaultTo(dflt);
  const txt = (t, col) => t.text(col, 'longtext');
  // Text column with a default. Knex leaves the default off TEXT columns for MySQL-family engines, so MariaDB (10.2.1+ allows it) gets it afterwards.
  const textDefaults = [];
  const txtd = (t, col, dflt, { nullable = false } = {}) => {
    textDefaults.push([current, col, dflt]);
    const c = txt(t, col).defaultTo(dflt);
    return nullable ? c : c.notNullable();
  };
  const fk = (t, col, table, onDelete, { nullable = false } = {}) => {
    const c = t.integer(col).unsigned();
    if (!nullable) c.notNullable();
    return c.references('id').inTable(table).onDelete(onDelete);
  };

  await create('users', (t) => {
    t.increments('id');
    t.string('source', 16).notNullable(); // 'saml' | 'local'
    t.string('username', 255);
    t.string('email', 255); t.string('first_name', 255); t.string('last_name', 255); t.string('display_name', 255);
    t.string('idp_entity_id', 400); t.string('name_id', 255);
    t.string('password_hash', 255);
    flag(t, 'is_break_glass'); flag(t, 'disabled'); flag(t, 'must_change_password'); flag(t, 'failed_attempts');
    t.bigInteger('locked_until').notNullable().defaultTo(0);
    flag(t, 'lockouts');
    txt(t, 'totp_secret_enc');
    flag(t, 'mfa_enrolled'); flag(t, 'totp_confirmed'); flag(t, 'totp_last_step');
    for (const c of ['prompt_plan', 'prompt_act', 'prompt_chat', 'prompt_general', 'prompt_course']) txt(t, c);
    t.bigInteger('last_login');
    ts(t, 'created_at');
    flag(t, 'memory_enabled'); txt(t, 'preferences'); flag(t, 'web_search_enabled', 1);
  });

  await create('roles', (t) => {
    t.increments('id');
    t.string('name', 255).notNullable().unique();
    txtd(t, 'description', '', { nullable: true });
    flag(t, 'builtin');
  });
  await create('role_permissions', (t) => {
    fk(t, 'role_id', 'roles', 'CASCADE');
    t.string('permission', 255).notNullable();
    t.primary(['role_id', 'permission']);
  });
  await create('user_roles', (t) => {
    fk(t, 'user_id', 'users', 'CASCADE'); fk(t, 'role_id', 'roles', 'CASCADE');
    t.string('source', 32).notNullable().defaultTo('manual');
    t.primary(['user_id', 'role_id', 'source']);
  });
  await create('group_role_map', (t) => {
    t.string('group_value', 255).notNullable(); fk(t, 'role_id', 'roles', 'CASCADE');
    t.primary(['group_value', 'role_id']);
  });
  await create('settings', (t) => { t.string('key', 255).primary(); txt(t, 'value').notNullable(); });

  await create('providers', (t) => {
    t.increments('id');
    t.string('name', 255).notNullable().unique();
    t.string('type', 32).notNullable(); // openai | anthropic | lmstudio | ollama | generic | gemini | vertex | mistral | bedrock | azure
    txtd(t, 'config', '{}');
    txt(t, 'secret_enc');
    flag(t, 'enabled', 1);
    txtd(t, 'allowed_roles', '[]');
    flag(t, 'position'); // admin-chosen display order (also the model picker order)
    flag(t, 'file_uploads'); flag(t, 'image_uploads');
    txtd(t, 'help_text', '');
  });

  // Badges an administrator attaches to models; shown on the model's card in the model picker.
  await create('badge_categories', (t) => { t.increments('id'); t.string('name', 255).notNullable().unique(); flag(t, 'position'); });
  await create('badges', (t) => {
    t.increments('id');
    fk(t, 'category_id', 'badge_categories', 'SET NULL', { nullable: true }); // NULL = uncategorized
    t.string('label', 255).notNullable();
    txtd(t, 'description', '');
    t.string('color', 32).notNullable().defaultTo('gray');
    flag(t, 'position');
    t.unique(['category_id', 'label']);
  });

  await create('models', (t) => {
    t.increments('id');
    fk(t, 'provider_id', 'providers', 'CASCADE');
    t.string('model_id', 255).notNullable(); t.string('label', 255);
    flag(t, 'enabled', 1);
    t.integer('max_tokens').notNullable().defaultTo(4096);
    t.double('temperature'); t.integer('context_size');
    flag(t, 'auto_context'); // 1 = the provider sizes the context window itself (context_size is ignored)
    t.string('thinking_mode', 32).notNullable().defaultTo('off'); t.integer('thinking_budget');
    flag(t, 'subagents', 1);
    t.double('input_price'); t.double('output_price'); // USD per 1M tokens (NULL = not priced)
    flag(t, 'position'); // admin-chosen display order within the provider
    flag(t, 'attachments');
    t.integer('file_uploads'); t.integer('image_uploads'); // NULL = inherit the provider's setting
    txtd(t, 'help_text', '');
    fk(t, 'featured_badge_id', 'badges', 'SET NULL', { nullable: true });
    t.unique(['provider_id', 'model_id']);
  });
  await create('model_badges', (t) => {
    fk(t, 'model_id', 'models', 'CASCADE'); fk(t, 'badge_id', 'badges', 'CASCADE');
    t.primary(['model_id', 'badge_id']);
  });

  await create('sessions', (t) => {
    t.string('id', 128).primary();
    fk(t, 'user_id', 'users', 'CASCADE');
    t.string('csrf', 255).notNullable();
    t.string('stage', 32).notNullable().defaultTo('full');
    ts(t, 'created_at', false); ts(t, 'last_seen', false); ts(t, 'auth_time', false);
    t.bigInteger('stepup_at').notNullable().defaultTo(0);
    flag(t, 'mfa_satisfied'); flag(t, 'revoked');
    t.string('ip', 64); txt(t, 'ua'); txt(t, 'webauthn_challenge');
  });
  await create('recovery_codes', (t) => {
    fk(t, 'user_id', 'users', 'CASCADE');
    t.string('hash', 255).notNullable(); flag(t, 'used');
    t.primary(['user_id', 'hash']);
  });
  await create('webauthn_credentials', (t) => {
    t.increments('id');
    fk(t, 'user_id', 'users', 'CASCADE');
    t.string('credential_id', 512).notNullable().unique(); txt(t, 'public_key').notNullable();
    t.bigInteger('counter').notNullable().defaultTo(0);
    txtd(t, 'transports', '[]', { nullable: true }); t.string('name', 255);
  });
  await create('relay_states', (t) => { t.string('id', 255).primary(); txt(t, 'target').notNullable(); t.bigInteger('expires').notNullable(); });
  await create('saml_replay', (t) => { t.string('id', 255).primary(); t.bigInteger('expires').notNullable(); });
  await create('saml_requests', (t) => { t.string('id', 255).primary(); txt(t, 'value').notNullable(); t.bigInteger('expires').notNullable(); });

  await create('projects', (t) => {
    t.increments('id');
    fk(t, 'user_id', 'users', 'CASCADE');
    t.string('name', 255).notNullable(); txt(t, 'dir').notNullable();
    ts(t, 'created_at');
    flag(t, 'memory_enabled');
    t.unique(['user_id', 'name']);
  });

  // Courses. An instructor (role with course.author) owns a course made of pages; learners reach it by enrollment.
  await create('courses', (t) => {
    t.increments('id');
    t.string('title', 255).notNullable(); txtd(t, 'description', '');
    fk(t, 'owner_id', 'users', 'CASCADE');
    t.string('status', 32).notNullable().defaultTo('draft');
    ts(t, 'created_at'); ts(t, 'updated_at');
  });
  await create('course_instructors', (t) => {
    fk(t, 'course_id', 'courses', 'CASCADE'); fk(t, 'user_id', 'users', 'CASCADE');
    t.primary(['course_id', 'user_id']);
  });
  // A module groups pages inside a course. Top-level pages and modules share one order (position).
  await create('course_modules', (t) => {
    t.increments('id');
    fk(t, 'course_id', 'courses', 'CASCADE');
    flag(t, 'position'); t.string('title', 255).notNullable();
    ts(t, 'updated_at');
    t.index(['course_id', 'position'], 'course_modules_course');
  });
  // layout: content | chat | agent | agent_file | assessment. content_json is a TipTap document; config_json holds chat/tutor settings.
  await create('course_pages', (t) => {
    t.increments('id');
    fk(t, 'course_id', 'courses', 'CASCADE');
    fk(t, 'module_id', 'course_modules', 'SET NULL', { nullable: true }); // NULL = top level
    flag(t, 'position'); t.string('title', 255).notNullable(); t.string('layout', 32).notNullable().defaultTo('content');
    txtd(t, 'content_json', '{}'); txtd(t, 'config_json', '{}');
    ts(t, 'updated_at');
    t.index(['course_id', 'position'], 'course_pages_course');
  });

  await create('conversations', (t) => {
    t.increments('id');
    fk(t, 'user_id', 'users', 'CASCADE');
    fk(t, 'project_id', 'projects', 'CASCADE', { nullable: true });
    t.string('kind', 32).notNullable(); t.text('title');
    ts(t, 'created_at'); ts(t, 'updated_at');
    t.string('mode', 32).notNullable().defaultTo('plan'); txt(t, 'plan'); t.integer('model_id'); t.string('chat_type', 32);
    flag(t, 'web_search');
    fk(t, 'course_id', 'courses', 'CASCADE', { nullable: true });
    fk(t, 'page_id', 'course_pages', 'CASCADE', { nullable: true });
  });
  await create('messages', (t) => {
    t.increments('id');
    fk(t, 'conversation_id', 'conversations', 'CASCADE');
    t.string('role', 32).notNullable(); txt(t, 'content').notNullable();
    flag(t, 'archived'); t.string('kind', 32); flag(t, 'rolled_back');
    ts(t, 'created_at');
    t.index(['conversation_id'], 'messages_conversation');
  });
  // Where each session stood when a checkpoint was taken: messages after last_message_id are rolled back with it.
  await create('checkpoint_marks', (t) => {
    t.string('checkpoint_id', 128).notNullable();
    fk(t, 'conversation_id', 'conversations', 'CASCADE');
    t.integer('last_message_id').notNullable();
    t.primary(['checkpoint_id', 'conversation_id']);
  });
  // Checkpoints the agent or system took during a session, shown in its timeline after the message with id anchor_message_id.
  await create('checkpoint_events', (t) => {
    t.increments('id');
    fk(t, 'conversation_id', 'conversations', 'CASCADE');
    t.string('checkpoint_id', 128).notNullable(); t.text('label').notNullable(); t.string('author', 255).notNullable();
    t.integer('anchor_message_id').notNullable().defaultTo(0);
  });
  await create('audit', (t) => {
    t.increments('id');
    ts(t, 'ts', false); t.string('actor', 255); t.string('action', 255).notNullable(); t.text('target'); txt(t, 'detail');
    t.string('prev_hash', 128).notNullable(); t.string('hash', 128).notNullable();
  });

  await create('skills', (t) => {
    t.increments('id');
    fk(t, 'user_id', 'users', 'CASCADE');
    t.string('builtin_key', 255);
    t.string('scope', 16).notNullable().defaultTo('agent'); // 'agent' (the Agent page) or 'chat' (the Chat page): each has its own skills
    t.string('name', 255).notNullable(); txtd(t, 'description', ''); txt(t, 'instructions').notNullable();
    flag(t, 'enabled', 1);
    ts(t, 'updated_at');
    t.unique(['user_id', 'scope', 'name']);
  });

  // One row per model request. Cost is fixed at the prices in force when the request ran, so later price edits don't rewrite history.
  await create('usage', (t) => {
    t.increments('id');
    ts(t, 'ts');
    fk(t, 'user_id', 'users', 'SET NULL', { nullable: true });
    fk(t, 'conversation_id', 'conversations', 'SET NULL', { nullable: true });
    t.integer('model_row_id'); t.string('provider_name', 255); t.string('model_label', 255);
    t.string('model_id', 255); // the provider's model identifier, which reports group by (the label is only a display name)
    t.string('kind', 32).notNullable().defaultTo('agent');
    t.bigInteger('input_tokens').notNullable().defaultTo(0); t.bigInteger('output_tokens').notNullable().defaultTo(0);
    flag(t, 'estimated'); t.double('cost').notNullable().defaultTo(0);
    t.index(['conversation_id'], 'usage_conv'); t.index(['ts'], 'usage_ts');
  });

  // Onboarding tutorial progress. No row means the user has never started the tour (treated as incomplete, step 0).
  await create('tutorial_status', (t) => {
    fk(t, 'user_id', 'users', 'CASCADE').primary();
    flag(t, 'is_completed'); flag(t, 'last_step_index');
    ts(t, 'updated_at');
  });

  // MCP servers (remote, Streamable HTTP). scope 'tenant' rows are configured by an administrator for everyone; scope 'user' rows
  // belong to one user. Auth headers are stored encrypted. A user can switch a tenant server off for themselves (mcp_user_prefs).
  await create('mcp_servers', (t) => {
    t.increments('id');
    t.string('scope', 16).notNullable(); // 'tenant' | 'user'
    fk(t, 'user_id', 'users', 'CASCADE', { nullable: true });
    t.string('name', 255).notNullable(); txt(t, 'url').notNullable();
    txt(t, 'headers_enc');
    flag(t, 'enabled', 1); flag(t, 'allow_private');
    ts(t, 'created_at');
  });
  await create('mcp_user_prefs', (t) => {
    fk(t, 'user_id', 'users', 'CASCADE'); fk(t, 'server_id', 'mcp_servers', 'CASCADE');
    flag(t, 'disabled', 1);
    t.primary(['user_id', 'server_id']);
  });

  // Files a user attached to an agent/chat message. Bytes live on disk (never in the database or the message history); rows are
  // unattached (conversation_id NULL) until a turn uses them.
  await create('attachments', (t) => {
    t.string('id', 128).primary();
    fk(t, 'user_id', 'users', 'CASCADE');
    fk(t, 'conversation_id', 'conversations', 'CASCADE', { nullable: true });
    t.text('name').notNullable(); t.string('mime', 255).notNullable(); t.string('kind', 32).notNullable();
    t.bigInteger('size').notNullable(); txt(t, 'file').notNullable();
    ts(t, 'created_at');
    t.index(['user_id'], 'attachments_user');
  });

  // What the agent has learned. project_id NULL = about the user in general; otherwise about that project.
  await create('memory_entries', (t) => {
    t.increments('id');
    fk(t, 'user_id', 'users', 'CASCADE');
    fk(t, 'project_id', 'projects', 'CASCADE', { nullable: true });
    txt(t, 'text').notNullable(); t.string('source', 32).notNullable().defaultTo('agent');
    ts(t, 'created_at'); ts(t, 'updated_at');
    t.index(['user_id', 'project_id'], 'memory_scope');
  });

  // subject_type: user (subject_id = user id), role (role name) or saml_group (group name from the IdP).
  await create('course_enrollments', (t) => {
    fk(t, 'course_id', 'courses', 'CASCADE');
    t.string('subject_type', 32).notNullable(); t.string('subject_id', 255).notNullable();
    fk(t, 'assigned_by', 'users', 'SET NULL', { nullable: true });
    ts(t, 'created_at');
    t.primary(['course_id', 'subject_type', 'subject_id']);
  });
  // A learner's copy of the file on an 'agent_file' page. No row = they have not changed the instructor's starting text.
  await create('course_page_files', (t) => {
    fk(t, 'user_id', 'users', 'CASCADE'); fk(t, 'page_id', 'course_pages', 'CASCADE');
    txt(t, 'content').notNullable(); ts(t, 'updated_at');
    t.primary(['user_id', 'page_id']);
  });
  await create('course_progress', (t) => {
    fk(t, 'course_id', 'courses', 'CASCADE'); fk(t, 'user_id', 'users', 'CASCADE'); fk(t, 'page_id', 'course_pages', 'CASCADE');
    ts(t, 'completed_at');
    t.primary(['user_id', 'page_id']);
  });
  await create('assessments', (t) => {
    t.increments('id');
    fk(t, 'course_id', 'courses', 'CASCADE');
    fk(t, 'page_id', 'course_pages', 'SET NULL', { nullable: true });
    t.string('title', 255).notNullable();
    t.integer('pass_pct').notNullable().defaultTo(70); // legacy: pass_score replaces it
    t.integer('max_attempts').notNullable().defaultTo(0);
    t.string('mode', 32).notNullable().defaultTo('unlimited'); // unscored | limited (best score counts) | unlimited
    t.integer('pass_score'); // minimum percent to pass; NULL = none. Only unscored/unlimited, and only when every question is auto-scored
  });
  // type: mcq | tf | text | exercise (agentic-coding exercise; code_spec_json holds starter files, brief, rubric, checks).
  await create('questions', (t) => {
    t.increments('id');
    fk(t, 'assessment_id', 'assessments', 'CASCADE');
    flag(t, 'position'); t.string('type', 32).notNullable(); txt(t, 'prompt').notNullable();
    txtd(t, 'options_json', '[]'); txtd(t, 'answer_key_json', 'null');
    t.integer('points').notNullable().defaultTo(1); txtd(t, 'code_spec_json', '{}');
  });
  await create('attempts', (t) => {
    t.increments('id');
    fk(t, 'assessment_id', 'assessments', 'CASCADE'); fk(t, 'user_id', 'users', 'CASCADE');
    t.string('status', 32).notNullable().defaultTo('in_progress'); t.double('score');
    ts(t, 'started_at'); t.bigInteger('submitted_at');
    t.index(['user_id', 'assessment_id'], 'attempts_user');
  });
  await create('answers', (t) => {
    fk(t, 'attempt_id', 'attempts', 'CASCADE'); fk(t, 'question_id', 'questions', 'CASCADE');
    txtd(t, 'response_json', 'null'); t.double('score'); txt(t, 'feedback');
    fk(t, 'graded_by', 'users', 'SET NULL', { nullable: true });
    t.primary(['attempt_id', 'question_id']);
  });

  // SAML groups from the user's last login, kept so group-based course enrollment can be resolved without the IdP.
  await create('user_saml_groups', (t) => {
    fk(t, 'user_id', 'users', 'CASCADE');
    t.string('group_value', 255).notNullable();
    t.primary(['user_id', 'group_value']);
  });
  // A learner's private notes on one course page (the "notes" tutor subpanel).
  await create('course_notes', (t) => {
    fk(t, 'user_id', 'users', 'CASCADE'); fk(t, 'page_id', 'course_pages', 'CASCADE');
    txtd(t, 'text', ''); ts(t, 'updated_at');
    t.primary(['user_id', 'page_id']);
  });
  // An agentic-coding exercise gives each attempt its own workspace (a normal project owned by the learner). On submit the workspace and
  // the agent transcript are copied to `snapshot` (relative to the data dir) as evidence.
  await create('exercise_workspaces', (t) => {
    fk(t, 'attempt_id', 'attempts', 'CASCADE'); fk(t, 'question_id', 'questions', 'CASCADE');
    fk(t, 'project_id', 'projects', 'SET NULL', { nullable: true });
    txt(t, 'snapshot'); txt(t, 'policy_json');
    t.primary(['attempt_id', 'question_id']);
  });
  // Keys for the provider API (/v1). Only a hash is kept; the key is shown once, when it is created.
  await create('api_keys', (t) => {
    t.increments('id');
    fk(t, 'user_id', 'users', 'CASCADE');
    t.string('name', 255).notNullable();
    t.string('prefix', 64).notNullable(); // first characters of the key, so a person can recognise it in a list
    t.string('key_hash', 128).notNullable().unique();
    txt(t, 'model_ids'); // JSON array of models.id this key may use; NULL = every model its owner may use
    t.bigInteger('expires_at'); t.bigInteger('last_used_at'); // NULL = never / not yet
    ts(t, 'created_at');
    t.index(['user_id'], 'api_keys_user');
  });

  if (engine === 'mariadb') for (const [table, col, dflt] of textDefaults) await knex.raw(`ALTER TABLE ?? ALTER COLUMN ?? SET DEFAULT '${dflt}'`, [table, col]);
  await partialUniques(knex, engine);
}

// Uniqueness that applies to only some rows (e.g. usernames of local users). SQLite and PostgreSQL have partial indexes. MariaDB does not,
// so a virtual generated column holds the key for the matching rows and NULL for the rest (NULLs never collide), and carries the unique index.
async function partialUniques(knex, engine) {
  if (engine !== 'mariadb') {
    await knex.raw("CREATE UNIQUE INDEX users_local_username ON users (username) WHERE source = 'local'");
    await knex.raw("CREATE UNIQUE INDEX users_saml_id ON users (idp_entity_id, name_id) WHERE source = 'saml'");
    await knex.raw("CREATE UNIQUE INDEX mcp_tenant_name ON mcp_servers (name) WHERE scope = 'tenant'");
    await knex.raw("CREATE UNIQUE INDEX mcp_user_name ON mcp_servers (user_id, name) WHERE scope = 'user'");
    return;
  }
  await knex.raw("ALTER TABLE users ADD COLUMN uq_local_username VARCHAR(255) AS (CASE WHEN source = 'local' THEN username END) VIRTUAL, " +
    "ADD COLUMN uq_saml_id VARCHAR(700) AS (CASE WHEN source = 'saml' THEN CONCAT(idp_entity_id, CHAR(10), name_id) END) VIRTUAL, " +
    'ADD UNIQUE INDEX users_local_username (uq_local_username), ADD UNIQUE INDEX users_saml_id (uq_saml_id)');
  await knex.raw("ALTER TABLE mcp_servers ADD COLUMN uq_tenant_name VARCHAR(255) AS (CASE WHEN scope = 'tenant' THEN name END) VIRTUAL, " +
    "ADD COLUMN uq_user_name VARCHAR(300) AS (CASE WHEN scope = 'user' THEN CONCAT(user_id, ':', name) END) VIRTUAL, " +
    'ADD UNIQUE INDEX mcp_tenant_name (uq_tenant_name), ADD UNIQUE INDEX mcp_user_name (uq_user_name)');
}

export async function down(knex) {
  // Children before parents.
  for (const t of ['api_keys', 'exercise_workspaces', 'course_notes', 'user_saml_groups', 'answers', 'attempts', 'questions', 'assessments',
    'course_progress', 'course_page_files', 'course_enrollments', 'memory_entries', 'attachments', 'mcp_user_prefs', 'mcp_servers',
    'tutorial_status', 'usage', 'skills', 'audit', 'checkpoint_events', 'checkpoint_marks', 'messages', 'conversations', 'course_pages',
    'course_modules', 'course_instructors', 'courses', 'projects', 'saml_requests', 'saml_replay', 'relay_states', 'webauthn_credentials',
    'recovery_codes', 'sessions', 'model_badges', 'models', 'badges', 'badge_categories', 'providers', 'settings', 'group_role_map',
    'user_roles', 'role_permissions', 'roles', 'users']) await knex.schema.dropTableIfExists(t);
}
