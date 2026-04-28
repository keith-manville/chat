const path = require('path');
const http = require('http');
const express = require('express');
const cookieParser = require('cookie-parser');
const { Server } = require('socket.io');

const { db, defaultWorkspaceId } = require('./db');
const { newId, pickAvatarColor } = require('./lib/util');
const personas = require('./lib/personas');
const scenarios = require('./lib/scenarios');
const github = require('./lib/github');
const cohortsLib = require('./lib/cohorts');
const tasks = require('./lib/tasks');

const SCENARIO_REPO_DEFAULT = process.env.SCENARIO_REPO || '';
const SCENARIO_REPO_REF_DEFAULT = process.env.SCENARIO_REPO_REF || 'main';
const SCENARIO_REPO_PATH_DEFAULT = process.env.SCENARIO_REPO_PATH || 'scenarios';
const SCENARIO_REPO_TOKEN_DEFAULT = process.env.SCENARIO_REPO_TOKEN || '';

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, credentials: true } });

app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'changeme-admin';

// ---------- helpers ----------

function getUserBySession(req) {
  const sid = req.cookies && req.cookies.sid;
  if (!sid) return null;
  return db.prepare('SELECT * FROM users WHERE id = ?').get(sid);
}

function requireUser(req, res, next) {
  const user = getUserBySession(req);
  if (!user) return res.status(401).json({ error: 'not_authenticated' });
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  const tok = req.headers['x-admin-token'] || (req.cookies && req.cookies.admin_token);
  if (tok !== ADMIN_TOKEN) return res.status(403).json({ error: 'forbidden' });
  next();
}

function userPublic(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    avatarColor: u.avatar_color,
    isBot: !!u.is_bot,
    statusText: u.status_text || '',
  };
}

function channelPublic(c) {
  return {
    id: c.id,
    name: c.name,
    displayName: c.display_name || c.name,
    topic: c.topic || '',
    isPrivate: !!c.is_private,
    isDm: !!c.is_dm,
    cohortId: c.cohort_id || null,
    postingPolicy: c.posting_policy || 'open',
  };
}

function listChannelsForUser(userId, _workspaceId) {
  return cohortsLib.listVisibleChannels(userId);
}

function ensureMembership(channelId, userId) {
  const exists = db
    .prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?')
    .get(channelId, userId);
  if (!exists) {
    db.prepare('INSERT INTO channel_members (channel_id, user_id, joined_at) VALUES (?, ?, ?)').run(
      channelId,
      userId,
      Date.now()
    );
  }
}

function findOrCreateDm(workspaceId, userA, userB) {
  const ids = [userA, userB].sort();
  const dmName = `dm:${ids[0]}:${ids[1]}`;
  let ch = db
    .prepare('SELECT * FROM channels WHERE workspace_id = ? AND name = ?')
    .get(workspaceId, dmName);
  if (!ch) {
    const id = newId('ch');
    db.prepare(
      'INSERT INTO channels (id, workspace_id, name, topic, is_private, is_dm, created_at) VALUES (?, ?, ?, ?, 1, 1, ?)'
    ).run(id, workspaceId, dmName, '', Date.now());
    ch = db.prepare('SELECT * FROM channels WHERE id = ?').get(id);
    ensureMembership(ch.id, userA);
    ensureMembership(ch.id, userB);
  }
  return ch;
}

function presenceSet() {
  // socket.io adapter rooms; we track explicitly via a Set we maintain
  return globalPresence;
}
const globalPresence = new Map(); // userId -> { count, user }

function presenceList() {
  return Array.from(globalPresence.values()).map((v) => userPublic(v.user));
}

// ---------- core post helper (used by REST, sockets, scenarios) ----------

async function postMessage({ channelId, userId, body, parentId = null, bypassPolicy = false }) {
  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!channel || !user) throw new Error('channel_or_user_missing');

  // Posting policy enforcement (only for human-driven posts; engine bypasses).
  if (!bypassPolicy && !user.is_bot) {
    const policy = channel.posting_policy || 'open';
    if (policy === 'engine' || policy === 'read_only') {
      throw new Error('channel_is_read_only');
    }
    if (policy === 'proctor') {
      // Proctors don't sign in as chat users in Swing 1; effectively bot/admin only.
      throw new Error('proctor_only');
    }
  }

  let parent = null;
  if (parentId) {
    parent = db.prepare('SELECT * FROM messages WHERE id = ? AND channel_id = ?').get(parentId, channelId);
    if (!parent) throw new Error('parent_message_missing');
    // If the "parent" is itself a reply, normalize to the thread root.
    if (parent.parent_id) {
      parent = db.prepare('SELECT * FROM messages WHERE id = ?').get(parent.parent_id);
      if (!parent) throw new Error('thread_root_missing');
      parentId = parent.id;
    }
  }

  const id = newId('m');
  const created = Date.now();
  db.prepare(
    'INSERT INTO messages (id, channel_id, user_id, body, parent_id, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, channelId, userId, body, parentId, created);

  const msg = {
    id,
    channelId,
    body,
    parentId: parentId || null,
    createdAt: created,
    user: userPublic(user),
    replyCount: 0,
    lastReplyAt: null,
    reactions: [],
  };

  if (parentId) {
    // Update parent counters and emit thread events.
    const updated = db
      .prepare(
        `UPDATE messages
            SET reply_count = reply_count + 1,
                last_reply_at = ?
          WHERE id = ?`
      )
      .run(created, parentId);
    if (updated.changes) {
      const root = db.prepare('SELECT reply_count, last_reply_at FROM messages WHERE id = ?').get(parentId);
      io.to(`thread:${parentId}`).emit('thread:reply', msg);
      io.to(`channel:${channelId}`).emit('thread:update', {
        messageId: parentId,
        channelId,
        replyCount: root.reply_count,
        lastReplyAt: root.last_reply_at,
      });
    }
  } else {
    io.to(`channel:${channelId}`).emit('message', msg);
  }

  return { msg, channel, user, parent };
}

function reactionsForMessages(messageIds) {
  if (!messageIds.length) return new Map();
  const placeholders = messageIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT message_id, emoji, user_id
         FROM message_reactions
        WHERE message_id IN (${placeholders})
        ORDER BY created_at ASC`
    )
    .all(...messageIds);
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r.message_id)) out.set(r.message_id, []);
    const list = out.get(r.message_id);
    let entry = list.find((e) => e.emoji === r.emoji);
    if (!entry) {
      entry = { emoji: r.emoji, userIds: [] };
      list.push(entry);
    }
    entry.userIds.push(r.user_id);
  }
  return out;
}

function attachReactions(messages) {
  const reactions = reactionsForMessages(messages.map((m) => m.id));
  for (const m of messages) {
    m.reactions = reactions.get(m.id) || [];
  }
  return messages;
}

// ---------- REST API ----------

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.post('/api/auth/login', (req, res) => {
  const { username, displayName } = req.body || {};
  if (!username || !/^[a-zA-Z0-9_.-]{2,32}$/.test(username)) {
    return res.status(400).json({ error: 'invalid_username' });
  }
  let user = db
    .prepare('SELECT * FROM users WHERE workspace_id = ? AND username = ?')
    .get(defaultWorkspaceId, username);
  if (!user) {
    const id = newId('u');
    db.prepare(
      'INSERT INTO users (id, workspace_id, username, display_name, avatar_color, is_bot, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)'
    ).run(id, defaultWorkspaceId, username, displayName || username, pickAvatarColor(username), Date.now());
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  }
  res.cookie('sid', user.id, { httpOnly: true, sameSite: 'lax' });
  // Don't auto-join channels — participants pick up channels by joining a cohort.
  const cohort = cohortsLib.getUserPrimaryCohort(user.id);
  res.json({ user: userPublic(user), cohort: cohort || null });
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('sid');
  res.json({ ok: true });
});

app.get('/api/me', requireUser, (req, res) => {
  const cohort = cohortsLib.getUserPrimaryCohort(req.user.id);
  res.json({
    user: userPublic(req.user),
    workspace: { id: defaultWorkspaceId, name: db.prepare('SELECT name FROM workspaces WHERE id = ?').get(defaultWorkspaceId).name },
    cohort: cohort || null,
  });
});

app.get('/api/channels', requireUser, (req, res) => {
  const channels = listChannelsForUser(req.user.id, defaultWorkspaceId).map(channelPublic);
  res.json({ channels });
});

app.post('/api/channels', requireUser, (req, res) => {
  const { name, topic } = req.body || {};
  if (!name || !/^[a-z0-9-]{2,40}$/.test(name)) return res.status(400).json({ error: 'invalid_name' });
  const exists = db
    .prepare('SELECT id FROM channels WHERE workspace_id = ? AND name = ?')
    .get(defaultWorkspaceId, name);
  if (exists) return res.status(409).json({ error: 'exists', channelId: exists.id });
  const id = newId('ch');
  db.prepare(
    'INSERT INTO channels (id, workspace_id, name, topic, is_private, is_dm, created_at) VALUES (?, ?, ?, ?, 0, 0, ?)'
  ).run(id, defaultWorkspaceId, name, topic || '', Date.now());
  const ch = db.prepare('SELECT * FROM channels WHERE id = ?').get(id);
  ensureMembership(ch.id, req.user.id);
  io.emit('channel:new', channelPublic(ch));
  res.json({ channel: channelPublic(ch) });
});

function rowToMessage(r) {
  return {
    id: r.id,
    channelId: r.channel_id,
    body: r.body,
    parentId: r.parent_id || null,
    replyCount: r.reply_count || 0,
    lastReplyAt: r.last_reply_at || null,
    createdAt: r.created_at,
    user: {
      id: r.uid,
      username: r.username,
      displayName: r.display_name,
      avatarColor: r.avatar_color,
      isBot: !!r.is_bot,
      statusText: r.status_text || '',
    },
  };
}

const MSG_SELECT = `m.id, m.channel_id, m.body, m.parent_id, m.reply_count, m.last_reply_at, m.created_at,
                    u.id AS uid, u.username, u.display_name, u.avatar_color, u.is_bot, u.status_text`;

app.get('/api/channels/:id/messages', requireUser, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const before = req.query.before ? parseInt(req.query.before, 10) : null;
  let rows;
  if (before) {
    rows = db
      .prepare(
        `SELECT ${MSG_SELECT}
         FROM messages m JOIN users u ON u.id = m.user_id
         WHERE m.channel_id = ? AND m.parent_id IS NULL AND m.created_at < ?
         ORDER BY m.created_at DESC LIMIT ?`
      )
      .all(req.params.id, before, limit);
  } else {
    rows = db
      .prepare(
        `SELECT ${MSG_SELECT}
         FROM messages m JOIN users u ON u.id = m.user_id
         WHERE m.channel_id = ? AND m.parent_id IS NULL
         ORDER BY m.created_at DESC LIMIT ?`
      )
      .all(req.params.id, limit);
  }
  const messages = attachReactions(rows.reverse().map(rowToMessage));
  res.json({ messages });
});

app.get('/api/messages/:id/thread', requireUser, (req, res) => {
  const rootRow = db
    .prepare(
      `SELECT ${MSG_SELECT}
       FROM messages m JOIN users u ON u.id = m.user_id
       WHERE m.id = ? AND m.parent_id IS NULL`
    )
    .get(req.params.id);
  if (!rootRow) return res.status(404).json({ error: 'not_found' });
  const replyRows = db
    .prepare(
      `SELECT ${MSG_SELECT}
       FROM messages m JOIN users u ON u.id = m.user_id
       WHERE m.parent_id = ?
       ORDER BY m.created_at ASC`
    )
    .all(req.params.id);
  const root = rowToMessage(rootRow);
  const replies = replyRows.map(rowToMessage);
  attachReactions([root, ...replies]);
  res.json({ root, replies });
});

app.get('/api/users', requireUser, (_req, res) => {
  const rows = db
    .prepare('SELECT * FROM users WHERE workspace_id = ? ORDER BY is_bot ASC, display_name ASC')
    .all(defaultWorkspaceId);
  const presence = new Set(Array.from(globalPresence.keys()));
  res.json({
    users: rows.map((u) => ({ ...userPublic(u), online: presence.has(u.id) || !!u.is_bot })),
  });
});

app.post('/api/dms', requireUser, (req, res) => {
  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'missing_user' });
  const other = db.prepare('SELECT * FROM users WHERE id = ? AND workspace_id = ?').get(userId, defaultWorkspaceId);
  if (!other) return res.status(404).json({ error: 'user_not_found' });
  const ch = findOrCreateDm(defaultWorkspaceId, req.user.id, other.id);
  res.json({ channel: channelPublic(ch), peer: userPublic(other) });
});

// ---------- Cohort join ----------

app.post('/api/cohorts/join', requireUser, async (req, res) => {
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ error: 'code_required' });
  try {
    const result = cohortsLib.joinCohort({ code, userId: req.user.id });
    // Populate the cohort's #instructions with the scenario's instructions on first creation.
    populateInstructionsIfEmpty(result.cohort);
    // Fire any 'start' tasks for this brand-new run (catch-up mode for late joiners).
    if (result.isNewRun) {
      await fireStartTasksForRun(result.run);
    }
    // Force the user's socket(s) to refresh channels.
    io.to(`user:${req.user.id}`).emit('cohort:joined', { cohort: result.cohort });
    res.json({ cohort: result.cohort, isNewRun: result.isNewRun });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- Scoreboard ----------

app.get('/api/scoreboard/:cohortId', requireUser, (req, res) => {
  // Visibility check: user must be a member of the cohort, or admin.
  const member = cohortsLib.getMembership(req.params.cohortId, req.user.id);
  const isAdmin = (req.cookies && req.cookies.admin_token) === ADMIN_TOKEN;
  if (!member && !isAdmin) return res.status(403).json({ error: 'not_a_member' });
  const cohort = cohortsLib.getCohort(req.params.cohortId);
  if (!cohort) return res.status(404).json({ error: 'cohort_not_found' });
  const runs = cohortsLib.listRuns(cohort.id).map((r, idx) => ({
    rank: idx + 1,
    userId: r.user_id,
    displayName: r.display_name,
    username: r.username,
    avatarColor: r.avatar_color,
    score: r.score,
    hintsUsed: r.hints_used || 0,
    lastActivityAt: r.last_activity_at,
    completed: !!r.completed_at,
  }));
  res.json({ cohort, runs });
});

// ---------- Admin / persona / scenario API ----------

app.post('/api/admin/login', (req, res) => {
  const { token } = req.body || {};
  if (token !== ADMIN_TOKEN) return res.status(403).json({ error: 'forbidden' });
  res.cookie('admin_token', token, { httpOnly: true, sameSite: 'lax' });
  res.json({ ok: true });
});

app.get('/api/admin/personas', requireAdmin, (_req, res) => {
  res.json({ personas: personas.listBots(defaultWorkspaceId).map(userPublic) });
});

app.post('/api/admin/personas', requireAdmin, (req, res) => {
  const { username, displayName, persona } = req.body || {};
  if (!username || !/^[a-zA-Z0-9_.-]{2,32}$/.test(username)) return res.status(400).json({ error: 'invalid_username' });
  const bot = personas.ensureBot({
    workspaceId: defaultWorkspaceId,
    username,
    displayName,
    persona,
  });
  // Auto-join public channels
  const publicChans = db
    .prepare('SELECT id FROM channels WHERE workspace_id = ? AND is_private = 0')
    .all(defaultWorkspaceId);
  for (const c of publicChans) ensureMembership(c.id, bot.id);
  res.json({ persona: userPublic(bot) });
});

app.post('/api/admin/post', requireAdmin, async (req, res) => {
  const { channel, username, body } = req.body || {};
  if (!channel || !username || !body) return res.status(400).json({ error: 'missing_fields' });
  const ch = db.prepare('SELECT * FROM channels WHERE workspace_id = ? AND name = ?').get(defaultWorkspaceId, channel);
  const user = db.prepare('SELECT * FROM users WHERE workspace_id = ? AND username = ?').get(defaultWorkspaceId, username);
  if (!ch || !user) return res.status(404).json({ error: 'channel_or_user_missing' });
  const result = await postMessage({ channelId: ch.id, userId: user.id, body });
  res.json({ ok: true, message: result.msg });
});

app.get('/api/admin/scenarios', requireAdmin, (_req, res) => {
  res.json({ scenarios: scenarios.listScenarios(defaultWorkspaceId) });
});

app.get('/api/admin/scenarios/:id', requireAdmin, (req, res) => {
  const sc = scenarios.getScenario(req.params.id);
  if (!sc) return res.status(404).json({ error: 'not_found' });
  res.json({ scenario: sc });
});

app.post('/api/admin/scenarios', requireAdmin, (req, res) => {
  const { id, name, description, briefing, definition } = req.body || {};
  if (!name || !definition) return res.status(400).json({ error: 'missing_fields' });
  const sid = scenarios.saveLocalScenario({
    id,
    workspaceId: defaultWorkspaceId,
    name,
    description,
    briefing,
    definition,
  });
  res.json({ id: sid });
});

app.delete('/api/admin/scenarios/:id', requireAdmin, (req, res) => {
  // If we deleted the active scenario, clear it.
  const active = scenarios.getActiveScenario(defaultWorkspaceId);
  if (active && active.id === req.params.id) {
    scenarios.setActiveScenario({ workspaceId: defaultWorkspaceId, scenarioId: null });
  }
  scenarios.deleteScenario(req.params.id);
  res.json({ ok: true });
});

// ---- Active scenario / state ----

app.get('/api/admin/state', requireAdmin, (_req, res) => {
  const active = scenarios.getActiveScenario(defaultWorkspaceId);
  res.json({
    activeScenario: active
      ? {
          id: active.id,
          name: active.name,
          description: active.description,
          briefing: active.briefing,
          source: active.source,
          sourceRef: active.sourceRef,
        }
      : null,
    repoConfig: {
      repo: SCENARIO_REPO_DEFAULT,
      ref: SCENARIO_REPO_REF_DEFAULT,
      path: SCENARIO_REPO_PATH_DEFAULT,
      hasEnvToken: !!SCENARIO_REPO_TOKEN_DEFAULT,
    },
    aiEnabled: personas.isAiEnabled(),
    aiProvider: personas.getProvider(),
    aiModel: personas.getModel(),
  });
});

app.post('/api/admin/scenarios/:id/load', requireAdmin, (req, res) => {
  const sc = scenarios.getScenario(req.params.id);
  if (!sc) return res.status(404).json({ error: 'not_found' });
  scenarios.setActiveScenario({ workspaceId: defaultWorkspaceId, scenarioId: sc.id });
  // Ensure personas exist + are joined to all public channels so they can speak.
  const bots = scenarios.ensureScenarioPersonas({ workspaceId: defaultWorkspaceId, scenario: sc });
  const publicChans = db
    .prepare('SELECT id FROM channels WHERE workspace_id = ? AND is_private = 0')
    .all(defaultWorkspaceId);
  for (const bot of bots) {
    for (const c of publicChans) ensureMembership(c.id, bot.id);
  }
  res.json({
    ok: true,
    activeScenario: { id: sc.id, name: sc.name, description: sc.description },
    personasReady: bots.length,
  });
});

app.post('/api/admin/scenarios/unload', requireAdmin, (_req, res) => {
  scenarios.setActiveScenario({ workspaceId: defaultWorkspaceId, scenarioId: null });
  res.json({ ok: true });
});

// ---- GitHub sync ----

app.post('/api/admin/github/sync', requireAdmin, async (req, res) => {
  const repo = (req.body && req.body.repo) || SCENARIO_REPO_DEFAULT;
  const ref = (req.body && req.body.ref) || SCENARIO_REPO_REF_DEFAULT;
  const dirPath = (req.body && req.body.path) || SCENARIO_REPO_PATH_DEFAULT;
  const token = (req.body && req.body.token) || SCENARIO_REPO_TOKEN_DEFAULT;
  if (!repo) return res.status(400).json({ error: 'repo required (owner/name)' });
  if (!token) return res.status(400).json({ error: 'token required (PAT or env SCENARIO_REPO_TOKEN)' });

  try {
    const results = await github.pullScenarios({ repo, ref, path: dirPath, token });
    let added = 0;
    let updated = 0;
    let unchanged = 0;
    const errors = [];
    for (const r of results) {
      if (!r.ok) {
        errors.push({ path: r.path, error: r.error });
        continue;
      }
      const out = scenarios.upsertGithubScenario({
        workspaceId: defaultWorkspaceId,
        name: r.scenario.name,
        description: r.scenario.description,
        briefing: r.scenario.briefing,
        definition: r.scenario.definition,
        sourceRef: r.sourceRef,
        sourceSha: r.sourceSha,
      });
      if (out.status === 'added') added++;
      else if (out.status === 'updated') updated++;
      else unchanged++;
    }
    res.json({ ok: true, repo, ref, path: dirPath, added, updated, unchanged, errors });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- Admin: cohorts ----------

app.get('/api/admin/cohorts', requireAdmin, (_req, res) => {
  res.json({ cohorts: cohortsLib.listCohorts(defaultWorkspaceId) });
});

app.get('/api/admin/cohorts/:id', requireAdmin, (req, res) => {
  const cohort = cohortsLib.getCohort(req.params.id);
  if (!cohort) return res.status(404).json({ error: 'not_found' });
  const members = cohortsLib.listMembers(cohort.id);
  const runs = cohortsLib.listRuns(cohort.id);
  res.json({ cohort, members, runs });
});

app.post('/api/admin/cohorts', requireAdmin, (req, res) => {
  const { name, scenarioId } = req.body || {};
  if (!scenarioId) return res.status(400).json({ error: 'scenarioId required' });
  try {
    const cohort = cohortsLib.createCohort({
      workspaceId: defaultWorkspaceId,
      scenarioId,
      name,
    });
    res.json({ cohort });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/admin/cohorts/:id/announce', requireAdmin, async (req, res) => {
  const { body } = req.body || {};
  if (!body || !body.trim()) return res.status(400).json({ error: 'body_required' });
  const cohort = cohortsLib.getCohort(req.params.id);
  if (!cohort) return res.status(404).json({ error: 'cohort_not_found' });
  const announce = cohortsLib.getCohortChannel({
    cohortId: cohort.id,
    displayName: 'announcements',
  });
  if (!announce) return res.status(404).json({ error: 'announcements_channel_missing' });
  // Use a "Proctor" bot user so the post has a recognizable author.
  const proctor = personas.ensureBot({
    workspaceId: defaultWorkspaceId,
    username: 'proctor',
    displayName: 'Proctor',
    persona: 'You are the event proctor.',
  });
  cohortsLib.ensureMembership(announce.id, proctor.id);
  await postMessage({ channelId: announce.id, userId: proctor.id, body: body.trim(), bypassPolicy: true });
  res.json({ ok: true });
});

const activeRuns = new Map(); // scenarioId -> handle
app.post('/api/admin/scenarios/:id/run', requireAdmin, async (req, res) => {
  const sc = scenarios.getScenario(req.params.id);
  if (!sc) return res.status(404).json({ error: 'not_found' });
  if (activeRuns.has(sc.id)) {
    activeRuns.get(sc.id).stop();
  }
  const log = [];
  const handle = scenarios.runScenario({
    scenario: sc,
    workspaceId: defaultWorkspaceId,
    post: async (ev) => {
      const ch = db.prepare('SELECT * FROM channels WHERE workspace_id = ? AND name = ?').get(defaultWorkspaceId, ev.channel);
      const user = db.prepare('SELECT * FROM users WHERE workspace_id = ? AND username = ?').get(defaultWorkspaceId, ev.username);
      if (!ch || !user) throw new Error(`channel ${ev.channel} or user ${ev.username} missing`);
      ensureMembership(ch.id, user.id);
      await postMessage({ channelId: ch.id, userId: user.id, body: ev.body });
    },
    onLog: (entry) => log.push(entry),
  });
  activeRuns.set(sc.id, handle);
  res.json({ ok: true, scheduled: (sc.definition.events || []).length });
});

app.post('/api/admin/scenarios/:id/stop', requireAdmin, (req, res) => {
  const handle = activeRuns.get(req.params.id);
  if (handle) handle.stop();
  activeRuns.delete(req.params.id);
  res.json({ ok: true });
});

// ---------- Cohort + task helpers ----------

function populateInstructionsIfEmpty(cohort) {
  const channel = cohortsLib.getCohortChannel({
    cohortId: cohort.id,
    displayName: 'instructions',
  });
  if (!channel) return;
  const existing = db.prepare('SELECT 1 FROM messages WHERE channel_id = ? LIMIT 1').get(channel.id);
  if (existing) return;
  const sc = scenarios.getScenario(cohort.scenarioId);
  if (!sc) return;
  const instr = sc.definition && sc.definition.instructions;
  if (!instr) return;

  const proctor = personas.ensureBot({
    workspaceId: defaultWorkspaceId,
    username: 'proctor',
    displayName: 'Proctor',
    persona: 'You are the event proctor.',
  });
  cohortsLib.ensureMembership(channel.id, proctor.id);

  const lines = [];
  if (instr.title) lines.push(`*${instr.title}*`);
  if (instr.body) lines.push(instr.body);
  if (Array.isArray(instr.links) && instr.links.length) {
    lines.push('');
    lines.push('Links:');
    for (const l of instr.links) {
      lines.push(`• ${l.label || l.url}: ${l.url}`);
    }
  }
  // Suppress posting policy for the engine.
  postMessage({
    channelId: channel.id,
    userId: proctor.id,
    body: lines.join('\n'),
    bypassPolicy: true,
  }).catch((err) => console.warn('[cohort] instructions seed failed:', err.message));
}

async function fireStartTasksForRun(run) {
  const sc = scenarios.getScenario(run.scenario_id);
  if (!sc) return 0;
  return tasks.fireTasks({
    run,
    scenario: sc,
    trigger: 'start',
    post: async ({ channel, persona, body }) => {
      cohortsLib.ensureMembership(channel.id, persona.id);
      await postMessage({ channelId: channel.id, userId: persona.id, body, bypassPolicy: true });
    },
    onError: (e) => console.warn('[tasks] fire error:', e.error),
  });
}

async function fireFollowUpTasks({ run, followUps }) {
  for (const t of followUps) {
    const sc = scenarios.getScenario(run.scenario_id);
    await tasks.fireTask({
      run,
      scenario: sc,
      task: t,
      post: async ({ channel, persona, body }) => {
        cohortsLib.ensureMembership(channel.id, persona.id);
        await postMessage({ channelId: channel.id, userId: persona.id, body, bypassPolicy: true });
      },
    });
  }
}

function emitScoreUpdate(cohortId) {
  const runs = cohortsLib.listRuns(cohortId).map((r, idx) => ({
    rank: idx + 1,
    userId: r.user_id,
    displayName: r.display_name,
    username: r.username,
    avatarColor: r.avatar_color,
    score: r.score,
    hintsUsed: r.hints_used || 0,
    lastActivityAt: r.last_activity_at,
    completed: !!r.completed_at,
  }));
  io.to(`cohort:${cohortId}:scoreboard`).emit('scoreboard:update', { cohortId, runs });
}

/**
 * Hook: a participant just sent `body` into a persona DM. If there's an active
 * task for that run + persona, grade it and fire on_correct/on_wrong + follow-ups.
 * Returns true if handled (grader claimed it).
 */
async function maybeGradePersonaDmReply({ user, channel, body }) {
  if (!channel.is_dm || !channel.cohort_id) return false;
  // Find the persona on the other side of this DM.
  const other = db
    .prepare(
      `SELECT u.* FROM users u
         JOIN channel_members m ON m.user_id = u.id
        WHERE m.channel_id = ? AND u.is_bot = 1 AND u.id != ?`
    )
    .get(channel.id, user.id);
  if (!other) return false;
  const run = cohortsLib.getRun(channel.cohort_id, user.id);
  if (!run) return false;
  const sc = scenarios.getScenario(run.scenario_id);
  if (!sc) return false;

  const result = tasks.gradeReply({
    run,
    scenario: sc,
    personaUsername: other.username,
    attemptText: body,
  });
  if (!result.handled) return false;

  // React in the DM as the persona.
  if (result.correct) {
    const head = result.firstBlood
      ? `🩸 *First blood!* +${result.points} pts.`
      : `✅ +${result.points} pts.`;
    const reply = result.onCorrectReply || 'Correct.';
    await postMessage({
      channelId: channel.id,
      userId: other.id,
      body: `${head}\n${reply}`,
      bypassPolicy: true,
    });
    emitScoreUpdate(channel.cohort_id);
    if (result.followUps && result.followUps.length) {
      // Reload run since score / state changed.
      const refreshed = cohortsLib.getRun(channel.cohort_id, user.id);
      await fireFollowUpTasks({ run: refreshed, followUps: result.followUps });
    }
  } else {
    const reply = result.onWrongReply || 'Not quite.';
    const tail = result.exhausted ? '\n(No more attempts on this one — moving on.)' : '';
    await postMessage({
      channelId: channel.id,
      userId: other.id,
      body: `❌ ${reply}${tail}`,
      bypassPolicy: true,
    });
  }
  return true;
}

// ---------- Socket.io ----------

io.use((socket, next) => {
  // parse cookies
  const cookies = (socket.handshake.headers.cookie || '').split(';').reduce((acc, c) => {
    const [k, v] = c.trim().split('=');
    if (k) acc[k] = decodeURIComponent(v || '');
    return acc;
  }, {});
  const sid = cookies.sid;
  if (!sid) return next(new Error('not_authenticated'));
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(sid);
  if (!user) return next(new Error('not_authenticated'));
  socket.data.user = user;
  next();
});

io.on('connection', (socket) => {
  const user = socket.data.user;

  // Join personal room
  socket.join(`user:${user.id}`);

  // Add channel rooms for all channels they belong to (or public)
  const chans = listChannelsForUser(user.id, defaultWorkspaceId);
  for (const c of chans) socket.join(`channel:${c.id}`);

  // Presence
  const cur = globalPresence.get(user.id);
  if (cur) {
    cur.count += 1;
  } else {
    globalPresence.set(user.id, { count: 1, user });
    io.emit('presence:online', userPublic(user));
  }

  socket.on('typing', ({ channelId }) => {
    if (!channelId) return;
    socket.to(`channel:${channelId}`).emit('typing', {
      channelId,
      user: userPublic(user),
    });
  });

  socket.on('message:send', async (payload, ack) => {
    try {
      const { channelId, body, parentId } = payload || {};
      if (!channelId || !body || !body.trim()) {
        if (typeof ack === 'function') ack({ ok: false, error: 'invalid' });
        return;
      }
      const ch = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
      if (!ch) {
        if (typeof ack === 'function') ack({ ok: false, error: 'no_channel' });
        return;
      }
      ensureMembership(ch.id, user.id);
      const { msg } = await postMessage({
        channelId: ch.id,
        userId: user.id,
        body: body.trim(),
        parentId: parentId || null,
      });
      if (typeof ack === 'function') ack({ ok: true, message: msg });

      // 1. If this DM has an active task for this user, route to grader.
      let handledAsTask = false;
      if (!parentId) {
        try {
          handledAsTask = await maybeGradePersonaDmReply({
            user,
            channel: ch,
            body: body.trim(),
          });
        } catch (err) {
          console.error('grader error', err);
        }
      }

      // 2. Otherwise, trigger AI personas (top-level only, no active task).
      if (!parentId && !handledAsTask) {
        maybeTriggerBots({
          channel: ch,
          triggerMessage: { author: user.display_name, body: body.trim() },
        });
      }
    } catch (err) {
      console.error('message:send error', err);
      if (typeof ack === 'function') ack({ ok: false, error: err.message });
    }
  });

  socket.on('scoreboard:join', ({ cohortId }) => {
    if (!cohortId) return;
    const member = cohortsLib.getMembership(cohortId, user.id);
    // Allow members + admins (admin token authoritatively gates the scoreboard page route too).
    if (member) socket.join(`cohort:${cohortId}:scoreboard`);
  });
  socket.on('scoreboard:leave', ({ cohortId }) => {
    if (cohortId) socket.leave(`cohort:${cohortId}:scoreboard`);
  });

  socket.on('thread:join', ({ messageId }) => {
    if (messageId) socket.join(`thread:${messageId}`);
  });
  socket.on('thread:leave', ({ messageId }) => {
    if (messageId) socket.leave(`thread:${messageId}`);
  });

  socket.on('reaction:toggle', async ({ messageId, emoji }, ack) => {
    try {
      if (!messageId || !emoji) {
        if (typeof ack === 'function') ack({ ok: false, error: 'invalid' });
        return;
      }
      const msg = db.prepare('SELECT id, channel_id, parent_id FROM messages WHERE id = ?').get(messageId);
      if (!msg) {
        if (typeof ack === 'function') ack({ ok: false, error: 'no_message' });
        return;
      }
      const existing = db
        .prepare('SELECT 1 FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?')
        .get(messageId, user.id, emoji);
      if (existing) {
        db.prepare('DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').run(
          messageId, user.id, emoji
        );
      } else {
        db.prepare(
          'INSERT INTO message_reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)'
        ).run(messageId, user.id, emoji, Date.now());
      }
      const reactions = reactionsForMessages([messageId]).get(messageId) || [];
      const payload = { messageId, channelId: msg.channel_id, parentId: msg.parent_id || null, reactions };
      io.to(`channel:${msg.channel_id}`).emit('reaction:update', payload);
      const threadRoot = msg.parent_id || msg.id;
      io.to(`thread:${threadRoot}`).emit('reaction:update', payload);
      if (typeof ack === 'function') ack({ ok: true, reactions });
    } catch (err) {
      console.error('reaction:toggle error', err);
      if (typeof ack === 'function') ack({ ok: false, error: err.message });
    }
  });

  socket.on('disconnect', () => {
    const entry = globalPresence.get(user.id);
    if (!entry) return;
    entry.count -= 1;
    if (entry.count <= 0) {
      globalPresence.delete(user.id);
      io.emit('presence:offline', { id: user.id });
    }
  });
});

// ---------- Bot trigger logic ----------

const recentBotPosts = new Map(); // `${botId}:${channelId}` -> last timestamp
const BOT_COOLDOWN_MS = 8000;

async function maybeTriggerBots({ channel, triggerMessage }) {
  if (!personas.isAiEnabled()) return; // no LLM key, bots stay silent unless driven by scenarios/admin
  const bots = personas.listBots(defaultWorkspaceId);
  if (!bots.length) return;

  // Mention-based: any bot whose username appears in @mentions or display name in the message
  const lowerBody = triggerMessage.body.toLowerCase();
  const mentioned = bots.filter((b) => {
    const tag = '@' + b.username.toLowerCase();
    return lowerBody.includes(tag) || lowerBody.includes(b.display_name.toLowerCase());
  });

  // If no explicit mention, randomly pick at most one bot to weigh in (10% chance per bot, capped to 1)
  let toRespond = mentioned;
  if (!toRespond.length) {
    const candidates = bots.filter((b) => Math.random() < 0.1);
    if (candidates.length) toRespond = [candidates[0]];
  }

  for (const bot of toRespond) {
    const key = `${bot.id}:${channel.id}`;
    const last = recentBotPosts.get(key) || 0;
    if (Date.now() - last < BOT_COOLDOWN_MS) continue;
    recentBotPosts.set(key, Date.now());

    // simulate typing then post
    io.to(`channel:${channel.id}`).emit('typing', {
      channelId: channel.id,
      user: userPublic(bot),
    });

    setTimeout(async () => {
      try {
        const reply = await personas.generateBotReply({ bot, channel, triggerMessage });
        if (!reply) return;
        ensureMembership(channel.id, bot.id);
        await postMessage({ channelId: channel.id, userId: bot.id, body: reply });
      } catch (err) {
        console.error('[bot] reply failed', err);
      }
    }, 800 + Math.random() * 1500);
  }
}

// ---------- HTML routes ----------

app.get('/', (req, res) => {
  const user = getUserBySession(req);
  if (!user) return res.sendFile(path.join(__dirname, 'public', 'login.html'));
  const cohort = cohortsLib.getUserPrimaryCohort(user.id);
  if (!cohort) return res.sendFile(path.join(__dirname, 'public', 'join.html'));
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

app.get('/join', (req, res) => {
  const user = getUserBySession(req);
  if (!user) return res.sendFile(path.join(__dirname, 'public', 'login.html'));
  res.sendFile(path.join(__dirname, 'public', 'join.html'));
});

app.get('/scoreboard', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'scoreboard.html'));
});

app.get('/admin', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

const PORT = parseInt(process.env.PORT, 10) || 3000;
server.listen(PORT, () => {
  console.log(`Slack-clone listening on :${PORT}`);
  console.log(`Workspace: ${defaultWorkspaceId}`);
  if (!personas.isAiEnabled()) {
    console.log(
      '[personas] No ANTHROPIC_API_KEY or GEMINI_API_KEY set — AI bots will be silent unless driven by admin/scenarios.'
    );
  } else {
    console.log(`[personas] AI provider: ${personas.getProvider()} (model: ${personas.getModel()})`);
  }
});
