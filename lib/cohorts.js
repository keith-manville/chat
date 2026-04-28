const { db, defaultWorkspaceId } = require('../db');
const { newId, generateJoinCode, normalizeJoinCode } = require('./util');
const { ensureBot } = require('./personas');
const { getScenario } = require('./scenarios');

const CHANNEL_TEMPLATE = [
  { name: 'general',       topic: 'Cohort discussion',                       posting_policy: 'open' },
  { name: 'instructions',  topic: 'How to play',                             posting_policy: 'engine' },
  { name: 'announcements', topic: 'From the proctor',                        posting_policy: 'proctor' },
  { name: 'scoreboard',    topic: 'Live scoreboard for this cohort',         posting_policy: 'engine' },
];

function _internalChannelName(cohortId, name) {
  return `c_${cohortId}_${name}`;
}

function rowToCohort(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    scenarioId: row.scenario_id,
    name: row.name,
    joinCode: row.join_code,
    createdAt: row.created_at,
    startedAt: row.started_at || null,
    endsAt: row.ends_at || null,
    closedAt: row.closed_at || null,
  };
}

function listCohorts(workspaceId = defaultWorkspaceId) {
  const cohorts = db
    .prepare('SELECT * FROM cohorts WHERE workspace_id = ? ORDER BY created_at DESC')
    .all(workspaceId)
    .map(rowToCohort);
  for (const c of cohorts) {
    const memberCount = db
      .prepare('SELECT COUNT(*) AS n FROM cohort_members WHERE cohort_id = ?')
      .get(c.id).n;
    c.memberCount = memberCount;
  }
  return cohorts;
}

function getCohort(id) {
  return rowToCohort(db.prepare('SELECT * FROM cohorts WHERE id = ?').get(id));
}

function getCohortByCode(code) {
  return rowToCohort(
    db.prepare('SELECT * FROM cohorts WHERE join_code = ?').get(normalizeJoinCode(code))
  );
}

function getUserPrimaryCohort(userId) {
  const row = db
    .prepare(
      `SELECT c.* FROM cohorts c
        JOIN cohort_members m ON m.cohort_id = c.id
        WHERE m.user_id = ? AND (c.closed_at IS NULL)
        ORDER BY m.joined_at DESC
        LIMIT 1`
    )
    .get(userId);
  return rowToCohort(row);
}

function getMembership(cohortId, userId) {
  return db
    .prepare('SELECT * FROM cohort_members WHERE cohort_id = ? AND user_id = ?')
    .get(cohortId, userId);
}

function listMembers(cohortId) {
  return db
    .prepare(
      `SELECT m.role, u.id, u.username, u.display_name, u.avatar_color, u.is_bot
         FROM cohort_members m JOIN users u ON u.id = m.user_id
        WHERE m.cohort_id = ?
        ORDER BY m.joined_at ASC`
    )
    .all(cohortId);
}

function createCohort({ workspaceId = defaultWorkspaceId, scenarioId, name, joinCode }) {
  if (!scenarioId) throw new Error('scenarioId required');
  if (!name) name = 'Cohort ' + new Date().toISOString().slice(0, 16).replace('T', ' ');
  // Caller may pre-supply a code (Instruqt invite id); else generate one.
  let code = joinCode ? normalizeJoinCode(joinCode) : null;
  if (code) {
    const taken = db.prepare('SELECT 1 FROM cohorts WHERE join_code = ?').get(code);
    if (taken) throw new Error('join_code_taken');
  } else {
    for (let i = 0; i < 10; i++) {
      code = generateJoinCode();
      const taken = db.prepare('SELECT 1 FROM cohorts WHERE join_code = ?').get(code);
      if (!taken) break;
      if (i === 9) throw new Error('failed_to_generate_unique_join_code');
    }
  }
  const id = newId('coh');
  const now = Date.now();
  db.prepare(
    `INSERT INTO cohorts (id, workspace_id, scenario_id, name, join_code, created_at, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, workspaceId, scenarioId, name, code, now, now);
  materializeChannels({ cohortId: id, workspaceId });
  return getCohort(id);
}

/**
 * Idempotent: if a cohort with `joinCode` already exists, return it; else
 * create one bound to `scenarioId` with the given name.
 */
function ensureCohort({ workspaceId = defaultWorkspaceId, joinCode, scenarioId, name }) {
  const code = normalizeJoinCode(joinCode);
  const existing = getCohortByCode(code);
  if (existing) return existing;
  if (!scenarioId) throw new Error('scenarioId required to create cohort');
  return createCohort({ workspaceId, scenarioId, name, joinCode: code });
}

function materializeChannels({ cohortId, workspaceId = defaultWorkspaceId }) {
  const now = Date.now();
  const out = [];
  for (const t of CHANNEL_TEMPLATE) {
    const internalName = _internalChannelName(cohortId, t.name);
    let row = db
      .prepare('SELECT * FROM channels WHERE workspace_id = ? AND name = ?')
      .get(workspaceId, internalName);
    if (!row) {
      const cid = newId('ch');
      db.prepare(
        `INSERT INTO channels
           (id, workspace_id, cohort_id, name, display_name, topic, is_private, is_dm, posting_policy, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`
      ).run(cid, workspaceId, cohortId, internalName, t.name, t.topic, t.posting_policy, now);
      row = db.prepare('SELECT * FROM channels WHERE id = ?').get(cid);
    }
    out.push(row);
  }
  return out;
}

function getCohortChannel({ cohortId, displayName, workspaceId = defaultWorkspaceId }) {
  return db
    .prepare(
      'SELECT * FROM channels WHERE workspace_id = ? AND cohort_id = ? AND display_name = ?'
    )
    .get(workspaceId, cohortId, displayName);
}

function ensureMembership(channelId, userId) {
  const exists = db
    .prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?')
    .get(channelId, userId);
  if (!exists) {
    db.prepare(
      'INSERT INTO channel_members (channel_id, user_id, joined_at) VALUES (?, ?, ?)'
    ).run(channelId, userId, Date.now());
  }
}

function ensureCohortPersonaDms({ cohortId, userId, workspaceId = defaultWorkspaceId }) {
  const cohort = getCohort(cohortId);
  if (!cohort) throw new Error('cohort_not_found');
  const scenario = getScenario(cohort.scenarioId);
  if (!scenario) throw new Error('scenario_not_found');
  const personas = (scenario.definition && scenario.definition.personas) || [];
  const dmChannels = [];
  for (const p of personas) {
    const bot = ensureBot({
      workspaceId,
      username: p.username,
      displayName: p.displayName || p.username,
      persona: p.persona || '',
    });
    // DM name uses cohort prefix so cohort A's "alice<->soc-manager" DM is
    // distinct from cohort B's, even when alice is in both.
    const ids = [userId, bot.id].sort();
    const dmName = `dm:${cohortId}:${ids[0]}:${ids[1]}`;
    let ch = db
      .prepare('SELECT * FROM channels WHERE workspace_id = ? AND name = ?')
      .get(workspaceId, dmName);
    if (!ch) {
      const cid = newId('ch');
      db.prepare(
        `INSERT INTO channels
           (id, workspace_id, cohort_id, name, display_name, is_private, is_dm, posting_policy, created_at)
         VALUES (?, ?, ?, ?, NULL, 1, 1, 'open', ?)`
      ).run(cid, workspaceId, cohortId, dmName, Date.now());
      ch = db.prepare('SELECT * FROM channels WHERE id = ?').get(cid);
    }
    ensureMembership(ch.id, userId);
    ensureMembership(ch.id, bot.id);
    dmChannels.push({ channel: ch, persona: bot });
  }
  return dmChannels;
}

function listVisibleChannels(userId) {
  // Channels the user is a member of, scoped to cohorts they belong to (DMs
  // also resolved through channel_members).
  return db
    .prepare(
      `SELECT c.*
         FROM channels c
         JOIN channel_members cm ON cm.channel_id = c.id AND cm.user_id = ?
        ORDER BY c.is_dm ASC, COALESCE(c.display_name, c.name) ASC`
    )
    .all(userId);
}

function joinCohort({ code, userId, workspaceId = defaultWorkspaceId }) {
  const cohort = getCohortByCode(code);
  if (!cohort) throw new Error('invalid_join_code');
  if (cohort.closedAt) throw new Error('cohort_closed');

  const now = Date.now();
  // Insert membership (idempotent)
  const existing = getMembership(cohort.id, userId);
  if (!existing) {
    db.prepare(
      'INSERT INTO cohort_members (cohort_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)'
    ).run(cohort.id, userId, 'participant', now);
  }

  // Add to cohort channels
  const channels = materializeChannels({ cohortId: cohort.id, workspaceId });
  for (const ch of channels) ensureMembership(ch.id, userId);

  // Create persona DMs
  const dmChannels = ensureCohortPersonaDms({ cohortId: cohort.id, userId, workspaceId });

  // Create or fetch game_run
  let run = db
    .prepare('SELECT * FROM game_runs WHERE cohort_id = ? AND user_id = ?')
    .get(cohort.id, userId);
  let isNewRun = false;
  if (!run) {
    const id = newId('run');
    db.prepare(
      `INSERT INTO game_runs
         (id, cohort_id, user_id, scenario_id, score, hints_used, state_json, started_at, last_activity_at)
       VALUES (?, ?, ?, ?, 0, 0, '{}', ?, ?)`
    ).run(id, cohort.id, userId, cohort.scenarioId, now, now);
    run = db.prepare('SELECT * FROM game_runs WHERE id = ?').get(id);
    isNewRun = true;
  }

  return { cohort, channels, dmChannels, run, isNewRun };
}

function getRun(cohortId, userId) {
  return db
    .prepare('SELECT * FROM game_runs WHERE cohort_id = ? AND user_id = ?')
    .get(cohortId, userId);
}

function listRuns(cohortId) {
  return db
    .prepare(
      `SELECT r.*, u.username, u.display_name, u.avatar_color
         FROM game_runs r JOIN users u ON u.id = r.user_id
        WHERE r.cohort_id = ?
        ORDER BY r.score DESC, r.last_activity_at ASC`
    )
    .all(cohortId);
}

function readRunState(run) {
  try { return JSON.parse(run.state_json || '{}'); } catch { return {}; }
}
function writeRunState(runId, state) {
  db.prepare('UPDATE game_runs SET state_json = ?, last_activity_at = ? WHERE id = ?').run(
    JSON.stringify(state),
    Date.now(),
    runId
  );
}
function bumpScore(runId, delta) {
  db.prepare(
    'UPDATE game_runs SET score = score + ?, last_activity_at = ? WHERE id = ?'
  ).run(delta, Date.now(), runId);
}

function bumpHints(runId, delta) {
  db.prepare('UPDATE game_runs SET hints_used = hints_used + ? WHERE id = ?').run(delta, runId);
}

function setCurrentTask(runId, taskId) {
  db.prepare('UPDATE game_runs SET current_task_id = ?, last_activity_at = ? WHERE id = ?').run(
    taskId || null,
    Date.now(),
    runId
  );
}

module.exports = {
  CHANNEL_TEMPLATE,
  listCohorts,
  getCohort,
  getCohortByCode,
  getUserPrimaryCohort,
  getMembership,
  listMembers,
  createCohort,
  ensureCohort,
  materializeChannels,
  getCohortChannel,
  ensureMembership,
  ensureCohortPersonaDms,
  listVisibleChannels,
  joinCohort,
  getRun,
  listRuns,
  readRunState,
  writeRunState,
  bumpScore,
  bumpHints,
  setCurrentTask,
};
