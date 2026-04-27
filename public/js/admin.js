const state = {
  token: null,
  editingScenarioId: null,
  activeScenarioId: null,
  repoConfig: { repo: '', ref: 'main', path: 'scenarios', hasEnvToken: false },
};

const PAT_KEY = 'ctf-chat:gh_pat';
const REPO_KEY = 'ctf-chat:gh_repo';
const REF_KEY = 'ctf-chat:gh_ref';
const PATH_KEY = 'ctf-chat:gh_path';

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

function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

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

// ---------- personas ----------

async function refreshPersonas() {
  const { personas } = await api('/api/admin/personas');
  const ul = document.getElementById('p-list');
  ul.innerHTML = '';
  personas.forEach((p) => {
    const li = document.createElement('li');
    li.innerHTML = `<span><strong>${escapeHtml(p.displayName)}</strong> <small class="muted">@${escapeHtml(p.username)}</small></span><span class="pill">BOT</span>`;
    ul.appendChild(li);
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

// ---------- inject ----------

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

// ---------- state / active scenario ----------

async function refreshState() {
  const data = await api('/api/admin/state');
  state.activeScenarioId = data.activeScenario ? data.activeScenario.id : null;
  state.repoConfig = data.repoConfig || state.repoConfig;

  const banner = document.getElementById('active-banner');
  if (data.activeScenario) {
    banner.hidden = false;
    document.getElementById('active-name').textContent = data.activeScenario.name;
    document.getElementById('active-desc').textContent = data.activeScenario.description || '';
  } else {
    banner.hidden = true;
  }

  // Prefill repo config inputs (env defaults override saved sessionStorage)
  const repoInput = document.getElementById('gh-repo');
  const refInput = document.getElementById('gh-ref');
  const pathInput = document.getElementById('gh-path');
  if (!repoInput.value) {
    repoInput.value = state.repoConfig.repo || sessionStorage.getItem(REPO_KEY) || '';
  }
  if (!refInput.value) {
    refInput.value = state.repoConfig.ref || sessionStorage.getItem(REF_KEY) || 'main';
  }
  if (!pathInput.value) {
    pathInput.value = state.repoConfig.path || sessionStorage.getItem(PATH_KEY) || 'scenarios';
  }
}

// ---------- scenarios list ----------

async function refreshScenarios() {
  const { scenarios } = await api('/api/admin/scenarios');
  const ul = document.getElementById('s-list');
  ul.innerHTML = '';
  if (!scenarios.length) {
    const li = document.createElement('li');
    li.innerHTML = '<span class="muted">No scenarios yet — author one below or sync from GitHub.</span>';
    ul.appendChild(li);
    return;
  }

  scenarios.forEach((s) => {
    const li = document.createElement('li');
    const isActive = s.id === state.activeScenarioId;
    const sourcePill = s.source === 'github'
      ? `<span class="source-pill github" title="${escapeHtml(s.sourceRef || '')}">GITHUB</span>`
      : `<span class="source-pill local">LOCAL</span>`;
    const activePill = isActive
      ? `<span class="pill" style="background:#1164A3;color:#fff;">ACTIVE</span>`
      : '';

    li.innerHTML = `
      <div class="scenario-row">
        <div class="row-top">
          ${sourcePill}
          ${activePill}
          <strong>${escapeHtml(s.name)}</strong>
        </div>
        ${s.description ? `<small class="muted">${escapeHtml(s.description)}</small>` : ''}
        <div class="row-actions">
          ${isActive
            ? `<button data-act="unload" class="ghost">Unload</button>`
            : `<button data-act="load">Load</button>`}
          <button data-act="run">Run timeline</button>
          <button data-act="stop" class="ghost">Stop</button>
          ${s.source === 'local' ? `<button data-act="edit" class="ghost">Edit</button>` : ''}
          <button data-act="del" class="danger">Delete</button>
        </div>
      </div>
    `;

    li.addEventListener('click', async (e) => {
      const act = e.target.dataset.act;
      if (!act) return;
      try {
        if (act === 'load') {
          const r = await api(`/api/admin/scenarios/${s.id}/load`, { method: 'POST' });
          appendLog(`Loaded "${s.name}" — ${r.personasReady} persona(s) ready. AI replies are now grounded in this scenario.`);
        } else if (act === 'unload') {
          await api('/api/admin/scenarios/unload', { method: 'POST' });
          appendLog(`Unloaded active scenario.`);
        } else if (act === 'run') {
          const r = await api(`/api/admin/scenarios/${s.id}/run`, { method: 'POST' });
          appendLog(`Started timeline "${s.name}" — ${r.scheduled} event(s) scheduled.`);
        } else if (act === 'stop') {
          await api(`/api/admin/scenarios/${s.id}/stop`, { method: 'POST' });
          appendLog(`Stopped timeline "${s.name}".`);
        } else if (act === 'edit') {
          const full = await api(`/api/admin/scenarios/${s.id}`);
          state.editingScenarioId = s.id;
          document.getElementById('s-name').value = full.scenario.name;
          document.getElementById('s-desc').value = full.scenario.description || '';
          document.getElementById('s-brief').value = full.scenario.briefing || '';
          document.getElementById('s-def').value = JSON.stringify(full.scenario.definition, null, 2);
          window.scrollTo({ top: 0, behavior: 'smooth' });
        } else if (act === 'del') {
          if (!confirm(`Delete scenario "${s.name}"?` +
            (s.source === 'github' ? '\n(It will be re-imported on the next sync.)' : ''))) return;
          await api(`/api/admin/scenarios/${s.id}`, { method: 'DELETE' });
        }
        await refreshState();
        await refreshScenarios();
      } catch (err) {
        appendLog('Error: ' + err.message);
      }
    });

    ul.appendChild(li);
  });
}

// ---------- scenario editor ----------

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
    document.getElementById('s-brief').value = 'It is Tuesday 09:14. Acme Corp\'s finance team just received a wave of MFA fatigue prompts; impossible-travel alerts are firing in the SIEM. The SOC is investigating; the CEO has noticed chatter and is asking for a status.';
    document.getElementById('s-def').value = JSON.stringify(EXAMPLE_SCENARIO, null, 2);
    state.editingScenarioId = null;
  });
  document.getElementById('s-clear').addEventListener('click', () => {
    state.editingScenarioId = null;
    ['s-name', 's-desc', 's-brief', 's-def'].forEach((id) => { document.getElementById(id).value = ''; });
    document.getElementById('s-error').textContent = '';
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
          briefing: document.getElementById('s-brief').value,
          definition,
        }),
      });
      document.getElementById('s-clear').click();
      await refreshScenarios();
      appendLog('Saved scenario.');
    } catch (err) {
      errBox.textContent = err.message;
    }
  });
}

// ---------- GitHub sync ----------

function setupGithubSync() {
  // Restore PAT from sessionStorage if present
  const savedPat = sessionStorage.getItem(PAT_KEY);
  if (savedPat) document.getElementById('gh-token').value = savedPat;

  document.getElementById('gh-sync').addEventListener('click', async () => {
    const status = document.getElementById('gh-status');
    status.style.color = '';
    status.textContent = 'Syncing...';
    const repo = document.getElementById('gh-repo').value.trim();
    const ref = document.getElementById('gh-ref').value.trim() || 'main';
    const dirPath = document.getElementById('gh-path').value.trim() || 'scenarios';
    const token = document.getElementById('gh-token').value.trim();
    if (!repo) { status.textContent = 'Enter a repo (owner/name).'; status.style.color = '#e01e5a'; return; }
    if (!token && !state.repoConfig.hasEnvToken) {
      status.textContent = 'Enter a PAT (or set SCENARIO_REPO_TOKEN).';
      status.style.color = '#e01e5a';
      return;
    }
    sessionStorage.setItem(PAT_KEY, token);
    sessionStorage.setItem(REPO_KEY, repo);
    sessionStorage.setItem(REF_KEY, ref);
    sessionStorage.setItem(PATH_KEY, dirPath);
    try {
      const r = await api('/api/admin/github/sync', {
        method: 'POST',
        body: JSON.stringify({ repo, ref, path: dirPath, token }),
      });
      const summary = `+${r.added} added, ${r.updated} updated, ${r.unchanged} unchanged`;
      const errSummary = r.errors && r.errors.length ? ` — ${r.errors.length} error(s)` : '';
      status.textContent = `${summary}${errSummary} (${r.repo}@${r.ref}:${r.path})`;
      status.style.color = r.errors && r.errors.length ? '#e01e5a' : '#2BAC76';
      if (r.errors && r.errors.length) {
        for (const e of r.errors) appendLog(`Sync error: ${e.path} — ${e.error}`);
      }
      appendLog(`Sync ${r.repo}@${r.ref}:${r.path} → ${summary}`);
      await refreshScenarios();
    } catch (err) {
      status.style.color = '#e01e5a';
      status.textContent = 'Error: ' + err.message;
    }
  });

  document.getElementById('gh-forget').addEventListener('click', () => {
    sessionStorage.removeItem(PAT_KEY);
    document.getElementById('gh-token').value = '';
    const status = document.getElementById('gh-status');
    status.textContent = 'PAT cleared from this browser session.';
    status.style.color = '';
  });
}

// ---------- active banner ----------

function setupActiveBanner() {
  document.getElementById('active-unload').addEventListener('click', async () => {
    try {
      await api('/api/admin/scenarios/unload', { method: 'POST' });
      appendLog('Unloaded active scenario.');
      await refreshState();
      await refreshScenarios();
    } catch (err) {
      appendLog('Error: ' + err.message);
    }
  });
}

// ---------- run log ----------

function appendLog(line) {
  const log = document.getElementById('s-log');
  if (log.textContent === 'No runs yet.') log.textContent = '';
  const ts = new Date().toLocaleTimeString();
  log.textContent += `[${ts}] ${line}\n`;
  log.scrollTop = log.scrollHeight;
}

// ---------- login ----------

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
    setupGithubSync();
    setupActiveBanner();
    await refreshState();
    await Promise.all([refreshPersonas(), refreshScenarios()]);
  } catch (err) {
    errBox.textContent = err.message;
  }
});
