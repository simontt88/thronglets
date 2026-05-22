import { resolve } from "path";

interface CliOptions {
  command: "start" | "setup" | "help";
  workspace?: string;
  transport?: string;
  model?: string;
  config?: string;
}

function parseArgs(args: string[]): CliOptions {
  const opts: CliOptions = { command: "start" };

  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--workspace" || arg === "-w") {
      opts.workspace = args[++i];
    } else if (arg === "--transport" || arg === "-t") {
      opts.transport = args[++i];
    } else if (arg === "--model" || arg === "-m") {
      opts.model = args[++i];
    } else if (arg === "--config" || arg === "-c") {
      opts.config = args[++i];
    } else if (arg === "--help" || arg === "-h") {
      opts.command = "help";
    } else if (!arg.startsWith("-")) {
      positional.push(arg);
    }
  }

  if (positional[0]) {
    const cmd = positional[0];
    if (cmd === "start" || cmd === "setup" || cmd === "help") {
      opts.command = cmd;
    }
  }

  return opts;
}

function printHelp() {
  console.log(`
agent-bridge — Bridge local workspace agent capabilities to messaging platforms

Usage:
  agent-bridge start [options]     Start the bridge (default command)
  agent-bridge setup               Configure global credentials
  agent-bridge help                Show this help

Options:
  -w, --workspace <path>   Target workspace directory (default: cwd)
  -t, --transport <name>   Transport: telegram, lark, slack (default: from config)
  -m, --model <id>         Model override (default: from config)
  -c, --config <path>      Config file path override

Config resolution (highest to lowest priority):
  1. CLI args (--workspace, --model, etc.)
  2. Environment variables
  3. {workspace}/bridge.yaml (workspace-local)
  4. ~/.agent-bridge/config.yaml (global defaults)

Environment variables:
  TELEGRAM_BOT_TOKEN       Telegram bot token
  TELEGRAM_ALLOWED_CHATS   Comma-separated chat IDs
  CURSOR_API_KEY           Cursor SDK API key
  CURSOR_MODEL             Model ID (e.g. claude-opus-4-6)
  BRIDGE_WORKSPACE         Workspace path
  BRIDGE_TRANSPORT         Transport name
  RECALL_API_URL           Recall API endpoint (optional)
  RECALL_API_KEY           Recall API key (optional)
`);
}

export async function run(argv?: string[]) {
  const args = argv || process.argv.slice(2);
  const opts = parseArgs(args);

  if (opts.command === "help") {
    printHelp();
    process.exit(0);
  }

  if (opts.command === "setup") {
    const { runSetup } = await import("./setup.js");
    await runSetup();
    return;
  }

  // Start command
  const workspace = resolve(opts.workspace || process.env.BRIDGE_WORKSPACE || process.cwd());

  // Set overrides as env vars so config.ts picks them up
  if (opts.workspace) process.env.BRIDGE_WORKSPACE = workspace;
  if (opts.transport) process.env.BRIDGE_TRANSPORT = opts.transport;
  if (opts.model) process.env.CURSOR_MODEL = opts.model;

  // Override workspace in env for config resolution
  process.env._BRIDGE_RESOLVED_WORKSPACE = workspace;
  if (opts.config) process.env._BRIDGE_CONFIG_PATH = opts.config;

  // Import and run
  await import("./index.js");
}

// Auto-run when executed directly
const isMain = process.argv[1]?.includes("cli");
if (isMain) run();
