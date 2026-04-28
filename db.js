const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'chat.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  username TEXT NOT NULL,
  display_name TEXT NOT NULL,
  avatar_color TEXT NOT NULL,
  is_bot INTEGER NOT NULL DEFAULT 0,
  bot_persona TEXT,
  status_text TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(workspace_id, username),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  topic TEXT,
  is_private INTEGER NOT NULL DEFAULT 0,
  is_dm INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE(workspace_id, name),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS channel_members (
  channel_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (channel_id, user_id),
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, created_at);

CREATE TABLE IF NOT EXISTS message_reactions (
  message_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  emoji TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji),
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_reactions_msg ON message_reactions(message_id);

CREATE TABLE IF NOT EXISTS scenarios (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  definition TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS app_state (
  workspace_id TEXT PRIMARY KEY,
  active_scenario_id TEXT,
  updated_at INTEGER,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS cohorts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  scenario_id TEXT NOT NULL,
  name TEXT NOT NULL,
  join_code TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  ends_at INTEGER,
  closed_at INTEGER,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS cohort_members (
  cohort_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'participant',
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (cohort_id, user_id),
  FOREIGN KEY (cohort_id) REFERENCES cohorts(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS game_runs (
  id TEXT PRIMARY KEY,
  cohort_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  scenario_id TEXT NOT NULL,
  score INTEGER NOT NULL DEFAULT 0,
  current_task_id TEXT,
  hints_used INTEGER NOT NULL DEFAULT 0,
  state_json TEXT,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  last_activity_at INTEGER,
  UNIQUE (cohort_id, user_id),
  FOREIGN KEY (cohort_id) REFERENCES cohorts(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS task_attempts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  attempt_text TEXT NOT NULL,
  is_correct INTEGER NOT NULL DEFAULT 0,
  points_delta INTEGER NOT NULL DEFAULT 0,
  was_first_blood INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (run_id) REFERENCES game_runs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_attempts_run ON task_attempts(run_id);
CREATE INDEX IF NOT EXISTS idx_attempts_task ON task_attempts(task_id);
`);

// Idempotent migrations for older databases.
function addColumnIfMissing(table, name, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === name)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
  }
}
addColumnIfMissing('scenarios', 'source', "TEXT NOT NULL DEFAULT 'local'");
addColumnIfMissing('scenarios', 'source_ref', 'TEXT');
addColumnIfMissing('scenarios', 'source_sha', 'TEXT');
addColumnIfMissing('scenarios', 'briefing', 'TEXT');
addColumnIfMissing('scenarios', 'updated_at', 'INTEGER');

addColumnIfMissing('messages', 'parent_id', 'TEXT');
addColumnIfMissing('messages', 'reply_count', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('messages', 'last_reply_at', 'INTEGER');
db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages(parent_id);`);

addColumnIfMissing('channels', 'cohort_id', 'TEXT');
addColumnIfMissing('channels', 'display_name', 'TEXT');
addColumnIfMissing('channels', 'posting_policy', "TEXT NOT NULL DEFAULT 'open'");

db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_scenarios_source_ref
         ON scenarios(source_ref) WHERE source_ref IS NOT NULL;`);

function bootstrap() {
  const existing = db.prepare('SELECT id FROM workspaces LIMIT 1').get();
  if (existing) return existing.id;

  const wsId = 'ws_' + Math.random().toString(36).slice(2, 10);
  const now = Date.now();
  db.prepare('INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)').run(
    wsId,
    process.env.DEFAULT_WORKSPACE_NAME || 'CTF Workspace',
    now
  );

  // No default channels seeded. Cohort channels are materialized on cohort
  // creation; participants land on the join screen until they're in a cohort.
  return wsId;
}

const defaultWorkspaceId = bootstrap();

module.exports = { db, defaultWorkspaceId };
