/* global io */

const params = new URLSearchParams(window.location.search);
const cohortId = params.get('cohort');

function fmtRel(ts) {
  if (!ts) return '—';
  const d = Date.now() - ts;
  if (d < 60_000) return 'just now';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}

function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function initials(name) {
  return String(name || '?').split(/\s+/).slice(0, 2).map((s) => s[0]).join('').toUpperCase();
}

function render(runs) {
  const tbody = document.getElementById('rows');
  if (!runs.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="muted">No participants yet.</td></tr>';
  } else {
    tbody.innerHTML = runs
      .map((r) => `
        <tr>
          <td class="rank">${r.rank}</td>
          <td class="player">
            <span class="avatar-mini" style="background:${escapeHtml(r.avatarColor)}">${initials(r.displayName)}</span>
            <span>${escapeHtml(r.displayName)}</span>
            <small class="muted">@${escapeHtml(r.username)}</small>
            ${r.completed ? '<span class="pill" style="background:#2BAC76;color:#fff;">DONE</span>' : ''}
          </td>
          <td class="num"><strong>${r.score}</strong></td>
          <td class="num">${r.hintsUsed}</td>
          <td>${fmtRel(r.lastActivityAt)}</td>
        </tr>
      `)
      .join('');
  }
  document.getElementById('stat-players').textContent = runs.length;
  document.getElementById('stat-top').textContent = runs.length ? runs[0].score : 0;
}

async function load() {
  if (!cohortId) {
    document.getElementById('rows').innerHTML =
      '<tr><td colspan="5" class="muted">Missing ?cohort=&lt;id&gt; query param.</td></tr>';
    return;
  }
  try {
    const res = await fetch('/api/scoreboard/' + encodeURIComponent(cohortId), {
      credentials: 'include',
    });
    if (res.status === 401) { window.location.href = '/'; return; }
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      document.getElementById('rows').innerHTML =
        `<tr><td colspan="5" class="error">${escapeHtml(d.error || res.statusText)}</td></tr>`;
      return;
    }
    const data = await res.json();
    document.getElementById('cohort-name').textContent = data.cohort.name;
    document.getElementById('cohort-meta').textContent =
      `Join code: ${data.cohort.joinCode}  •  ${data.runs.length} player${data.runs.length === 1 ? '' : 's'}`;
    render(data.runs);
  } catch (err) {
    document.getElementById('rows').innerHTML =
      `<tr><td colspan="5" class="error">${escapeHtml(err.message)}</td></tr>`;
  }
}

function connectSocket() {
  if (!cohortId) return;
  const socket = io({ withCredentials: true });
  socket.on('connect', () => socket.emit('scoreboard:join', { cohortId }));
  socket.on('scoreboard:update', (u) => {
    if (u.cohortId !== cohortId) return;
    render(u.runs);
  });
}

setInterval(() => {
  // periodic re-render to refresh "Xm ago" timestamps
  const tbody = document.getElementById('rows');
  if (tbody.querySelector('tr.player') === null) {
    // No-op if just the empty/error row
  }
}, 30000);

load();
connectSocket();
