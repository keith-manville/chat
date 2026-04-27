const { db, defaultWorkspaceId } = require('../db');
const { newId } = require('./util');
const { ensureBot } = require('./personas');

function rowToScenario(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    description: row.description || '',
    briefing: row.briefing || '',
    source: row.source || 'local',
    sourceRef: row.source_ref || null,
    sourceSha: row.source_sha || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at || row.created_at,
    definition: JSON.parse(row.definition),
  };
}

function listScenarios(workspaceId = defaultWorkspaceId) {
  return db
    .prepare(
      `SELECT id, workspace_id, name, description, briefing, source, source_ref, source_sha, created_at, updated_at
       FROM scenarios WHERE workspace_id = ?
       ORDER BY source ASC, name ASC`
    )
    .all(workspaceId)
    .map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description || '',
      briefing: r.briefing || '',
      source: r.source || 'local',
      sourceRef: r.source_ref || null,
      sourceSha: r.source_sha || null,
      createdAt: r.created_at,
      updatedAt: r.updated_at || r.created_at,
    }));
}

function getScenario(id) {
  const row = db.prepare('SELECT * FROM scenarios WHERE id = ?').get(id);
  return rowToScenario(row);
}

function getScenarioByRef(sourceRef) {
  const row = db.prepare('SELECT * FROM scenarios WHERE source_ref = ?').get(sourceRef);
  return rowToScenario(row);
}

function saveLocalScenario({
  id,
  workspaceId = defaultWorkspaceId,
  name,
  description,
  briefing,
  definition,
}) {
  const json = JSON.stringify(definition);
  const now = Date.now();
  if (id) {
    db.prepare(
      `UPDATE scenarios
         SET name = ?, description = ?, briefing = ?, definition = ?, updated_at = ?
       WHERE id = ?`
    ).run(name, description || '', briefing || '', json, now, id);
    return id;
  }
  const newScenarioId = newId('sc');
  db.prepare(
    `INSERT INTO scenarios (id, workspace_id, name, description, briefing, definition, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'local', ?, ?)`
  ).run(newScenarioId, workspaceId, name, description || '', briefing || '', json, now, now);
  return newScenarioId;
}

/**
 * Upsert a scenario pulled from GitHub, keyed by sourceRef.
 * Returns { id, status: 'added' | 'updated' | 'unchanged' }.
 */
function upsertGithubScenario({
  workspaceId = defaultWorkspaceId,
  name,
  description,
  briefing,
  definition,
  sourceRef,
  sourceSha,
}) {
  const existing = db
    .prepare('SELECT id, source_sha FROM scenarios WHERE source_ref = ?')
    .get(sourceRef);
  const json = JSON.stringify(definition);
  const now = Date.now();
  if (existing) {
    if (existing.source_sha === sourceSha) {
      return { id: existing.id, status: 'unchanged' };
    }
    db.prepare(
      `UPDATE scenarios
         SET name = ?, description = ?, briefing = ?, definition = ?, source_sha = ?, updated_at = ?
       WHERE id = ?`
    ).run(name, description || '', briefing || '', json, sourceSha, now, existing.id);
    return { id: existing.id, status: 'updated' };
  }
  const id = newId('sc');
  db.prepare(
    `INSERT INTO scenarios (id, workspace_id, name, description, briefing, definition,
                           source, source_ref, source_sha, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'github', ?, ?, ?, ?)`
  ).run(
    id,
    workspaceId,
    name,
    description || '',
    briefing || '',
    json,
    sourceRef,
    sourceSha,
    now,
    now
  );
  return { id, status: 'added' };
}

function deleteScenario(id) {
  db.prepare('DELETE FROM scenarios WHERE id = ?').run(id);
}

// ---------- Active scenario state ----------

function getActiveScenario(workspaceId = defaultWorkspaceId) {
  const state = db
    .prepare('SELECT active_scenario_id FROM app_state WHERE workspace_id = ?')
    .get(workspaceId);
  if (!state || !state.active_scenario_id) return null;
  return getScenario(state.active_scenario_id);
}

function setActiveScenario({ workspaceId = defaultWorkspaceId, scenarioId }) {
  const now = Date.now();
  const exists = db
    .prepare('SELECT workspace_id FROM app_state WHERE workspace_id = ?')
    .get(workspaceId);
  if (exists) {
    db.prepare(
      'UPDATE app_state SET active_scenario_id = ?, updated_at = ? WHERE workspace_id = ?'
    ).run(scenarioId || null, now, workspaceId);
  } else {
    db.prepare(
      'INSERT INTO app_state (workspace_id, active_scenario_id, updated_at) VALUES (?, ?, ?)'
    ).run(workspaceId, scenarioId || null, now);
  }
}

/**
 * Ensure all personas declared in a scenario exist and return the bot rows.
 * Caller is responsible for joining them to channels.
 */
function ensureScenarioPersonas({ workspaceId = defaultWorkspaceId, scenario }) {
  const personas = (scenario.definition && scenario.definition.personas) || [];
  const bots = [];
  for (const p of personas) {
    const bot = ensureBot({
      workspaceId,
      username: p.username,
      displayName: p.displayName || p.username,
      persona: p.persona || '',
    });
    bots.push(bot);
  }
  return bots;
}

// ---------- Scenario timeline runner ----------

function runScenario({ scenario, workspaceId = defaultWorkspaceId, post, onLog = () => {} }) {
  // Make sure personas exist before scheduling events that reference them.
  ensureScenarioPersonas({ workspaceId, scenario });

  const events = (scenario.definition && scenario.definition.events) || [];
  const timers = [];
  const startedAt = Date.now();
  let stopped = false;

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const delay = Math.max(0, Number(ev.delay_ms) || 0);
    const t = setTimeout(async () => {
      if (stopped) return;
      try {
        await post(ev);
        onLog({ ts: Date.now(), index: i, event: ev, status: 'posted' });
      } catch (err) {
        onLog({ ts: Date.now(), index: i, event: ev, status: 'error', error: err.message });
      }
    }, delay);
    timers.push(t);
  }

  return {
    startedAt,
    stop() {
      stopped = true;
      for (const t of timers) clearTimeout(t);
    },
  };
}

module.exports = {
  listScenarios,
  getScenario,
  getScenarioByRef,
  saveLocalScenario,
  // Back-compat alias used by existing server code paths.
  saveScenario: saveLocalScenario,
  upsertGithubScenario,
  deleteScenario,
  getActiveScenario,
  setActiveScenario,
  ensureScenarioPersonas,
  runScenario,
};
