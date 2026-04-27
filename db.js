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

  const channels = [
    { name: 'general', topic: 'Company-wide announcements and work-based matters' },
    { name: 'random', topic: 'Non-work banter and water cooler conversation' },
    { name: 'incident-response', topic: 'Active incident coordination' },
  ];
  for (const c of channels) {
    db.prepare(
      'INSERT INTO channels (id, workspace_id, name, topic, is_private, is_dm, created_at) VALUES (?, ?, ?, ?, 0, 0, ?)'
    ).run('ch_' + Math.random().toString(36).slice(2, 10), wsId, c.name, c.topic, now);
  }
  return wsId;
}

const defaultWorkspaceId = bootstrap();

module.exports = { db, defaultWorkspaceId };
