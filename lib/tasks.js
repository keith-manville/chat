const { db } = require('../db');
const { newId } = require('./util');
const { getScenario } = require('./scenarios');
const cohorts = require('./cohorts');

/**
 * Task model (Swing 1):
 *
 *   {
 *     id: 't1-vector',
 *     asks: 'soc-analyst',           // persona username (DM owner)
 *     trigger: 'start' | 'after:<task-id>',
 *     prompt: '...',
 *     is_noise: false,                // optional; noise tasks don't grade
 *     answer: { type: 'exact'|'regex'|'contains', ...spec },
 *     points: 100,
 *     first_blood_bonus: 25,
 *     max_attempts: 5,
 *     on_correct: { reply, next: 'task-id' },
 *     on_wrong:   { reply }
 *   }
 *
 * Per-run state lives in game_runs.state_json:
 *   {
 *     activeTasks:   { [persona_username]: 'task-id' },
 *     completed:     [ 'task-id', ... ],
 *     attempts:      { 'task-id': N }
 *   }
 */

function getTasks(scenario) {
  return (scenario.definition && scenario.definition.tasks) || [];
}

function getTaskById(scenario, id) {
  return getTasks(scenario).find((t) => t.id === id) || null;
}

function getTasksByTrigger(scenario, trigger) {
  return getTasks(scenario).filter((t) => t.trigger === trigger);
}

function getTasksAfter(scenario, parentTaskId) {
  return getTasks(scenario).filter((t) => t.trigger === `after:${parentTaskId}`);
}

function gradeAnswer(answer, attempt) {
  if (!answer || typeof attempt !== 'string') return false;
  const text = attempt.trim();
  switch (answer.type) {
    case 'exact': {
      const target = String(answer.value ?? '');
      return answer.case_insensitive
        ? text.toLowerCase() === target.toLowerCase()
        : text === target;
    }
    case 'contains': {
      const target = String(answer.value ?? '');
      return answer.case_insensitive
        ? text.toLowerCase().includes(target.toLowerCase())
        : text.includes(target);
    }
    case 'regex': {
      try {
        const re = new RegExp(answer.pattern, answer.case_insensitive ? 'i' : '');
        return re.test(text);
      } catch (err) {
        console.warn('[tasks] invalid regex:', err.message);
        return false;
      }
    }
    case 'ai_graded':
      // Reserved for Swing 2.
      return false;
    default:
      return false;
  }
}

function recordAttempt({ runId, taskId, attemptText, isCorrect, pointsDelta, wasFirstBlood }) {
  const id = newId('att');
  db.prepare(
    `INSERT INTO task_attempts
       (id, run_id, task_id, attempt_text, is_correct, points_delta, was_first_blood, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    runId,
    taskId,
    attemptText.slice(0, 500),
    isCorrect ? 1 : 0,
    pointsDelta || 0,
    wasFirstBlood ? 1 : 0,
    Date.now()
  );
}

function isFirstBlood(cohortId, taskId) {
  const row = db
    .prepare(
      `SELECT 1 FROM task_attempts a
         JOIN game_runs r ON r.id = a.run_id
        WHERE r.cohort_id = ? AND a.task_id = ? AND a.is_correct = 1
        LIMIT 1`
    )
    .get(cohortId, taskId);
  return !row;
}

/**
 * Fire all tasks with a given trigger ('start' or 'after:<id>'). For each
 * task, the persona DMs the user the prompt. Caller provides `post(payload)`
 * which posts a message; payload is { channel, username, body }.
 */
async function fireTasks({ run, scenario, trigger, post, onError = () => {} }) {
  const tasks = getTasksByTrigger(scenario, trigger);
  for (const t of tasks) {
    try {
      await fireTask({ run, scenario, task: t, post });
    } catch (err) {
      onError({ task: t, error: err.message });
    }
  }
  return tasks.length;
}

async function fireTask({ run, scenario, task, post }) {
  const state = cohorts.readRunState(run);
  state.activeTasks = state.activeTasks || {};
  // Track which persona has which active task.
  state.activeTasks[task.asks] = task.id;
  cohorts.writeRunState(run.id, state);
  cohorts.setCurrentTask(run.id, task.id);

  // Find the user's DM with this persona (within the cohort) and post the prompt.
  const dm = findPersonaDm({ cohortId: run.cohort_id, userId: run.user_id, personaUsername: task.asks });
  if (!dm) {
    throw new Error(`No DM with persona @${task.asks} for run ${run.id}`);
  }
  await post({ channel: dm.channel, persona: dm.persona, body: task.prompt });
}

function findPersonaDm({ cohortId, userId, personaUsername }) {
  const persona = db
    .prepare(
      `SELECT * FROM users
        WHERE is_bot = 1 AND username = ?
          AND workspace_id = (SELECT workspace_id FROM cohorts WHERE id = ?)`
    )
    .get(personaUsername, cohortId);
  if (!persona) return null;
  const ids = [userId, persona.id].sort();
  const dmName = `dm:${cohortId}:${ids[0]}:${ids[1]}`;
  const channel = db
    .prepare('SELECT * FROM channels WHERE name = ?')
    .get(dmName);
  if (!channel) return null;
  return { channel, persona };
}

/**
 * Process a participant's reply in a persona DM. If there's an active task
 * for that (run, persona), grade it and act accordingly.
 *
 * Returns a result object describing what happened — caller is responsible
 * for posting any persona replies.
 */
function gradeReply({ run, scenario, personaUsername, attemptText }) {
  const state = cohorts.readRunState(run);
  const activeTaskId = state.activeTasks && state.activeTasks[personaUsername];
  if (!activeTaskId) return { handled: false };
  const task = getTaskById(scenario, activeTaskId);
  if (!task) return { handled: false };
  if (task.is_noise) return { handled: false }; // noise tasks don't grade

  state.attempts = state.attempts || {};
  state.attempts[task.id] = (state.attempts[task.id] || 0) + 1;
  state.completed = state.completed || [];

  const correct = gradeAnswer(task.answer, attemptText);

  if (correct) {
    let firstBlood = false;
    if (isFirstBlood(run.cohort_id, task.id)) firstBlood = true;
    let points = Number(task.points) || 0;
    if (firstBlood) points += Number(task.first_blood_bonus) || 0;
    cohorts.bumpScore(run.id, points);
    recordAttempt({
      runId: run.id,
      taskId: task.id,
      attemptText,
      isCorrect: true,
      pointsDelta: points,
      wasFirstBlood: firstBlood,
    });
    // Mark complete; clear active for this persona; advance.
    delete state.activeTasks[personaUsername];
    if (!state.completed.includes(task.id)) state.completed.push(task.id);
    cohorts.writeRunState(run.id, state);

    const followUps = getTasksAfter(scenario, task.id);
    return {
      handled: true,
      task,
      correct: true,
      points,
      firstBlood,
      onCorrectReply: task.on_correct && task.on_correct.reply,
      followUps,
    };
  }

  // Wrong answer.
  recordAttempt({
    runId: run.id,
    taskId: task.id,
    attemptText,
    isCorrect: false,
    pointsDelta: 0,
    wasFirstBlood: false,
  });
  const max = Number(task.max_attempts) || 0; // 0 = unlimited
  const attempts = state.attempts[task.id];
  let exhausted = false;
  if (max > 0 && attempts >= max) {
    delete state.activeTasks[personaUsername];
    state.completed.push(task.id);
    exhausted = true;
  }
  cohorts.writeRunState(run.id, state);

  return {
    handled: true,
    task,
    correct: false,
    attempts,
    exhausted,
    onWrongReply: task.on_wrong && task.on_wrong.reply,
  };
}

module.exports = {
  getTasks,
  getTaskById,
  getTasksByTrigger,
  getTasksAfter,
  gradeAnswer,
  fireTasks,
  fireTask,
  gradeReply,
  findPersonaDm,
};
