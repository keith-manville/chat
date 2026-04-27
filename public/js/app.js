/* global io, EMOJI_MAP, RECENT_EMOJIS, replaceEmojiShortcodes */

const state = {
  me: null,
  workspace: null,
  channels: [],
  currentChannelId: null,
  users: [],
  socket: null,
  typingTimers: new Map(),
  // thread panel state
  thread: { rootId: null, root: null, replies: [] },
  // composer used by emoji picker target ('main' or 'thread')
  emojiTarget: 'main',
  emojiPickerAnchor: null,
};

// ---------- helpers ----------

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'html') node.innerHTML = v;
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
  let s = escapeHtml(text);
  s = replaceEmojiShortcodes(s);
  s = s.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/(^|[\s>])\*([^*\n]+)\*/g, '$1<strong>$2</strong>');
  s = s.replace(/(^|[\s>])_([^_\n]+)_/g, '$1<em>$2</em>');
  s = s.replace(/@([a-zA-Z0-9_.-]{2,32})/g, '<a href="#" class="mention">@$1</a>');
  return s;
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
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

function fmtRelative(ts) {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
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
  const otherId = channel.name.split(':').slice(1).find((id) => id !== state.me.id);
  const other = state.users.find((u) => u.id === otherId);
  return other ? other.displayName : 'Direct message';
}

function renderSidebar() {
  document.getElementById('ws-name').textContent = state.workspace.name;
  document.getElementById('me-name').textContent = state.me.displayName;
  document.getElementById('rail-ws').textContent = state.workspace.name[0] || 'W';

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

  const people = document.getElementById('people-list');
  people.innerHTML = '';
  for (const u of state.users) {
    if (u.id === state.me.id) continue;
    const online = u.online || u.isBot;
    const li = el('li', { onclick: () => openDm(u.id) },
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
  closeThread();
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
}

async function openDm(userId) {
  const data = await api('/api/dms', { method: 'POST', body: JSON.stringify({ userId }) });
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
      root.appendChild(el('div', { class: 'day-divider' }, el('span', {}, day)));
      lastDay = day;
      lastUser = null;
    }
    const grouped = lastUser === m.user.id && (m.createdAt - lastTs < 5 * 60 * 1000);
    root.appendChild(renderMessage(m, { grouped }));
    lastUser = m.user.id;
    lastTs = m.createdAt;
  }
  root.scrollTop = root.scrollHeight;
}

function renderMessage(m, { grouped = false, inThread = false } = {}) {
  const node = el('div', { class: 'message' + (grouped ? ' grouped' : ''), dataset: { id: m.id } });
  node.appendChild(el('div', { class: 'avatar', style: `background:${m.user.avatarColor}` }, initials(m.user.displayName)));
  node.appendChild(el('div', { class: 'meta' },
    el('span', { class: 'author' }, m.user.displayName),
    m.user.isBot ? el('span', { class: 'bot-badge' }, 'APP') : null,
    el('span', { class: 'timestamp' }, fmtTime(m.createdAt)),
  ));
  const body = el('div', { class: 'body' });
  body.innerHTML = renderBody(m.body);
  node.appendChild(body);

  // Reactions
  const reactionsRow = renderReactions(m);
  if (reactionsRow) node.appendChild(reactionsRow);

  // Thread indicator (only on top-level, not when already inside a thread)
  if (!inThread && m.replyCount > 0) {
    node.appendChild(renderThreadIndicator(m));
  }

  // Hover action bar
  node.appendChild(renderActions(m, { inThread }));
  return node;
}

function renderReactions(m) {
  if (!m.reactions || !m.reactions.length) return null;
  const wrap = el('div', { class: 'reactions' });
  for (const r of m.reactions) {
    const own = r.userIds.includes(state.me.id);
    const chip = el('button', {
      class: 'reaction-chip' + (own ? ' own' : ''),
      title: r.userIds.length + ' reaction' + (r.userIds.length === 1 ? '' : 's'),
      onclick: (e) => {
        e.stopPropagation();
        toggleReaction(m.id, r.emoji);
      },
    },
      el('span', { class: 'r-emoji' }, r.emoji),
      el('span', { class: 'r-count' }, String(r.userIds.length)),
    );
    wrap.appendChild(chip);
  }
  // Add a "+" button to add a new reaction
  wrap.appendChild(el('button', {
    class: 'reaction-chip add',
    title: 'Add reaction',
    onclick: (e) => { e.stopPropagation(); openEmojiPicker(e.currentTarget, (emoji) => toggleReaction(m.id, emoji)); },
  }, '😀+'));
  return wrap;
}

function renderThreadIndicator(m) {
  return el('div', {
    class: 'thread-indicator',
    onclick: () => openThread(m.id),
  },
    el('span', { class: 'thread-icon' }, '💬'),
    el('span', { class: 'thread-count' }, `${m.replyCount} ${m.replyCount === 1 ? 'reply' : 'replies'}`),
    el('span', { class: 'thread-last muted' }, m.lastReplyAt ? `Last reply ${fmtRelative(m.lastReplyAt)}` : ''),
    el('span', { class: 'thread-cta muted' }, 'View thread →'),
  );
}

function renderActions(m, { inThread = false } = {}) {
  const bar = el('div', { class: 'message-actions' });
  bar.appendChild(el('button', {
    class: 'msg-action-btn',
    title: 'Add reaction',
    onclick: (e) => { e.stopPropagation(); openEmojiPicker(e.currentTarget, (emoji) => toggleReaction(m.id, emoji)); },
  }, '😀'));
  if (!inThread) {
    bar.appendChild(el('button', {
      class: 'msg-action-btn',
      title: 'Reply in thread',
      onclick: (e) => { e.stopPropagation(); openThread(m.id); },
    }, '💬'));
  }
  return bar;
}

function appendMessage(m) {
  if (m.channelId !== state.currentChannelId) return;
  if (m.parentId) return; // replies don't show in main channel
  const root = document.getElementById('messages');
  const day = fmtDay(m.createdAt);
  const lastDayEl = Array.from(root.children).reverse().find((c) => c.classList.contains('day-divider'));
  if (!lastDayEl || lastDayEl.querySelector('span').textContent !== day) {
    root.appendChild(el('div', { class: 'day-divider' }, el('span', {}, day)));
  }
  root.appendChild(renderMessage(m, { grouped: false }));
  root.scrollTop = root.scrollHeight;
}

// ---------- Reactions live update ----------

function applyReactionUpdate({ messageId, channelId, parentId, reactions }) {
  // Update DOM in main pane
  if (channelId === state.currentChannelId && !parentId) {
    const node = document.querySelector(`#messages .message[data-id="${messageId}"]`);
    if (node) replaceReactionsRow(node, { id: messageId, reactions });
  }
  // Update DOM inside thread panel if open
  if (state.thread.rootId) {
    if (state.thread.rootId === messageId) {
      const rootEl = document.querySelector(`#thread-root .message[data-id="${messageId}"]`);
      if (rootEl) replaceReactionsRow(rootEl, { id: messageId, reactions });
      if (state.thread.root) state.thread.root.reactions = reactions;
    }
    if (parentId === state.thread.rootId) {
      const replyEl = document.querySelector(`#thread-replies .message[data-id="${messageId}"]`);
      if (replyEl) replaceReactionsRow(replyEl, { id: messageId, reactions });
      const reply = state.thread.replies.find((x) => x.id === messageId);
      if (reply) reply.reactions = reactions;
    }
  }
}

function replaceReactionsRow(messageNode, m) {
  const old = messageNode.querySelector(':scope > .reactions');
  if (old) old.remove();
  const newRow = renderReactions(m);
  if (!newRow) return;
  // Insert after the .body
  const body = messageNode.querySelector(':scope > .body');
  if (body && body.nextSibling) messageNode.insertBefore(newRow, body.nextSibling);
  else messageNode.appendChild(newRow);
}

function applyThreadUpdate({ messageId, channelId, replyCount, lastReplyAt }) {
  if (channelId !== state.currentChannelId) return;
  const node = document.querySelector(`#messages .message[data-id="${messageId}"]`);
  if (!node) return;
  const existing = node.querySelector(':scope > .thread-indicator');
  const updated = { id: messageId, replyCount, lastReplyAt };
  const newInd = renderThreadIndicator(updated);
  if (existing) existing.replaceWith(newInd);
  else {
    const actions = node.querySelector(':scope > .message-actions');
    node.insertBefore(newInd, actions || null);
  }
}

// ---------- Reactions toggle ----------

function toggleReaction(messageId, emoji) {
  state.socket.emit('reaction:toggle', { messageId, emoji }, (ack) => {
    if (!ack || !ack.ok) console.warn('reaction failed', ack);
  });
  hideEmojiPicker();
}

// ---------- Threads ----------

async function openThread(rootId) {
  try {
    const data = await api(`/api/messages/${rootId}/thread`);
    if (state.thread.rootId && state.thread.rootId !== rootId) {
      state.socket.emit('thread:leave', { messageId: state.thread.rootId });
    }
    state.thread = { rootId: data.root.id, root: data.root, replies: data.replies };
    state.socket.emit('thread:join', { messageId: rootId });

    document.body.classList.add('thread-open');
    const panel = document.getElementById('thread-panel');
    panel.hidden = false;

    const channel = state.channels.find((c) => c.id === data.root.channelId);
    document.getElementById('thread-subtitle').textContent = channel
      ? `#${channel.isDm ? dmLabelFor(channel) : channel.name}`
      : '';

    const rootEl = document.getElementById('thread-root');
    rootEl.innerHTML = '';
    rootEl.appendChild(renderMessage(data.root, { grouped: false, inThread: true }));

    renderThreadReplies();
  } catch (err) {
    console.error('openThread failed', err);
  }
}

function renderThreadReplies() {
  const replies = state.thread.replies;
  const div = document.getElementById('thread-replies');
  div.innerHTML = '';
  for (const r of replies) {
    div.appendChild(renderMessage(r, { grouped: false, inThread: true }));
  }
  const divider = document.getElementById('thread-replies-divider');
  document.getElementById('thread-replies-count').textContent =
    `${replies.length} ${replies.length === 1 ? 'reply' : 'replies'}`;
  divider.hidden = replies.length === 0;
  div.scrollTop = div.scrollHeight;
}

function appendThreadReply(m) {
  if (!state.thread.rootId || m.parentId !== state.thread.rootId) return;
  state.thread.replies.push(m);
  const div = document.getElementById('thread-replies');
  div.appendChild(renderMessage(m, { grouped: false, inThread: true }));
  document.getElementById('thread-replies-divider').hidden = false;
  document.getElementById('thread-replies-count').textContent =
    `${state.thread.replies.length} ${state.thread.replies.length === 1 ? 'reply' : 'replies'}`;
  div.scrollTop = div.scrollHeight;
}

function closeThread() {
  if (state.thread.rootId) {
    state.socket && state.socket.emit('thread:leave', { messageId: state.thread.rootId });
  }
  state.thread = { rootId: null, root: null, replies: [] };
  document.body.classList.remove('thread-open');
  document.getElementById('thread-panel').hidden = true;
}

// ---------- Typing ----------

function showTyping(channelId, user) {
  if (channelId !== state.currentChannelId) return;
  const ind = document.getElementById('typing-indicator');
  ind.textContent = `${user.displayName} is typing...`;
  const key = user.id;
  if (state.typingTimers.has(key)) clearTimeout(state.typingTimers.get(key));
  state.typingTimers.set(key, setTimeout(() => {
    ind.textContent = '';
    state.typingTimers.delete(key);
  }, 3000));
}

// ---------- Composer (main + thread) ----------

function setupComposer() {
  setupComposerImpl({
    inputId: 'composer-input',
    sendBtnId: 'send-btn',
    emojiBtnId: 'composer-emoji',
    getParentId: () => null,
  });
  setupComposerImpl({
    inputId: 'thread-input',
    sendBtnId: 'thread-send-btn',
    emojiBtnId: 'thread-emoji',
    getParentId: () => state.thread.rootId,
  });
}

function setupComposerImpl({ inputId, sendBtnId, emojiBtnId, getParentId }) {
  const input = document.getElementById(inputId);
  const send = document.getElementById(sendBtnId);
  const emojiBtn = document.getElementById(emojiBtnId);

  function refresh() {
    const parentId = getParentId();
    const isThread = !!parentId;
    send.disabled = !input.value.trim() || (!isThread && !state.currentChannelId);
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 200) + 'px';
  }

  input.addEventListener('input', () => {
    refresh();
    if (!getParentId() && state.socket && state.currentChannelId) {
      state.socket.emit('typing', { channelId: state.currentChannelId });
    }
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
  });
  send.addEventListener('click', submit);
  emojiBtn && emojiBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openEmojiPicker(emojiBtn, (emoji) => {
      const start = input.selectionStart, end = input.selectionEnd;
      input.value = input.value.slice(0, start) + emoji + input.value.slice(end);
      input.focus();
      input.selectionStart = input.selectionEnd = start + emoji.length;
      refresh();
    });
  });

  function submit() {
    const body = input.value.trim();
    if (!body) return;
    const parentId = getParentId();
    const channelId = parentId
      ? (state.thread.root && state.thread.root.channelId)
      : state.currentChannelId;
    if (!channelId) return;
    state.socket.emit('message:send', { channelId, body, parentId }, (ack) => {
      if (!ack || !ack.ok) console.warn('send failed', ack);
    });
    input.value = '';
    refresh();
  }
  refresh();
}

// ---------- Emoji picker ----------

function setupEmojiPicker() {
  const grid = document.getElementById('emoji-grid');
  const search = document.getElementById('emoji-search');
  function renderGrid(filter = '') {
    grid.innerHTML = '';
    const f = filter.trim().toLowerCase().replace(/^:|:$/g, '');
    let names;
    if (!f) {
      names = RECENT_EMOJIS.concat(Object.keys(EMOJI_MAP).filter((n) => !RECENT_EMOJIS.includes(n)));
    } else {
      names = Object.keys(EMOJI_MAP).filter((n) => n.includes(f));
    }
    names.slice(0, 80).forEach((n) => {
      grid.appendChild(el('button', {
        class: 'emoji-cell', title: ':' + n + ':',
        onclick: (e) => { e.stopPropagation(); state.emojiCallback && state.emojiCallback(EMOJI_MAP[n]); hideEmojiPicker(); },
      }, EMOJI_MAP[n]));
    });
  }
  search.addEventListener('input', () => renderGrid(search.value));
  state._renderEmojiGrid = renderGrid;
  document.addEventListener('click', (e) => {
    const picker = document.getElementById('emoji-picker');
    if (picker.hidden) return;
    if (!picker.contains(e.target)) hideEmojiPicker();
  });
}

function openEmojiPicker(anchor, cb) {
  state.emojiCallback = cb;
  const picker = document.getElementById('emoji-picker');
  const r = anchor.getBoundingClientRect();
  picker.hidden = false;
  // After unhiding, measure
  const pw = picker.offsetWidth || 280;
  const ph = picker.offsetHeight || 320;
  let left = r.left;
  if (left + pw > window.innerWidth - 12) left = window.innerWidth - pw - 12;
  let top = r.top - ph - 8;
  if (top < 12) top = r.bottom + 8;
  picker.style.left = left + 'px';
  picker.style.top = top + 'px';
  document.getElementById('emoji-search').value = '';
  state._renderEmojiGrid && state._renderEmojiGrid('');
  setTimeout(() => document.getElementById('emoji-search').focus(), 0);
}

function hideEmojiPicker() {
  const picker = document.getElementById('emoji-picker');
  picker.hidden = true;
  state.emojiCallback = null;
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
  socket.on('thread:reply', (msg) => appendThreadReply(msg));
  socket.on('thread:update', (u) => applyThreadUpdate(u));
  socket.on('reaction:update', (u) => applyReactionUpdate(u));
  socket.on('typing', ({ channelId, user }) => {
    if (user.id === state.me.id) return;
    showTyping(channelId, user);
  });
  socket.on('channel:new', (channel) => {
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
    setupEmojiPicker();
    setupSocket();

    document.getElementById('logout').addEventListener('click', async () => {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
      window.location.href = '/';
    });
    document.getElementById('thread-close').addEventListener('click', closeThread);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (!document.getElementById('emoji-picker').hidden) hideEmojiPicker();
        else if (state.thread.rootId) closeThread();
      }
    });

    const first = state.channels.find((c) => !c.isDm);
    if (first) selectChannel(first.id);
  } catch (err) {
    console.error('boot failed', err);
  }
})();
