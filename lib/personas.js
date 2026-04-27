const { db } = require('../db');
const { newId, pickAvatarColor } = require('./util');
// Note: getActiveScenarioContext below queries app_state directly to avoid a
// circular import with lib/scenarios.js.

let anthropicClient = null;
function getAnthropic() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
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

const MODEL = process.env.PERSONA_MODEL || 'claude-haiku-4-5-20251001';

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
  const client = getAnthropic();
  if (!client) {
    return null;
  }
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
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 400,
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userPrompt }],
    });
    const text = resp.content
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('')
      .trim();
    if (!text || text === 'NOOP') return null;
    return text;
  } catch (err) {
    console.error('[personas] generateBotReply error:', err.message);
    return null;
  }
}

module.exports = { ensureBot, listBots, generateBotReply, getAnthropic };
