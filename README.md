# Thronglets

Multi-agent fleet system connecting AI coding agents to messaging platforms.

```
git clone → configure → npm start → your Telegram/Lark/Discord IS your fleet command center
```

## What This Does

Spawns and manages a fleet of **thronglets** — procedurally generated coding creatures, each with unique names, personalities, and pixel art avatars. Each thronglet runs in a workspace with full Cursor-like agent capabilities:

- **Fleet management**: spawn, kill, send, clear agents across runtimes (Cursor, Claude Code, Codex)
- **Smart dispatcher**: AI-powered message routing to the best available thronglet
- **Web dashboard**: real-time fleet visualization with pixel art avatars
- **Inter-agent communication**: message queuing and reply routing between thronglets
- **Multi-platform**: Telegram, Lark, Discord transports

## Quick Start

```bash
git clone https://github.com/simontt88/thronglets.git
cd thronglets
npm install

# Option A: env vars
export TELEGRAM_BOT_TOKEN="your-bot-token"
export TELEGRAM_ALLOWED_CHATS="your-chat-id"
export CURSOR_API_KEY="your-cursor-key"
export BRIDGE_WORKSPACE="/path/to/your/project"
npm start

# Option B: config.yaml (see bridge.yaml.example)
npm start
```

## Configuration

Create `config.yaml` in `~/.thronglets/` or set `THRONGLETS_HOME`:

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
  workspace: vs
```

## Commands

| Command | Description |
|---------|-------------|
| `/new [name] [runtime] [workspace]` | Hatch a thronglet (auto-named if no name) |
| `/kill <name>` | Release a thronglet |
| `/fleet` | Show all thronglets + status |
| `/status [name]` | Thronglet detail |
| `/title <name> <title>` | Set thronglet title/role |
| `/workspace [add alias path]` | List or add workspaces |
| `/dispatcher [restart]` | Dispatcher status / restart |
| `/clear <name>` | Archive session, fresh start |
| `/change <name> <field> <value>` | Reconfigure runtime/model/workspace |
| `/help` | List commands |

### Messaging

- `@name message` — send to a specific thronglet
- `@D message` — route to dispatcher (also `@d`, `@orix`)
- `@all message` — broadcast to all
- Plain text — auto-routes via dispatcher

## Architecture

```
src/
├── fleet/            # Fleet management core
│   ├── manager.ts    # Agent lifecycle, message routing, preamble injection
│   ├── dispatcher.ts # Smart dispatcher setup
│   ├── tools.ts      # [FLEET:...] marker-based fleet tools
│   ├── event-bus.ts  # Real-time event pub/sub
│   ├── state.ts      # Persistent fleet state (JSON + YAML)
│   ├── naming.ts     # Procedural name generation
│   └── types.ts      # TypeScript interfaces
├── transports/       # Messaging platform adapters
│   ├── telegram.ts   # Telegram (long-polling)
│   ├── lark.ts       # Lark/Feishu
│   └── discord.ts    # Discord
├── runtimes/         # Agent SDK backends
│   ├── cursor.ts     # @cursor/sdk
│   ├── claude-code.ts # Claude Code CLI
│   └── codex.ts      # OpenAI Codex
├── server/           # HTTP API + WebSocket
│   └── http.ts       # REST endpoints + WS events
├── config.ts         # YAML + env var config
├── rules-sync.ts     # .cursor/rules → .claude sync
└── index.ts          # Entrypoint + command router

packages/
└── dashboard/        # Vite + React web UI
    └── src/
        ├── components/  # SessionCard, ChatBar, TopBar, SpawnDialog
        ├── lib/
        │   └── thronglet/  # Procedural pixel art generation
        └── stores/      # Zustand state management
```

## Adding a Transport

Implement the `Transport` interface in `src/transports/`:

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

## Adding a Runtime

Implement the `Runtime` interface in `src/runtimes/`:

```typescript
interface Runtime {
  name: string;
  createSession(opts: RuntimeSessionOptions): Promise<AgentSession>;
}
```
