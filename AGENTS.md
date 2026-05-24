# Thronglets — Agent Guide

You are working on the **Thronglets** codebase — a multi-agent fleet system that connects AI coding agents to messaging platforms (Telegram, Lark, Discord).

## First-time setup checklist

Before anything else, help the user get running. Walk through these steps interactively:

### 1. Prerequisites
- **Node.js 18+** — check with `node -v`
- **A Telegram bot token** — create via [@BotFather](https://t.me/BotFather) on Telegram
- **A Cursor API key** — get from [cursor.com/settings](https://cursor.com/settings)

### 2. Configuration
```bash
cp config.yaml.example ~/.thronglets/config.yaml
```

**Ask the user for:**
- Telegram bot token
- Cursor API key
- Their Telegram chat ID (tell them to message [@userinfobot](https://t.me/userinfobot) to get it)
- Preferred model (default: `claude-sonnet-4-6`, other options: `claude-opus-4-6`)

Fill in `config.yaml` with their answers. Set `allowed_chats` to their chat ID.

### 3. Install & start
```bash
npm install
npm start
```

### 4. Dashboard & IDE

The dashboard is both a fleet visualization tool and a mini IDE for interacting with agents. Build it before first use:

```bash
cd packages/dashboard
npm install
npm run build
cd ../..
```

Then restart the service — dashboard at `http://localhost:3847`.

**Remote server:** The service binds to `127.0.0.1`. Use SSH port forwarding:
```bash
ssh -L 3847:127.0.0.1:3847 user@server
# Then open http://localhost:3847 in your browser
```

### 5. Post-startup verification

After `npm start`, check that everything initialized correctly:

**Logs should show:**
- `[telegram] transport started` — bot is connected
- `[dispatcher] spawned` or `[dispatcher] restored` — dispatcher is alive
- `[server] listening on :3847` — API + dashboard ready

**API health:**
```bash
curl http://localhost:3847/health
# → {"ok": true}
```

**Telegram:** Send `/start` to the bot — it should respond with a welcome message.

**Folder structure — verify these exist after first startup:**
```
~/.thronglets/              # THRONGLETS_HOME (or ~/.agent-bridge for legacy installs)
├── config.yaml             # Must exist (you created this in step 2)
├── workspaces.yaml         # Auto-created on first workspace registration
├── fleet/
│   ├── fleet-state.json    # Auto-created on first agent spawn
│   └── sessions/           # Per-agent conversation logs
└── dispatch/               # Dispatcher workspace (auto-provisioned)
    ├── AGENTS.md            # Dispatcher identity + instructions
    ├── memory/
    │   └── goal.md          # User-defined goal (created on first /poke or goal set)
    └── tools/               # Scripts the dispatcher can create for itself
```

If `dispatch/` or `dispatch/AGENTS.md` is missing, the auto-provisioning may have failed. Check logs for `[dispatcher]` errors and restart.

## Architecture

```
src/
├── index.ts              # Entry point, startup orchestration
├── config.ts             # YAML config loading (global + workspace merge)
├── cli.ts                # CLI argument parsing
├── rules-sync.ts         # Cross-runtime rules synchronization
├── commands/
│   └── telegram.ts       # Telegram command routing (/hatch, /kill, /fleet, @mentions)
├── fleet/
│   ├── manager.ts        # FleetManager: spawn, kill, send, restore, workspace CRUD
│   ├── health-monitor.ts # Periodic agent health checks and auto-recovery
│   ├── dispatcher.ts     # AI dispatcher: auto-spawn, workspace provisioning
│   ├── preamble.ts       # System prompt generation for agents
│   ├── tools.ts          # Fleet tools (fleet_send, fleet_status, fleet_set_goal)
│   ├── state.ts          # File-based persistence (fleet-state.json, workspaces.yaml)
│   ├── workspace-init.ts # Auto-provision agent workspace directories
│   ├── naming.ts         # Procedural name generation (auto-assigned, never user-chosen)
│   └── types.ts          # TypeScript interfaces
├── runtimes/
│   ├── cursor.ts         # Cursor SDK integration (primary runtime)
│   └── interface.ts      # Runtime interface contract
├── transports/
│   ├── telegram.ts       # Telegram bot (polling mode)
│   ├── telegram-buttons.ts # Inline button flows for spawn/change/kill
│   ├── lark.ts           # Lark/Feishu bot
│   ├── discord.ts        # Discord bot
│   └── interface.ts      # Transport interface contract
├── server/
│   ├── index.ts          # Express + static file serving + fallback
│   ├── http.ts           # REST API endpoints (/api/fleet, /api/agents, etc.)
│   └── ws.ts             # WebSocket for real-time dashboard updates
packages/
└── dashboard/            # React + Vite SPA (fleet visualization)
```

## Key config paths

| Path | Purpose |
|------|---------|
| `~/.thronglets/config.yaml` | Global config (tokens, API keys) |
| `~/.thronglets/workspaces.yaml` | Registered workspace directories |
| `~/.thronglets/fleet/fleet-state.json` | Persisted agent states |
| `~/.thronglets/fleet/sessions/` | Per-agent session logs (JSONL) |
| `~/.thronglets/dispatch/` | Dispatcher workspace (auto-created) |
| `./config.yaml` | Per-project config override (merged with global) |

`THRONGLETS_HOME` env var overrides `~/.thronglets`.

## Throng naming

Names are **always auto-assigned** by the procedural generator in `naming.ts`. Neither users nor the dispatcher choose names — the system generates a unique name on every spawn. This ensures naming consistency across all entry points (Telegram, dashboard, dispatcher `fleet_spawn`, API).

The `fleet_spawn` tool does **not** accept a `name` parameter. If you are the dispatcher, spawn with `{"runtime":"cursor","workspace":"alias"}` only.

## Fleet communication modes

Control how throngs talk to each other via the `fleet.comms` setting in `config.yaml`:

| Mode | Throng → Throng | Throng → Dispatcher | Throng → Human | Dispatcher → Throng | Human → Anyone |
|------|:---:|:---:|:---:|:---:|:---:|
| **`swarm`** | OK | OK | OK | OK | OK |
| **`hive`** (default) | Blocked | OK | OK | OK | OK |
| **`leash`** | Blocked | Blocked | OK | OK | OK |

Throngs can **always** reply to the human — `fleet.comms` only controls inter-agent `fleet_send`. Human replies go through the normal agent reply channel (Telegram), not fleet tools.

**`hive`** is recommended — throngs report to the dispatcher, the dispatcher coordinates. No cross-chatter.

### Telegram visibility

Control what inter-agent activity you see in Telegram via `fleet.visibility`:

```yaml
fleet:
  comms: hive
  visibility:
    inter_agent: summary   # "full" | "summary" | "off"
    tool_calls: true
```

| `inter_agent` | What you see |
|---|---|
| `full` | Full message content between agents |
| `summary` | One-line notification: `📤 Orix → Zuri` |
| `off` | Nothing — agents work silently |

## Maintenance notes

### Restarting the service
```bash
# Find and kill existing process
ps aux | grep "tsx src/index" | grep -v grep | awk '{print $2}' | xargs -r kill
# Start fresh
npm start
# Or with custom home:
THRONGLETS_HOME=/path/to/home npx tsx src/index.ts
```

### Agent states
| Status | Meaning |
|--------|---------|
| `waiting` | Session active, ready for messages |
| `sleeping` | Session closed (stale), will reconnect on next message |
| `working` | Currently processing a message |
| `error` | Last operation failed, auto-recovers on next send |
| `dead` | Session permanently failed, needs kill + respawn |

### Health monitoring
- Agent health check runs every 30 seconds (stale session detection)
- Dispatcher recovery check runs every 2 minutes (auto-restart if dead)
- Dead agents auto-recover on next `send()` attempt
- Cursor SDK sessions go stale after ~30min idle — this is normal, they reconnect

### Common issues
| Symptom | Cause | Fix |
|---------|-------|-----|
| `Cannot GET /` | Dashboard not built | `cd packages/dashboard && npm install && npm run build` |
| Dispatcher fails to start | Workspace not registered | Auto-provisioned on startup; check logs for `[dispatcher]` errors |
| Agent stuck in "working" | Cursor SDK hang | Kill and respawn; SDK timeout (4.5min) should auto-recover |
| `401 authentication` | Bad API key | Check `config.yaml` api_key value |
| Bot ignores messages | `allowed_chats` mismatch | Verify your chat ID matches config |

### Workspace management

**Dispatcher workspace** is always at `~/.thronglets/dispatch/` with alias `dispatch`. This is hardcoded — it cannot be renamed or moved via config. The dispatcher should never run in a user project directory.

**Add a workspace:**
```bash
curl -X POST http://localhost:3847/api/workspaces \
  -H "Content-Type: application/json" \
  -d '{"alias": "myproject", "path": "/path/to/project"}'
```

**Rename a workspace alias:**
```bash
curl -X PATCH http://localhost:3847/api/workspaces/old-alias \
  -H "Content-Type: application/json" \
  -d '{"alias": "new-alias"}'
```
Renaming updates all agents using that workspace. The `dispatch` alias cannot be renamed.

**Dashboard:** Double-click a workspace tab to rename it inline. The `dispatch` and `All` tabs are locked.

### Upgrading

```bash
git pull
npm install
cd packages/dashboard && npm install && npm run build && cd ../..
# Restart service — fleet state is preserved across restarts
```

**What `git pull` + `npm install` does NOT touch:**
- `~/.thronglets/config.yaml` — never overwritten
- `~/.thronglets/dispatch/` — dispatcher workspace (AGENTS.md, memory/, tools/)
- `~/.thronglets/workspaces.yaml` — workspace registry
- `~/.thronglets/fleet/` — fleet state and session logs
- Any agent workspace directories

All provisioning functions use `writeIfMissing` / `existsSync` guards — they only create files that don't exist yet. Existing user data is never overwritten.

### Config directory

The canonical config directory is `~/.thronglets`. On startup, older directories (`~/.agent-bridge`, `~/.kenyalang`) are auto-migrated if found. Override with `THRONGLETS_HOME` env var.

All path references in the codebase import `GLOBAL_CONFIG_DIR` from `config.ts` — if you add new code that needs the config dir, always use this constant.
