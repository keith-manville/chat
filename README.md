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
| `SCENARIO_REPO` | *(unset)* | Default `owner/name` for the GitHub-sync form |
| `SCENARIO_REPO_REF` | `main` | Default branch / tag / sha |
| `SCENARIO_REPO_PATH` | `scenarios` | Default directory to scan |
| `SCENARIO_REPO_TOKEN` | *(unset)* | Optional fallback PAT (Contents: Read) |

## Scenario format

A scenario file looks like this. The whole file may also be wrapped in
`{ "name": ..., "description": ..., "briefing": ..., "definition": { ... } }`
when stored in your scenarios repo (see "Loading scenarios from GitHub" below).

```jsonc
{
  "name": "Phishing incident — Hour 1",
  "description": "Initial detection through containment",
  "briefing": "It is Tuesday 09:14. Acme's finance team just received a wave of MFA fatigue prompts...",
  "definition": {
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
      { "delay_ms": 30000, "channel": "general",           "username": "ceo",
        "body": "All-hands in 10." }
    ]
  }
}
```

- `briefing` is the world-state summary fed to AI personas as system context
  whenever the scenario is **loaded**. It's what keeps their replies grounded.
- `delay_ms` is relative to the *start* of a timeline run.
- Personas in `personas` are auto-created when the scenario is loaded or run,
  and auto-joined to every public channel.
- Channels referenced by events must already exist (the seeded `general`,
  `random`, `incident-response`, plus any you create in the UI).
- See [`scenarios/example.json`](./scenarios/example.json) — load it via the
  *Scenarios* tab → *Load example* to try it out.

## Load vs. Run vs. Unload

A scenario has two distinct phases in the facilitator console:

| Action | What it does |
| --- | --- |
| **Load**   | Sets this scenario as *active*. Personas in it are created and join the public channels. From this moment, every AI persona reply is grounded with the scenario's `briefing`, so responses stay consistent with the in-game world. Does **not** post any messages. |
| **Run timeline** | Plays the scripted `events` on their `delay_ms` schedule. Independent of Load — you can run a timeline without loading, or load without running. |
| **Stop**   | Cancels any pending timeline events for this scenario. |
| **Unload** | Clears the active scenario. AI personas go back to their bare persona prompts (no scenario context). |

A typical session: pick a scenario → **Load** → real users start chatting →
when you want pressure, click **Run timeline** to drop in scripted CEO/PR/SOC
messages on a schedule. AI personas respond in-character throughout.

## Loading scenarios from a private GitHub repo

You can keep your scenarios in a private GitHub repo and pull them into the
chat with one click.

### One-time setup

1. **Create a repo** (e.g. `acme/ctf-scenarios`) with a `scenarios/` folder
   containing one `*.json` file per scenario, each in the shape above.
2. **Generate a fine-grained PAT**: GitHub → Settings → Developer settings →
   Personal access tokens → Fine-grained tokens.
   - Resource owner: the org/user that owns the scenarios repo
   - Repository access: only the scenarios repo
   - Repository permissions: **Contents: Read-only**
3. Open `/admin` → *Scenarios* tab → *Sync from GitHub* card.
4. Enter the repo (`owner/name`), branch/ref (default `main`), path (default
   `scenarios`), and paste the PAT.
5. Click **Sync now**. You'll see `+N added, M updated, K unchanged`.

### Where the PAT lives

- The PAT is **never persisted on the server**. It is sent only on the sync
  request and discarded.
- The browser saves it in `sessionStorage` so you don't have to re-paste while
  you keep the admin tab open. Click **Forget token** to clear it.
- Optionally, set `SCENARIO_REPO_TOKEN` (and optionally `SCENARIO_REPO`,
  `SCENARIO_REPO_REF`, `SCENARIO_REPO_PATH`) as env vars so the form is
  pre-filled and the PAT can come from server config instead.

### Re-syncing

Each scenario is keyed by `repo@ref:path/to/file.json`, so re-syncing updates
in place and never creates duplicates. Local edits to a GitHub-sourced
scenario are overwritten on the next sync — keep authoritative content in the
repo, use the in-app editor for ad-hoc local scenarios.

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
