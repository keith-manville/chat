const path = require('path');
const http = require('http');
const express = require('express');
const cookieParser = require('cookie-parser');
const { Server } = require('socket.io');

const { db, defaultWorkspaceId } = require('./db');
const { newId, pickAvatarColor } = require('./lib/util');
const personas = require('./lib/personas');
const scenarios = require('./lib/scenarios');

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
    topic: c.topic || '',
    isPrivate: !!c.is_private,
    isDm: !!c.is_dm,
  };
}

function listChannelsForUser(userId, workspaceId) {
  return db
    .prepare(
      `SELECT c.* FROM channels c
       LEFT JOIN channel_members cm ON cm.channel_id = c.id AND cm.user_id = ?
       WHERE c.workspace_id = ?
         AND (c.is_private = 0 OR cm.user_id IS NOT NULL)
       ORDER BY c.is_dm ASC, c.name ASC`
    )
    .all(userId, workspaceId);
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

async function postMessage({ channelId, userId, body }) {
  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!channel || !user) throw new Error('channel_or_user_missing');
  const id = newId('m');
  const created = Date.now();
  db.prepare(
    'INSERT INTO messages (id, channel_id, user_id, body, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, channelId, userId, body, created);
  const msg = {
    id,
    channelId,
    body,
    createdAt: created,
    user: userPublic(user),
  };
  io.to(`channel:${channelId}`).emit('message', msg);
  return { msg, channel, user };
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
    // auto-join all public channels
    const publicChans = db
      .prepare('SELECT id FROM channels WHERE workspace_id = ? AND is_private = 0')
      .all(defaultWorkspaceId);
    for (const c of publicChans) ensureMembership(c.id, user.id);
  }
  res.cookie('sid', user.id, { httpOnly: true, sameSite: 'lax' });
  res.json({ user: userPublic(user) });
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('sid');
  res.json({ ok: true });
});

app.get('/api/me', requireUser, (req, res) => {
  res.json({
    user: userPublic(req.user),
    workspace: { id: defaultWorkspaceId, name: db.prepare('SELECT name FROM workspaces WHERE id = ?').get(defaultWorkspaceId).name },
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

app.get('/api/channels/:id/messages', requireUser, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const before = req.query.before ? parseInt(req.query.before, 10) : null;
  let rows;
  if (before) {
    rows = db
      .prepare(
        `SELECT m.id, m.channel_id, m.body, m.created_at,
                u.id AS uid, u.username, u.display_name, u.avatar_color, u.is_bot, u.status_text
         FROM messages m JOIN users u ON u.id = m.user_id
         WHERE m.channel_id = ? AND m.created_at < ?
         ORDER BY m.created_at DESC LIMIT ?`
      )
      .all(req.params.id, before, limit);
  } else {
    rows = db
      .prepare(
        `SELECT m.id, m.channel_id, m.body, m.created_at,
                u.id AS uid, u.username, u.display_name, u.avatar_color, u.is_bot, u.status_text
         FROM messages m JOIN users u ON u.id = m.user_id
         WHERE m.channel_id = ?
         ORDER BY m.created_at DESC LIMIT ?`
      )
      .all(req.params.id, limit);
  }
  const messages = rows.reverse().map((r) => ({
    id: r.id,
    channelId: r.channel_id,
    body: r.body,
    createdAt: r.created_at,
    user: {
      id: r.uid,
      username: r.username,
      displayName: r.display_name,
      avatarColor: r.avatar_color,
      isBot: !!r.is_bot,
      statusText: r.status_text || '',
    },
  }));
  res.json({ messages });
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
  const { id, name, description, definition } = req.body || {};
  if (!name || !definition) return res.status(400).json({ error: 'missing_fields' });
  const sid = scenarios.saveScenario({
    id,
    workspaceId: defaultWorkspaceId,
    name,
    description,
    definition,
  });
  res.json({ id: sid });
});

app.delete('/api/admin/scenarios/:id', requireAdmin, (req, res) => {
  scenarios.deleteScenario(req.params.id);
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
      const { channelId, body } = payload || {};
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
      const { msg } = await postMessage({ channelId: ch.id, userId: user.id, body: body.trim() });
      if (typeof ack === 'function') ack({ ok: true, message: msg });

      // Trigger AI personas
      maybeTriggerBots({ channel: ch, triggerMessage: { author: user.display_name, body: body.trim() } });
    } catch (err) {
      console.error('message:send error', err);
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
  if (!personas.getAnthropic()) return; // no LLM key, bots stay silent unless driven by scenarios/admin
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
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

app.get('/admin', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

const PORT = parseInt(process.env.PORT, 10) || 3000;
server.listen(PORT, () => {
  console.log(`Slack-clone listening on :${PORT}`);
  console.log(`Workspace: ${defaultWorkspaceId}`);
  if (!personas.getAnthropic()) {
    console.log('[personas] ANTHROPIC_API_KEY not set — AI bots will be silent unless driven by admin/scenarios.');
  }
});
