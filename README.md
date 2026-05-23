# Kenyalang

Bridge your local workspace's full Cursor-like agent capabilities to any messaging platform.

```
git clone → configure → npm start → your Telegram/Lark/Slack IS your local Cursor
```

## What This Does

Takes any directory on your machine and makes it accessible via a messaging bot with the **same capabilities** as opening Cursor IDE on that directory:

- Reads `.cursor/rules/` and `AGENTS.md` (same context as IDE)
- Full shell/file/git access in the workspace
- Multi-turn conversation with agent context management
- Local JSONL conversation logs + optional cloud recall sync

## Quick Start

```bash
git clone https://github.com/simontt88/kenyalang.git
cd kenyalang
npm install

# Option A: env vars
export TELEGRAM_BOT_TOKEN="your-bot-token"
export TELEGRAM_ALLOWED_CHATS="your-chat-id"
export CURSOR_API_KEY="your-cursor-key"
export BRIDGE_WORKSPACE="/path/to/your/project"
npm start

# Option B: bridge.yaml (see below)
npm start
```

## Configuration

Create `bridge.yaml` in the bridge directory:

```yaml
transport: telegram
runtime: cursor
workspace: /path/to/your/project    # the directory you want the agent to work in

telegram:
  token: ${TELEGRAM_BOT_TOKEN}
  allowed_chats:
    - "your-chat-id"

cursor:
  api_key: ${CURSOR_API_KEY}
  model: claude-opus-4-6             # any model from Cursor SDK

session:
  log_dir: ./logs
  recall_api: https://your-recall-api/api/sync/ingest   # optional
  recall_key: ${RECALL_API_KEY}                          # optional
```

`${VAR}` references are resolved from environment variables at startup.

Or skip the yaml and use environment variables directly:

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | yes | From @BotFather |
| `TELEGRAM_ALLOWED_CHATS` | yes | Comma-separated chat IDs |
| `CURSOR_API_KEY` | yes | From cursor.com/settings |
| `BRIDGE_WORKSPACE` | no | Target workspace (default: cwd) |
| `CURSOR_MODEL` | no | Model ID (default: claude-opus-4-6) |
| `BRIDGE_LOG_DIR` | no | Log directory (default: ./logs) |

## How It Works

```
User sends message via Telegram
    ↓
Transport adapter receives message
    ↓
Session manager routes to agent session (creates if needed)
    ↓
On first message: workspace context injected
  - .cursor/rules/**/*.mdc
  - AGENTS.md
  - Directory tree
    ↓
Runtime adapter sends to Cursor SDK (local mode, cwd = workspace)
    ↓
Agent executes with full shell/file/git access
    ↓
Reply sent back through transport
    ↓
Message logged locally + synced to recall API
```

## Commands

| Command | Description |
|---------|-------------|
| `/clear` | Reset agent session (memory preserved in logs/recall) |
| `/status` | Show current session info |
| `/help` | List commands |

## Architecture

```
src/
├── transports/       # Messaging platform adapters
│   ├── interface.ts  # Transport contract
│   └── telegram.ts   # Telegram (long-polling)
├── runtimes/         # Agent SDK backends
│   ├── interface.ts  # Runtime contract
│   └── cursor.ts     # @cursor/sdk local mode
├── context/          # Workspace context injection
│   ├── loader.ts     # Reads rules, AGENTS.md, tree
│   └── injector.ts   # Formats init message
├── session/          # Conversation management
│   ├── manager.ts    # Per-chat sessions
│   └── store.ts      # JSONL logs + recall sync
├── config.ts         # YAML + env var config
└── index.ts          # Entrypoint
```

## Adding a New Transport

Implement the `Transport` interface:

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

Then add a case in `src/index.ts` `createTransport()`.

## Adding a New Runtime

Implement the `Runtime` interface:

```typescript
interface Runtime {
  name: string;
  createSession(opts: { cwd: string; model: string; context: string }): Promise<AgentSession>;
}

interface AgentSession {
  send(text: string): Promise<string>;
  close(): void;
}
```

Then add a case in `src/index.ts` `createRuntime()`.

## Key Design Decisions

- **Workspace is external** — the bridge does NOT live inside the target workspace. It points at any directory.
- **Context injection replicates IDE** — same `.cursor/rules/` loading that Cursor IDE does automatically.
- **Transport-agnostic** — add Lark/Slack/Discord by implementing one interface.
- **Runtime-agnostic** — add Claude SDK/Codex by implementing one interface.
- **Won't affect other directories** — agent runs in `local` mode scoped to the configured workspace only.
