const state = { token: null, editingScenarioId: null };

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (state.token) headers['x-admin-token'] = state.token;
  const res = await fetch(path, { credentials: 'include', headers, ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function show(elId) { document.getElementById(elId).hidden = false; }
function hide(elId) { document.getElementById(elId).hidden = true; }

function setupTabs() {
  const tabs = document.querySelectorAll('.tabs button');
  tabs.forEach((t) => {
    t.addEventListener('click', () => {
      tabs.forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
      document.querySelectorAll('[data-panel]').forEach((p) => p.classList.remove('active'));
      document.querySelector(`[data-panel="${t.dataset.tab}"]`).classList.add('active');
    });
  });
}

async function refreshPersonas() {
  const { personas } = await api('/api/admin/personas');
  const ul = document.getElementById('p-list');
  ul.innerHTML = '';
  personas.forEach((p) => {
    const li = document.createElement('li');
    li.innerHTML = `<span><strong>${p.displayName}</strong> <small class="muted">@${p.username}</small></span><span class="pill">BOT</span>`;
    li.style.cursor = 'pointer';
    li.addEventListener('click', async () => {
      const all = await api('/api/admin/personas');
      const full = all.personas.find((x) => x.id === p.id);
      document.getElementById('p-username').value = full.username;
      document.getElementById('p-display').value = full.displayName;
      // we don't return the persona body in listing; fetch full row by re-saving requires it
      // for simplicity, leave the persona text empty unless user wants to edit
    });
    ul.appendChild(li);
  });
}

async function refreshScenarios() {
  const { scenarios } = await api('/api/admin/scenarios');
  const ul = document.getElementById('s-list');
  ul.innerHTML = '';
  scenarios.forEach((s) => {
    const li = document.createElement('li');
    const left = document.createElement('span');
    left.innerHTML = `<strong>${escapeHtml(s.name)}</strong><br><small class="muted">${escapeHtml(s.description || '')}</small>`;
    const right = document.createElement('span');
    right.style.display = 'flex';
    right.style.gap = '6px';
    right.innerHTML = `
      <button data-act="edit" class="ghost" style="padding:4px 8px;">Edit</button>
      <button data-act="run" style="padding:4px 8px;">Run</button>
      <button data-act="stop" class="ghost" style="padding:4px 8px;">Stop</button>
      <button data-act="del" class="danger" style="padding:4px 8px;">Delete</button>
    `;
    right.addEventListener('click', async (e) => {
      const act = e.target.dataset.act;
      if (!act) return;
      try {
        if (act === 'edit') {
          const full = await api('/api/admin/scenarios/' + s.id);
          state.editingScenarioId = s.id;
          document.getElementById('s-name').value = full.scenario.name;
          document.getElementById('s-desc').value = full.scenario.description || '';
          document.getElementById('s-def').value = JSON.stringify(full.scenario.definition, null, 2);
        } else if (act === 'run') {
          const r = await api('/api/admin/scenarios/' + s.id + '/run', { method: 'POST' });
          appendLog(`Started "${s.name}" — ${r.scheduled} events scheduled.`);
        } else if (act === 'stop') {
          await api('/api/admin/scenarios/' + s.id + '/stop', { method: 'POST' });
          appendLog(`Stopped "${s.name}".`);
        } else if (act === 'del') {
          if (!confirm(`Delete scenario "${s.name}"?`)) return;
          await api('/api/admin/scenarios/' + s.id, { method: 'DELETE' });
          await refreshScenarios();
        }
      } catch (err) {
        appendLog('Error: ' + err.message);
      }
    });
    li.appendChild(left);
    li.appendChild(right);
    ul.appendChild(li);
  });
}

function appendLog(line) {
  const log = document.getElementById('s-log');
  if (log.textContent === 'No runs yet.') log.textContent = '';
  const ts = new Date().toLocaleTimeString();
  log.textContent += `[${ts}] ${line}\n`;
  log.scrollTop = log.scrollHeight;
}

function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const EXAMPLE_SCENARIO = {
  personas: [
    {
      username: 'ceo',
      displayName: 'Pat Morgan (CEO)',
      persona: 'You are Pat Morgan, CEO of Acme Corp. Calm under pressure, but expects clear status updates and bottom-line impact. Speaks plainly, asks pointed questions.',
    },
    {
      username: 'soc-analyst',
      displayName: 'Jordan Lee (SOC Analyst)',
      persona: 'You are Jordan Lee, a SOC Tier-2 analyst. Detail-oriented, technical, references SIEM alerts, IOCs, and ATT&CK techniques. Posts terse updates.',
    },
    {
      username: 'pr-lead',
      displayName: 'Morgan Yu (PR Lead)',
      persona: 'You are Morgan Yu, head of communications. Worried about media exposure and customer trust. Asks about disclosure timelines and approved messaging.',
    },
  ],
  events: [
    { delay_ms: 0, channel: 'incident-response', username: 'soc-analyst', body: '🚨 Possible compromise: 14 mailboxes in Finance OU triggered impossible-travel alerts within the last 30 min. Investigating.' },
    { delay_ms: 8000, channel: 'incident-response', username: 'soc-analyst', body: 'Confirmed credential reuse from a phishing campaign. Pulling MFA logs now.' },
    { delay_ms: 20000, channel: 'general', username: 'ceo', body: 'Team — I am hearing chatter about an issue. Who can give me a 2-line summary?' },
    { delay_ms: 35000, channel: 'incident-response', username: 'pr-lead', body: 'Looping in — we should prep a holding statement. Do we know if customer data is in scope yet?' },
  ],
};

function setupScenarioForm() {
  document.getElementById('s-load-example').addEventListener('click', () => {
    document.getElementById('s-name').value = 'Phishing incident — Hour 1';
    document.getElementById('s-desc').value = 'Demo scenario: credential phishing detection through initial CEO/PR pressure.';
    document.getElementById('s-def').value = JSON.stringify(EXAMPLE_SCENARIO, null, 2);
    state.editingScenarioId = null;
  });
  document.getElementById('s-save').addEventListener('click', async () => {
    const errBox = document.getElementById('s-error');
    errBox.textContent = '';
    let definition;
    try {
      definition = JSON.parse(document.getElementById('s-def').value);
    } catch (err) {
      errBox.textContent = 'Invalid JSON: ' + err.message;
      return;
    }
    try {
      await api('/api/admin/scenarios', {
        method: 'POST',
        body: JSON.stringify({
          id: state.editingScenarioId,
          name: document.getElementById('s-name').value.trim(),
          description: document.getElementById('s-desc').value.trim(),
          definition,
        }),
      });
      state.editingScenarioId = null;
      document.getElementById('s-name').value = '';
      document.getElementById('s-desc').value = '';
      document.getElementById('s-def').value = '';
      await refreshScenarios();
      appendLog('Saved scenario.');
    } catch (err) {
      errBox.textContent = err.message;
    }
  });
}

function setupPersonaForm() {
  document.getElementById('p-save').addEventListener('click', async () => {
    try {
      await api('/api/admin/personas', {
        method: 'POST',
        body: JSON.stringify({
          username: document.getElementById('p-username').value.trim(),
          displayName: document.getElementById('p-display').value.trim(),
          persona: document.getElementById('p-persona').value.trim(),
        }),
      });
      document.getElementById('p-username').value = '';
      document.getElementById('p-display').value = '';
      document.getElementById('p-persona').value = '';
      await refreshPersonas();
    } catch (err) {
      alert(err.message);
    }
  });
}

function setupInjectForm() {
  document.getElementById('i-send').addEventListener('click', async () => {
    const status = document.getElementById('i-status');
    status.textContent = '';
    try {
      await api('/api/admin/post', {
        method: 'POST',
        body: JSON.stringify({
          channel: document.getElementById('i-channel').value.trim(),
          username: document.getElementById('i-username').value.trim(),
          body: document.getElementById('i-body').value,
        }),
      });
      status.textContent = 'Sent.';
      document.getElementById('i-body').value = '';
    } catch (err) {
      status.textContent = 'Error: ' + err.message;
    }
  });
}

document.getElementById('admin-login').addEventListener('click', async () => {
  const tok = document.getElementById('admin-token').value;
  const errBox = document.getElementById('admin-login-err');
  errBox.textContent = '';
  try {
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ token: tok }),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      errBox.textContent = d.error || 'Forbidden';
      return;
    }
    state.token = tok;
    hide('login-block');
    show('console-block');
    setupTabs();
    setupPersonaForm();
    setupInjectForm();
    setupScenarioForm();
    await Promise.all([refreshPersonas(), refreshScenarios()]);
  } catch (err) {
    errBox.textContent = err.message;
  }
});
