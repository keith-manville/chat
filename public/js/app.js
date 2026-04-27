/* global io */

const state = {
  me: null,
  workspace: null,
  channels: [],
  currentChannelId: null,
  users: [],
  socket: null,
  typingTimers: new Map(),
};

// ---------- helpers ----------

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v != null) node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null) continue;
    if (typeof c === 'string') node.appendChild(document.createTextNode(c));
    else node.appendChild(c);
  }
  return node;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderBody(text) {
  // Minimal Slack-ish formatting: links, *bold*, _italic_, `code`, line breaks preserved by white-space CSS
  let s = escapeHtml(text);
  s = s.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/(^|[\s>])\*([^*\n]+)\*/g, '$1<strong>$2</strong>');
  s = s.replace(/(^|[\s>])_([^_\n]+)_/g, '$1<em>$2</em>');
  s = s.replace(/@([a-zA-Z0-9_.-]{2,32})/g, '<a href="#" class="mention">@$1</a>');
  return s;
}

function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function fmtDay(ts) {
  const d = new Date(ts);
  const today = new Date(); today.setHours(0,0,0,0);
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  const day = new Date(d); day.setHours(0,0,0,0);
  if (day.getTime() === today.getTime()) return 'Today';
  if (day.getTime() === yesterday.getTime()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
}

function initials(name) {
  return name.split(/\s+/).slice(0, 2).map((s) => s[0]).join('').toUpperCase();
}

// ---------- API ----------

async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  });
  if (res.status === 401) {
    window.location.href = '/';
    return Promise.reject(new Error('not_authenticated'));
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// ---------- Sidebar ----------

function dmLabelFor(channel) {
  if (!channel.isDm) return channel.name;
  // dm:idA:idB
  const parts = channel.name.split(':');
  const otherId = parts.slice(1).find((id) => id !== state.me.id);
  const other = state.users.find((u) => u.id === otherId);
  return other ? other.displayName : 'Direct message';
}

function renderSidebar() {
  document.getElementById('ws-name').textContent = state.workspace.name;
  document.getElementById('me-name').textContent = state.me.displayName;
  document.getElementById('rail-ws').textContent = state.workspace.name[0] || 'W';

  // Channels (non-DM)
  const list = document.getElementById('channel-list');
  list.innerHTML = '';
  for (const c of state.channels.filter((x) => !x.isDm)) {
    const li = el('li', {
      dataset: { channelId: c.id },
      class: c.id === state.currentChannelId ? 'active' : '',
      onclick: () => selectChannel(c.id),
    },
      el('span', { class: 'hash' }, '#'),
      el('span', {}, c.name)
    );
    list.appendChild(li);
  }

  // DMs
  const dmList = document.getElementById('dm-list');
  dmList.innerHTML = '';
  for (const c of state.channels.filter((x) => x.isDm)) {
    const otherId = c.name.split(':').slice(1).find((id) => id !== state.me.id);
    const other = state.users.find((u) => u.id === otherId);
    const online = other && (other.online || other.isBot);
    const li = el('li', {
      dataset: { channelId: c.id },
      class: c.id === state.currentChannelId ? 'active' : '',
      onclick: () => selectChannel(c.id),
    },
      el('span', { class: 'dot' + (online ? '' : ' offline') }),
      el('span', {}, other ? other.displayName : 'DM')
    );
    dmList.appendChild(li);
  }

  // People
  const people = document.getElementById('people-list');
  people.innerHTML = '';
  for (const u of state.users) {
    if (u.id === state.me.id) continue;
    const online = u.online || u.isBot;
    const li = el('li', {
      onclick: () => openDm(u.id),
    },
      el('span', { class: 'dot' + (online ? '' : ' offline') }),
      el('span', {}, u.displayName),
      u.isBot ? el('span', { class: 'bot-tag' }, 'BOT') : null,
    );
    people.appendChild(li);
  }
}

// ---------- Channel selection ----------

async function selectChannel(channelId) {
  state.currentChannelId = channelId;
  const channel = state.channels.find((c) => c.id === channelId);
  if (!channel) return;
  document.getElementById('channel-name').textContent = channel.isDm
    ? dmLabelFor(channel)
    : channel.name;
  document.getElementById('channel-topic').textContent = channel.topic || '';
  document.querySelector('.channel-title .hash').style.display = channel.isDm ? 'none' : 'inline';
  document.getElementById('typing-indicator').textContent = '';

  renderSidebar();

  const { messages } = await api(`/api/channels/${channelId}/messages?limit=200`);
  renderMessages(messages);
  if (state.socket) state.socket.emit('channel:focus', { channelId });
}

async function openDm(userId) {
  const data = await api('/api/dms', { method: 'POST', body: JSON.stringify({ userId }) });
  // Make sure channel is in our list
  if (!state.channels.find((c) => c.id === data.channel.id)) {
    state.channels.push(data.channel);
  }
  await selectChannel(data.channel.id);
}

// ---------- Messages ----------

function renderMessages(messages) {
  const root = document.getElementById('messages');
  root.innerHTML = '';
  let lastDay = null;
  let lastUser = null;
  let lastTs = 0;
  for (const m of messages) {
    const day = fmtDay(m.createdAt);
    if (day !== lastDay) {
      const div = el('div', { class: 'day-divider' }, el('span', {}, day));
      root.appendChild(div);
      lastDay = day;
      lastUser = null;
    }
    const grouped = lastUser === m.user.id && (m.createdAt - lastTs < 5 * 60 * 1000);
    root.appendChild(renderMessage(m, grouped));
    lastUser = m.user.id;
    lastTs = m.createdAt;
  }
  root.scrollTop = root.scrollHeight;
}

function renderMessage(m, grouped) {
  const node = el('div', { class: 'message' + (grouped ? ' grouped' : ''), dataset: { id: m.id } });
  const av = el('div', { class: 'avatar', style: `background:${m.user.avatarColor}` }, initials(m.user.displayName));
  node.appendChild(av);

  const meta = el('div', { class: 'meta' },
    el('span', { class: 'author' }, m.user.displayName),
    m.user.isBot ? el('span', { class: 'bot-badge' }, 'APP') : null,
    el('span', { class: 'timestamp' }, fmtTime(m.createdAt)),
  );
  node.appendChild(meta);

  const body = el('div', { class: 'body' });
  body.innerHTML = renderBody(m.body);
  node.appendChild(body);
  return node;
}

function appendMessage(m) {
  if (m.channelId !== state.currentChannelId) {
    // future: unread indicator on sidebar
    return;
  }
  const root = document.getElementById('messages');
  const last = root.lastElementChild;
  let grouped = false;
  if (last && last.classList.contains('message')) {
    const prevId = last.dataset.id;
    // Cheap regroup heuristic: same user as last in DOM. We can't know prev TS exactly;
    // skip grouping for live messages to keep author/time visible.
    grouped = false;
  }
  // Day divider check (only on new day boundary)
  const lastDayEl = Array.from(root.children).reverse().find((c) => c.classList.contains('day-divider'));
  const day = fmtDay(m.createdAt);
  if (!lastDayEl || lastDayEl.querySelector('span').textContent !== day) {
    root.appendChild(el('div', { class: 'day-divider' }, el('span', {}, day)));
  }
  root.appendChild(renderMessage(m, grouped));
  root.scrollTop = root.scrollHeight;
}

// ---------- Typing ----------

function showTyping(channelId, user) {
  if (channelId !== state.currentChannelId) return;
  const ind = document.getElementById('typing-indicator');
  ind.textContent = `${user.displayName} is typing...`;
  const key = user.id;
  if (state.typingTimers.has(key)) clearTimeout(state.typingTimers.get(key));
  state.typingTimers.set(
    key,
    setTimeout(() => {
      ind.textContent = '';
      state.typingTimers.delete(key);
    }, 3000)
  );
}

// ---------- Composer ----------

function setupComposer() {
  const input = document.getElementById('composer-input');
  const send = document.getElementById('send-btn');

  function refresh() {
    send.disabled = !input.value.trim() || !state.currentChannelId;
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 200) + 'px';
  }

  input.addEventListener('input', () => {
    refresh();
    if (state.socket && state.currentChannelId) {
      state.socket.emit('typing', { channelId: state.currentChannelId });
    }
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  });
  send.addEventListener('click', submit);

  function submit() {
    const body = input.value.trim();
    if (!body || !state.currentChannelId) return;
    state.socket.emit('message:send', { channelId: state.currentChannelId, body }, (ack) => {
      if (!ack || !ack.ok) {
        console.warn('send failed', ack);
      }
    });
    input.value = '';
    refresh();
  }
  refresh();
}

// ---------- Channel modal ----------

function setupModal() {
  const backdrop = document.getElementById('modal-backdrop');
  const open = () => { backdrop.hidden = false; };
  const close = () => { backdrop.hidden = true; document.getElementById('modal-error').textContent = ''; };
  document.getElementById('add-channel').addEventListener('click', open);
  document.getElementById('modal-cancel').addEventListener('click', close);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  document.getElementById('create-channel-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const data = await api('/api/channels', { method: 'POST', body: JSON.stringify({
        name: fd.get('name').trim(),
        topic: (fd.get('topic') || '').trim(),
      })});
      state.channels.push(data.channel);
      renderSidebar();
      selectChannel(data.channel.id);
      e.target.reset();
      close();
    } catch (err) {
      document.getElementById('modal-error').textContent = err.message;
    }
  });
}

// ---------- Socket ----------

function setupSocket() {
  const socket = io({ withCredentials: true });
  state.socket = socket;
  socket.on('connect', () => console.log('[socket] connected', socket.id));
  socket.on('connect_error', (err) => console.warn('[socket] error', err.message));
  socket.on('message', (msg) => appendMessage(msg));
  socket.on('typing', ({ channelId, user }) => {
    if (user.id === state.me.id) return;
    showTyping(channelId, user);
  });
  socket.on('channel:new', async (channel) => {
    if (!state.channels.find((c) => c.id === channel.id)) {
      state.channels.push(channel);
      renderSidebar();
    }
  });
  socket.on('presence:online', (user) => {
    const u = state.users.find((x) => x.id === user.id);
    if (u) u.online = true;
    renderSidebar();
  });
  socket.on('presence:offline', ({ id }) => {
    const u = state.users.find((x) => x.id === id);
    if (u) u.online = false;
    renderSidebar();
  });
}

// ---------- Boot ----------

(async function boot() {
  try {
    const me = await api('/api/me');
    state.me = me.user;
    state.workspace = me.workspace;
    const [chRes, usersRes] = await Promise.all([
      api('/api/channels'),
      api('/api/users'),
    ]);
    state.channels = chRes.channels;
    state.users = usersRes.users;
    renderSidebar();
    setupComposer();
    setupModal();
    setupSocket();

    document.getElementById('logout').addEventListener('click', async () => {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
      window.location.href = '/';
    });

    // Pick first non-DM channel by default
    const first = state.channels.find((c) => !c.isDm);
    if (first) selectChannel(first.id);
  } catch (err) {
    console.error('boot failed', err);
  }
})();
