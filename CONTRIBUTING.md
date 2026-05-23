# Contributing to Thronglets

Thanks for your interest in contributing! Whether it's a bug fix, new transport, runtime adapter, or thronglet feature — all contributions are welcome.

## Getting Started

```bash
git clone https://github.com/simontt88/thronglets.git
cd thronglets
npm install
npm run dev   # starts with file watching
```

### Project Structure

- `src/fleet/` — Core fleet management (start here for understanding the system)
- `src/transports/` — Messaging platform adapters (Telegram, Lark, Discord)
- `src/runtimes/` — Agent SDK backends (Cursor, Claude Code, Codex)
- `src/server/` — HTTP API + WebSocket server
- `packages/dashboard/` — Vite + React web dashboard

## How to Contribute

### Bug Reports

Open an issue with:
1. What you expected to happen
2. What actually happened
3. Steps to reproduce
4. Your environment (Node version, OS, runtime being used)

### Feature Requests

Open an issue describing:
1. The problem you're trying to solve
2. Your proposed solution
3. Alternatives you've considered

### Pull Requests

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Run `npm run typecheck` to verify types
4. Write a clear PR description explaining what and why
5. Submit!

### Good First Issues

Look for issues labeled `good first issue` — these are scoped, well-described tasks ideal for first-time contributors.

### Adding a Transport

Implement the `Transport` interface in `src/transports/your-transport.ts`:

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

Register it in `src/config.ts` and add a case to the transport factory in `src/index.ts`.

### Adding a Runtime

Implement the `Runtime` interface in `src/runtimes/your-runtime.ts`:

```typescript
interface Runtime {
  name: string;
  createSession(opts: RuntimeSessionOptions): Promise<AgentSession>;
}
```

## Code Style

- TypeScript strict mode
- No default exports (except `index.ts` entrypoint)
- Prefer named functions over arrow functions at module level
- Keep files focused — one concern per file

## Community

- Be respectful and constructive
- Assume good intent
- Help newcomers get oriented

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
