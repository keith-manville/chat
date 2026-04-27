const { db, defaultWorkspaceId } = require('../db');
const { newId } = require('./util');
const { ensureBot } = require('./personas');

function listScenarios(workspaceId = defaultWorkspaceId) {
  return db
    .prepare('SELECT id, name, description, created_at FROM scenarios WHERE workspace_id = ? ORDER BY created_at DESC')
    .all(workspaceId);
}

function getScenario(id) {
  const row = db.prepare('SELECT * FROM scenarios WHERE id = ?').get(id);
  if (!row) return null;
  return { ...row, definition: JSON.parse(row.definition) };
}

function saveScenario({ id, workspaceId = defaultWorkspaceId, name, description, definition }) {
  const json = JSON.stringify(definition);
  if (id) {
    db.prepare('UPDATE scenarios SET name = ?, description = ?, definition = ? WHERE id = ?').run(
      name,
      description || '',
      json,
      id
    );
    return id;
  }
  const newScenarioId = newId('sc');
  db.prepare(
    'INSERT INTO scenarios (id, workspace_id, name, description, definition, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(newScenarioId, workspaceId, name, description || '', json, Date.now());
  return newScenarioId;
}

function deleteScenario(id) {
  db.prepare('DELETE FROM scenarios WHERE id = ?').run(id);
}

/**
 * A scenario definition looks like:
 * {
 *   "personas": [
 *     { "username": "ceo", "displayName": "Pat Morgan (CEO)", "persona": "You are the CEO..." }
 *   ],
 *   "events": [
 *     { "delay_ms": 0, "channel": "incident-response", "username": "ceo", "body": "Heads up team..." },
 *     { "delay_ms": 30000, "channel": "general", "username": "secops", "body": "Investigating..." }
 *   ]
 * }
 *
 * runScenario plays the events through the post() callback that the caller provides.
 * Returns a handle with stop() to cancel pending events.
 */
function runScenario({ scenario, workspaceId = defaultWorkspaceId, post, onLog = () => {} }) {
  const def = scenario.definition;
  const personas = def.personas || [];
  for (const p of personas) {
    ensureBot({
      workspaceId,
      username: p.username,
      displayName: p.displayName || p.username,
      persona: p.persona || '',
    });
  }

  const timers = [];
  const startedAt = Date.now();
  let stopped = false;

  for (let i = 0; i < (def.events || []).length; i++) {
    const ev = def.events[i];
    const delay = Math.max(0, Number(ev.delay_ms) || 0);
    const t = setTimeout(async () => {
      if (stopped) return;
      try {
        await post(ev);
        onLog({
          ts: Date.now(),
          index: i,
          event: ev,
          status: 'posted',
        });
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

module.exports = { listScenarios, getScenario, saveScenario, deleteScenario, runScenario };
