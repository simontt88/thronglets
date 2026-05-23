<p align="center">
  <!-- Replace with actual screenshot once captured -->
  <img src="docs/assets/hero-dashboard.png" alt="Thronglets Dashboard — pixel art agents working in your codebase" width="720" />
</p>

<h1 align="center">Thronglets</h1>

<p align="center">
  <strong>Spawn a fleet of AI coding agents from Telegram. Each one gets a name, a pixel art avatar, and a workspace.</strong>
</p>

<p align="center">
  <a href="https://github.com/simontt88/thronglets/stargazers"><img src="https://img.shields.io/github/stars/simontt88/thronglets?style=flat&color=f3c33a" alt="GitHub Stars" /></a>
  <a href="https://github.com/simontt88/thronglets/blob/main/LICENSE"><img src="https://img.shields.io/github/license/simontt88/thronglets?color=4eb3e6" alt="License: MIT" /></a>
  <a href="https://www.npmjs.com/package/thronglets"><img src="https://img.shields.io/npm/v/thronglets?color=9fd97a" alt="npm version" /></a>
  <a href="https://github.com/simontt88/thronglets/actions"><img src="https://img.shields.io/github/actions/workflow/status/simontt88/thronglets/ci.yml?label=CI" alt="CI" /></a>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> ·
  <a href="#features">Features</a> ·
  <a href="#how-it-works">How It Works</a> ·
  <a href="#commands">Commands</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#contributing">Contributing</a>
</p>

---

## Why Thronglets?

Most AI agent setups give you one agent, one chat window, one context. You alt-tab between your IDE and your messaging app, losing focus.

**Thronglets turns your Telegram group into a fleet command center.** Spawn coding agents on demand — each gets a procedurally generated name (Vexo, Kilo, Paxi...), a unique pixel art avatar with moods, and a dedicated workspace. Route tasks by mentioning an agent or let the AI dispatcher pick the best one. Watch them work in a real-time web dashboard.

```
You:        @Vexo refactor the auth module
Vexo:       On it — restructuring into middleware pattern...

You:        fix the CI pipeline  (no @mention → dispatcher routes it)
Dispatcher: Routing to Kilo (idle, assigned to infra workspace)
Kilo:       Found the issue — Node 18 assertion, fixing...
```

> **One command. Multiple agents. Multiple runtimes. One chat.**

## Quick Start

```bash
git clone https://github.com/simontt88/thronglets.git
cd thronglets && npm install
```

Set your keys:

```bash
export TELEGRAM_BOT_TOKEN="your-bot-token"       # from @BotFather
export CURSOR_API_KEY="your-cursor-api-key"       # from cursor.com/settings
export BRIDGE_WORKSPACE="/path/to/your/project"
```

Launch:

```bash
npm start
```

Open Telegram → `/new` → watch your first thronglet hatch.

## See It In Action

<!-- Replace these with actual GIF/screenshots once captured -->

| Spawn from Telegram | Dashboard with fleet | Smart dispatcher routing |
|:---:|:---:|:---:|
| <img src="docs/assets/demo-spawn.gif" alt="Spawning a thronglet" width="240" /> | <img src="docs/assets/demo-dashboard.png" alt="Web dashboard" width="240" /> | <img src="docs/assets/demo-dispatch.gif" alt="Dispatcher routing" width="240" /> |

## Features

| Feature | Description |
|---------|-------------|
| **Fleet Management** | Spawn, kill, reconfigure agents on the fly. Each has its own session, workspace, and identity |
| **Procedural Avatars** | Every agent gets a unique pixel art creature — deterministic from name, with mood animations (idle, working, happy, sleeping, dead) |
| **Smart Dispatcher** | AI-powered message router. No @mention needed — dispatcher picks the best idle agent by workspace and context |
| **Multi-Runtime** | Cursor SDK, Claude Code CLI, OpenAI Codex — mix runtimes in the same fleet |
| **Multi-Platform** | Telegram (primary), Lark/Feishu, Discord transports |
| **Web Dashboard** | Real-time fleet visualization with session history, live output streaming, and agent state |
| **Inter-Agent Comms** | Agents can message each other via `[FLEET:SEND]` markers. Request-reply pattern with routing |
| **Auto-Recovery** | Heartbeat monitoring, dead agent detection, automatic restart without manual intervention |
| **Session Management** | Archive and recall past sessions per agent. Clear context without killing the creature |
| **Workspace Isolation** | Each agent can be assigned to a different project directory |

## How It Works

```
                   ┌─────────────────────────────────┐
                   │         Your Telegram Chat       │
                   │  "@Vexo fix the login bug"       │
                   └────────────┬────────────────────┘
                                │
                   ┌────────────▼────────────────────┐
                   │       Thronglets Server          │
                   │  ┌──────────────────────────┐   │
                   │  │    Smart Dispatcher       │   │
                   │  │  (routes unaddressed msgs)│   │
                   │  └──────────┬───────────────┘   │
                   │             │                    │
                   │  ┌──────┬──┴──┬──────┐          │
                   │  │ Vexo │Kilo │ Paxi │ ...      │
                   │  │cursor│codex│claude│          │
                   │  │ /app │/api │/docs │          │
                   │  └──┬───┴──┬──┴──┬───┘          │
                   │     │      │     │               │
                   │  ┌──▼──────▼─────▼──┐           │
                   │  │  Web Dashboard    │           │
                   │  │  (live via WS)    │           │
                   │  └──────────────────┘           │
                   └─────────────────────────────────┘
```

Each thronglet runs as a separate agent session:
- **Cursor agents** use `@cursor/sdk` — full IDE capabilities, file editing, terminal access
- **Claude Code agents** use the Claude Code CLI — terminal-native coding
- **Codex agents** use `@openai/codex-sdk` — OpenAI's coding agent

## Commands

| Command | Description |
|---------|-------------|
| `/new [name] [runtime] [workspace]` | Hatch a thronglet (auto-named if omitted) |
| `/kill <name>` | Release a thronglet |
| `/fleet` | Show all thronglets with status |
| `/status [name]` | Detailed thronglet info |
| `/title <name> <title>` | Set a thronglet's role/title |
| `/workspace [add alias path]` | List or register workspaces |
| `/dispatcher [restart]` | Dispatcher status or restart |
| `/clear <name>` | Archive session, fresh context |
| `/change <name> <field> <value>` | Reconfigure runtime/model/workspace |
| `/help` | Show all commands |

### Messaging

| Pattern | Behavior |
|---------|----------|
| `@name message` | Send directly to a specific thronglet |
| `@D message` | Route to the dispatcher |
| `@all message` | Broadcast to all thronglets |
| Plain text | Auto-routes via the dispatcher |

## Configuration

Create `~/.thronglets/config.yaml`:

```yaml
transport: telegram
workspace: /path/to/your/project

telegram:
  token: ${TELEGRAM_BOT_TOKEN}
  allowed_chats:
    - "your-chat-id"

agents:
  - name: cursor
    runtime: cursor
    api_key: ${CURSOR_API_KEY}
    model: claude-sonnet-4-6

dispatcher:
  enabled: true
  runtime: cursor
  workspace: /path/to/orchestrator
```

See [`bridge.yaml.example`](bridge.yaml.example) for the full reference.

### Supported Runtimes

| Runtime | SDK | Requirements |
|---------|-----|-------------|
| Cursor | `@cursor/sdk` | Cursor API key ([cursor.com/settings](https://cursor.com/settings)) |
| Claude Code | CLI subprocess | Claude Code installed + API key |
| Codex | `@openai/codex-sdk` | OpenAI API key |

### Supported Transports

| Transport | Status | Connection |
|-----------|--------|------------|
| Telegram | Stable | Long-polling via Bot API |
| Lark/Feishu | Beta | Event subscription |
| Discord | Beta | Gateway WebSocket |

## Architecture

```
src/
├── fleet/            # Fleet management core
│   ├── manager.ts    # Agent lifecycle + message routing
│   ├── dispatcher.ts # AI-powered task router
│   ├── tools.ts      # Inter-agent communication markers
│   ├── event-bus.ts  # Real-time event pub/sub
│   ├── state.ts      # Persistent fleet state
│   ├── naming.ts     # Procedural name generator
│   └── types.ts      # TypeScript interfaces
├── transports/       # Messaging platform adapters
│   ├── telegram.ts
│   ├── lark.ts
│   └── discord.ts
├── runtimes/         # Agent SDK backends
│   ├── cursor.ts
│   ├── claude-code.ts
│   └── codex.ts
├── server/           # HTTP API + WebSocket
│   └── http.ts
├── config.ts         # YAML + env var config loader
└── index.ts          # Entrypoint

packages/
└── dashboard/        # Vite + React web UI
    └── src/
        ├── components/     # Fleet cards, chat, spawn dialog
        └── lib/thronglet/  # Procedural pixel art engine
```

### Extending

**Add a transport** — implement the `Transport` interface:

```typescript
interface Transport {
  name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void;
  sendReply(chatId: string, text: string): Promise<void>;
  sendTyping(chatId: string): Promise<void>;
}
```

**Add a runtime** — implement the `Runtime` interface:

```typescript
interface Runtime {
  name: string;
  createSession(opts: RuntimeSessionOptions): Promise<AgentSession>;
}
```

## Comparison

| Feature | Thronglets | [agent-orchestrator](https://github.com/composiohq/agent-orchestrator) | [hive](https://github.com/adenhq/hive) |
|---------|-----------|------|------|
| **Primary interface** | Telegram/Lark/Discord chat | CLI/GitHub | CLI/API |
| **Agent identity** | Procedural names + pixel art avatars | Generic workers | Anonymous agents |
| **Dispatch** | AI-powered smart routing | Task DAG planning | Graph-based DAG |
| **Runtimes** | Cursor + Claude Code + Codex | Claude Code + Codex + Aider | Model-agnostic |
| **Dashboard** | Real-time web UI with creature visualization | Terminal UI | Web observability |
| **Setup** | `npm install` + env vars | `npm install` + config | Docker/Python |
| **Focus** | Chat-first fleet management | CI/PR-oriented parallel coding | Business workflow automation |

## Roadmap

- [ ] **Memory layer** — persistent cross-session context per thronglet
- [ ] **Slack transport** — Slack bot adapter
- [ ] **Agent-to-agent delegation** — thronglets assigning subtasks to each other
- [ ] **npm global install** — `npx thronglets` one-liner setup
- [ ] **Docker image** — zero-dependency deployment
- [ ] **Plugin system** — custom tools and behaviors per thronglet

## Contributing

Contributions welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

```bash
git clone https://github.com/simontt88/thronglets.git
cd thronglets && npm install
npm run dev   # starts with --watch
```

## License

[MIT](LICENSE) — use it, fork it, hatch your own thronglets.

---

<p align="center">
  <sub>Built with love and procedural pixel art. If this project is useful to you, please consider giving it a ⭐</sub>
</p>
