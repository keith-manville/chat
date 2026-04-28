const { db } = require('../db');
const { newId } = require('./util');
const { getScenario } = require('./scenarios');
const personas = require('./personas');
const cohorts = require('./cohorts');

// Used to detect a yes/no reply when the persona has asked "want a hint?"
const YES_RE = /^\s*(y|yes|yeah|yep|sure|ok(?:ay)?|please)\b/i;
const NO_RE = /^\s*(n|no|nope|nah)\b/i;

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

async function gradeAnswer(answer, attempt, { task = null } = {}) {
  if (!answer || typeof attempt !== 'string') return { correct: false };
  const text = attempt.trim();
  switch (answer.type) {
    case 'exact': {
      const target = String(answer.value ?? '');
      return {
        correct: answer.case_insensitive
          ? text.toLowerCase() === target.toLowerCase()
          : text === target,
      };
    }
    case 'contains': {
      const target = String(answer.value ?? '');
      return {
        correct: answer.case_insensitive
          ? text.toLowerCase().includes(target.toLowerCase())
          : text.includes(target),
      };
    }
    case 'regex': {
      try {
        const re = new RegExp(answer.pattern, answer.case_insensitive ? 'i' : '');
        return { correct: re.test(text) };
      } catch (err) {
        console.warn('[tasks] invalid regex:', err.message);
        return { correct: false };
      }
    }
    case 'ai_graded': {
      const result = await personas.aiGrade({
        rubric: answer.rubric,
        prompt: task && task.prompt,
        attempt: text,
      });
      if (!result) return { correct: false, rationale: 'Grader unavailable.' };
      return result;
    }
    default:
      return { correct: false };
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
  // Noise tasks don't occupy the persona's "active task" slot, so a follow-up
  // scored task can still grade replies in the same DM.
  if (!task.is_noise) {
    state.activeTasks[task.asks] = task.id;
    cohorts.setCurrentTask(run.id, task.id);
  }
  cohorts.writeRunState(run.id, state);

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

function pickNextHint(task, state) {
  const hints = (task.hints || []).slice();
  const revealed = (state.revealedHints && state.revealedHints[task.id]) || [];
  // Find the first hint whose after_attempts threshold is met and that hasn't
  // been revealed.
  const attempts = (state.attempts && state.attempts[task.id]) || 0;
  for (let i = 0; i < hints.length; i++) {
    if (revealed.includes(i)) continue;
    const h = hints[i];
    if (attempts >= (Number(h.after_attempts) || 1)) {
      return { hint: h, index: i };
    }
  }
  return null;
}

/**
 * Process a participant's reply in a persona DM. Returns one of:
 *
 *   { handled: false }                                    — no active task; let AI persona handle it.
 *   { handled: true, kind: 'correct', ... }               — task scored.
 *   { handled: true, kind: 'wrong', ... }                 — wrong answer recorded.
 *   { handled: true, kind: 'hint_offer', ... }            — persona should ask "want a hint?".
 *   { handled: true, kind: 'hint_revealed', ... }         — user said yes; reveal hint and deduct.
 *   { handled: true, kind: 'hint_declined', ... }         — user said no; carry on.
 *
 * gradeAnswer can be async (ai_graded), so this function is async too.
 */
async function gradeReply({ run, scenario, personaUsername, attemptText }) {
  const state = cohorts.readRunState(run);
  const activeTaskId = state.activeTasks && state.activeTasks[personaUsername];
  if (!activeTaskId) return { handled: false };
  const task = getTaskById(scenario, activeTaskId);
  if (!task) return { handled: false };
  if (task.is_noise) return { handled: false }; // noise tasks don't grade

  state.hintOffers = state.hintOffers || {};
  state.revealedHints = state.revealedHints || {};
  state.completed = state.completed || [];
  state.attempts = state.attempts || {};

  // ---- Hint offer state: if we're awaiting yes/no for a hint, handle that. ----
  const pendingOffer = state.hintOffers[task.id];
  if (pendingOffer && typeof pendingOffer.index === 'number') {
    if (YES_RE.test(attemptText)) {
      const idx = pendingOffer.index;
      const hint = (task.hints || [])[idx];
      const cost = Number(hint && hint.cost) || 0;
      // Reveal: deduct, mark, increment hints_used counter.
      const revealed = state.revealedHints[task.id] || [];
      revealed.push(idx);
      state.revealedHints[task.id] = revealed;
      delete state.hintOffers[task.id];
      cohorts.writeRunState(run.id, state);
      if (cost > 0) cohorts.bumpScore(run.id, -cost);
      cohorts.bumpHints(run.id, 1);
      return {
        handled: true,
        kind: 'hint_revealed',
        task,
        hintText: (hint && hint.text) || '(empty hint)',
        cost,
      };
    }
    if (NO_RE.test(attemptText)) {
      delete state.hintOffers[task.id];
      cohorts.writeRunState(run.id, state);
      return { handled: true, kind: 'hint_declined', task };
    }
    // Anything else: drop the pending offer and treat the message as an answer.
    delete state.hintOffers[task.id];
  }

  // ---- Normal answer flow. ----
  state.attempts[task.id] = (state.attempts[task.id] || 0) + 1;
  cohorts.writeRunState(run.id, state);

  const grading = await gradeAnswer(task.answer, attemptText, { task });

  if (grading.correct) {
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
    delete state.activeTasks[personaUsername];
    if (!state.completed.includes(task.id)) state.completed.push(task.id);
    cohorts.writeRunState(run.id, state);

    return {
      handled: true,
      kind: 'correct',
      task,
      points,
      firstBlood,
      onCorrectReply: task.on_correct && task.on_correct.reply,
      rationale: grading.rationale,
      followUps: getTasksAfter(scenario, task.id),
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
  const max = Number(task.max_attempts) || 0;
  const attempts = state.attempts[task.id];
  let exhausted = false;
  if (max > 0 && attempts >= max) {
    delete state.activeTasks[personaUsername];
    if (!state.completed.includes(task.id)) state.completed.push(task.id);
    exhausted = true;
  }
  // Should we offer a hint?
  const next = pickNextHint(task, state);
  let hintOffer = null;
  if (!exhausted && next) {
    state.hintOffers[task.id] = { index: next.index, offeredAt: Date.now() };
    hintOffer = next.hint;
  }
  cohorts.writeRunState(run.id, state);

  return {
    handled: true,
    kind: 'wrong',
    task,
    attempts,
    exhausted,
    onWrongReply: task.on_wrong && task.on_wrong.reply,
    rationale: grading.rationale,
    hintOffer, // populated => persona should ask "want a hint?"
    hintCost: hintOffer ? Number(hintOffer.cost) || 0 : 0,
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
