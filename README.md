# CTF Slack Clone

A Slack-styled team chat built on Node.js + Socket.io + SQLite, designed for
running tabletop / capture-the-flag exercises. Customers sign in with a
familiar chat UI; a facilitator drives the scenario from a separate console
using AI-generated personas and pre-scripted message timelines.

## Features

- **Slack-like UI** — workspace rail, dark sidebar, channels & DMs, message
  grouping, day dividers, typing indicators, presence dots, light formatting
  (`*bold*`, `_italic_`, `` `code` ``, links, `@mentions`).
- **Real-time messaging** via Socket.io with persistent SQLite history.
- **Multiple users & channels** — username-based sign-in (no password — this
  is a lab tool, not production), public channels, DMs.
- **AI personas** — bot users powered by the Anthropic Claude API. They
  respond when `@mentioned` and occasionally chime in. Each persona has its
  own system prompt.
- **Scenarios** — JSON timelines of scripted messages from any persona into
  any channel, played back on relative delays. Start, stop, edit and re-run
  from the facilitator console.
- **Manual injection** — facilitator can puppeteer any persona by typing as
  them in the admin console.
- **Dockerized** — single image, single volume for state. `docker compose up`
  and you are running.

## Quick start (Docker)

```bash
# 1. build & run
ADMIN_TOKEN=pickAStrongValue \
ANTHROPIC_API_KEY=sk-ant-...   \
docker compose up --build
```

Then:

- Open <http://localhost:3000/> — pick a username to sign in.
- Open <http://localhost:3000/admin> — facilitator console (use `ADMIN_TOKEN`).

`ANTHROPIC_API_KEY` is optional. If unset, AI personas stay silent unless the
facilitator drives them via scenarios or the *Inject message* tab.

## Running without Docker

```bash
npm install
ADMIN_TOKEN=pickAStrongValue ANTHROPIC_API_KEY=sk-ant-... npm start
```

State is persisted under `./data/chat.db` (or `$DATA_DIR`).

## Configuration (env vars)

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `DATA_DIR` | `./data` (or `/data` in Docker) | SQLite + WAL files |
| `ADMIN_TOKEN` | `changeme-admin` | Required to access `/admin` |
| `ANTHROPIC_API_KEY` | *(unset)* | Enables AI persona auto-replies |
| `PERSONA_MODEL` | `claude-haiku-4-5-20251001` | Model used for persona replies |
| `DEFAULT_WORKSPACE_NAME` | `CTF Workspace` | Sidebar title |

## Scenario format

```jsonc
{
  "personas": [
    {
      "username": "ceo",
      "displayName": "Pat Morgan (CEO)",
      "persona": "You are Pat Morgan, CEO of Acme Corp. ..."
    }
  ],
  "events": [
    { "delay_ms": 0,     "channel": "incident-response", "username": "ceo",
      "body": "Team — what is going on?" },
    { "delay_ms": 30000, "channel": "general",          "username": "ceo",
      "body": "All-hands in 10." }
  ]
}
```

- `delay_ms` is relative to the *start* of the run.
- Personas in the `personas` array are auto-created if missing and joined to
  every public channel.
- Channels referenced by events must already exist (the seeded `general`,
  `random`, `incident-response`, plus any you create in the UI).
- See [`scenarios/example.json`](./scenarios/example.json) — paste it into the
  *Scenarios* tab via *Load example* to try it out.

## Facilitator console (`/admin`)

Three tabs:

1. **Personas** — create/update AI persona bots and their system prompts.
2. **Inject message** — post as any user (real or persona) into any channel.
3. **Scenarios** — author, save, run, stop, and delete scenario timelines.

## Architecture

```
public/
  login.html, app.html, admin.html
  js/app.js, js/admin.js, css/slack.css
server.js          Express + Socket.io, REST + WS, bot trigger
db.js              better-sqlite3 schema + bootstrap workspace
lib/personas.js    AI persona registry + Anthropic SDK reply
lib/scenarios.js   Scenario CRUD + timeline runner
lib/util.js        ID + avatar helpers
Dockerfile         Two-stage Node 20 build
docker-compose.yml Single service + named volume for /data
```

Persistence is SQLite via `better-sqlite3` — single-file, journaled, perfect
for the lab/single-host use case. Scale-out is out of scope.

## Security notes

This is a **lab tool**. There is no real authentication — anyone who can
reach the port can claim any unclaimed username. Run it on a network you
trust (a CTF VPN, a private subnet, a localhost tunnel) and protect the
`/admin` endpoint with a strong `ADMIN_TOKEN`.
