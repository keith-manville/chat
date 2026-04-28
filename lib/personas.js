const { db } = require('../db');
const { newId, pickAvatarColor } = require('./util');
// Note: getActiveScenarioContext below queries app_state directly to avoid a
// circular import with lib/scenarios.js.

// ---------- LLM provider selection ----------
//
// Provider is auto-detected from env vars:
//   ANTHROPIC_API_KEY  → Anthropic (Claude)
//   GEMINI_API_KEY     → Google Gemini
// If both are set, ANTHROPIC wins by default. Override with LLM_PROVIDER=gemini
// (or =anthropic). Pick the model with PERSONA_MODEL; default depends on provider.

function getProvider() {
  const override = (process.env.LLM_PROVIDER || '').toLowerCase().trim();
  if (override === 'anthropic') return process.env.ANTHROPIC_API_KEY ? 'anthropic' : null;
  if (override === 'gemini') return process.env.GEMINI_API_KEY ? 'gemini' : null;
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (process.env.GEMINI_API_KEY) return 'gemini';
  return null;
}

function getModel(provider = getProvider()) {
  if (process.env.PERSONA_MODEL) return process.env.PERSONA_MODEL;
  if (provider === 'anthropic') return 'claude-haiku-4-5-20251001';
  if (provider === 'gemini') return 'gemini-2.5-flash';
  return null;
}

function isAiEnabled() {
  return !!getProvider();
}

let anthropicClient = null;
function getAnthropic() {
  if (getProvider() !== 'anthropic') return null;
  if (anthropicClient) return anthropicClient;
  try {
    const Anthropic = require('@anthropic-ai/sdk').default;
    anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    return anthropicClient;
  } catch (err) {
    console.warn('[personas] Anthropic SDK unavailable:', err.message);
    return null;
  }
}

async function callAnthropic({ systemPrompt, userPrompt, model }) {
  const client = getAnthropic();
  if (!client) return null;
  const resp = await client.messages.create({
    model,
    max_tokens: 400,
    system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userPrompt }],
  });
  return resp.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('')
    .trim();
}

async function callGemini({ systemPrompt, userPrompt, model }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent` +
    `?key=${encodeURIComponent(apiKey)}`;
  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig: { maxOutputTokens: 400, temperature: 0.7 },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Gemini ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
  return parts.map((p) => p.text || '').join('').trim();
}

function ensureBot({ workspaceId, username, displayName, persona }) {
  let user = db
    .prepare('SELECT * FROM users WHERE workspace_id = ? AND username = ?')
    .get(workspaceId, username);
  if (user) {
    if (persona) {
      db.prepare('UPDATE users SET bot_persona = ?, display_name = ? WHERE id = ?').run(
        persona,
        displayName || user.display_name,
        user.id
      );
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    }
    return user;
  }
  const id = newId('u');
  db.prepare(
    'INSERT INTO users (id, workspace_id, username, display_name, avatar_color, is_bot, bot_persona, created_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)'
  ).run(id, workspaceId, username, displayName || username, pickAvatarColor(username), persona || '', Date.now());
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function listBots(workspaceId) {
  return db
    .prepare('SELECT * FROM users WHERE workspace_id = ? AND is_bot = 1 ORDER BY display_name')
    .all(workspaceId);
}

function recentMessages(channelId, limit = 20) {
  const rows = db
    .prepare(
      `SELECT m.body, u.display_name AS author, m.created_at
       FROM messages m JOIN users u ON u.id = m.user_id
       WHERE m.channel_id = ?
       ORDER BY m.created_at DESC
       LIMIT ?`
    )
    .all(channelId, limit);
  return rows.reverse();
}

function getActiveScenarioContext(workspaceId) {
  const row = db
    .prepare(
      `SELECT s.name, s.description, s.briefing
         FROM app_state a
         JOIN scenarios s ON s.id = a.active_scenario_id
        WHERE a.workspace_id = ?`
    )
    .get(workspaceId);
  if (!row) return null;
  return {
    name: row.name,
    description: row.description || '',
    briefing: row.briefing || '',
  };
}

async function generateBotReply({ bot, channel, triggerMessage }) {
  const provider = getProvider();
  if (!provider) return null;
  const model = getModel(provider);
  const history = recentMessages(channel.id, 25);
  const scenario = getActiveScenarioContext(bot.workspace_id);

  const lines = [];
  if (scenario) {
    lines.push('SCENARIO BRIEFING (this is the in-game situation you are reacting to):');
    lines.push(`Title: ${scenario.name}`);
    if (scenario.description) lines.push(`Summary: ${scenario.description}`);
    if (scenario.briefing) lines.push(scenario.briefing);
    lines.push('');
    lines.push('Stay grounded in this scenario. Do not invent facts that contradict it.');
    lines.push('Do not break character to acknowledge that this is a simulation.');
    lines.push('');
  }
  lines.push(
    bot.bot_persona || `You are ${bot.display_name}, a helpful colleague in a Slack workspace.`
  );
  lines.push('');
  lines.push(`You are participating in the #${channel.name} channel of a chat workspace.`);
  lines.push(`Channel topic: ${channel.topic || 'n/a'}.`);
  lines.push('Stay in character. Keep replies short and conversational, like Slack messages.');
  lines.push('Do not narrate actions in asterisks. Do not include your own name as a prefix. Plain text only.');
  lines.push('If the conversation does not require your input, reply with the exact token NOOP and nothing else.');
  const systemPrompt = lines.join('\n');

  const transcript = history
    .map((m) => `${m.author}: ${m.body}`)
    .join('\n');

  const userPrompt = [
    'Recent channel transcript (oldest first):',
    transcript || '(empty)',
    '',
    triggerMessage ? `New message just posted by ${triggerMessage.author}: "${triggerMessage.body}"` : '',
    '',
    `Respond as ${bot.display_name}. If a response would be unwarranted, reply NOOP.`,
  ].join('\n');

  try {
    let text = null;
    if (provider === 'anthropic') {
      text = await callAnthropic({ systemPrompt, userPrompt, model });
    } else if (provider === 'gemini') {
      text = await callGemini({ systemPrompt, userPrompt, model });
    }
    if (!text) return null;
    text = text.trim();
    if (!text || text === 'NOOP') return null;
    return text;
  } catch (err) {
    console.error(`[personas] ${provider} reply error:`, err.message);
    return null;
  }
}

/**
 * Ask the active LLM whether `attempt` satisfies a free-form `rubric`.
 * Returns { correct: boolean, rationale: string } or null on failure.
 *
 * The model is instructed to reply with a strict JSON object so we don't
 * have to fight prose parsing.
 */
async function aiGrade({ rubric, prompt, attempt }) {
  const provider = getProvider();
  if (!provider) return null;
  const model = getModel(provider);
  const systemPrompt = [
    'You are a strict but fair grader for a security CTF challenge.',
    'You will be given a rubric, the prompt the participant was asked, and their attempted answer.',
    'Return ONLY a JSON object with this exact shape and no other text:',
    '{"correct": <true|false>, "rationale": "<one short sentence>"}',
    'Mark correct=true only if the attempt clearly satisfies the rubric. Vague answers are not correct.',
  ].join('\n');
  const userPrompt = [
    `RUBRIC:\n${rubric || '(none provided)'}`,
    '',
    `PROMPT:\n${prompt || '(none)'}`,
    '',
    `ATTEMPT:\n${attempt}`,
  ].join('\n');
  try {
    let text = null;
    if (provider === 'anthropic') {
      text = await callAnthropic({ systemPrompt, userPrompt, model });
    } else if (provider === 'gemini') {
      text = await callGemini({ systemPrompt, userPrompt, model });
    }
    if (!text) return null;
    // Pull the first JSON object out of the text.
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]);
    return {
      correct: !!parsed.correct,
      rationale: String(parsed.rationale || '').slice(0, 240),
    };
  } catch (err) {
    console.error(`[personas] aiGrade ${provider} error:`, err.message);
    return null;
  }
}

module.exports = {
  ensureBot,
  listBots,
  generateBotReply,
  aiGrade,
  getAnthropic, // kept for back-compat; null when provider != anthropic
  getProvider,
  getModel,
  isAiEnabled,
};
