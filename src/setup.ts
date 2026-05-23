import { mkdirSync, writeFileSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { createInterface } from "readline";

const CONFIG_DIR = join(homedir(), ".thronglets");
const CONFIG_PATH = join(CONFIG_DIR, "config.yaml");

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export async function runSetup() {
  console.log("Thronglets Setup\n");

  if (existsSync(CONFIG_PATH)) {
    console.log(`Existing config found at ${CONFIG_PATH}`);
    const overwrite = await prompt("Overwrite? (y/N): ");
    if (overwrite.toLowerCase() !== "y") {
      console.log("Aborted.");
      return;
    }
  }

  console.log("\n--- Transport ---");
  const transport = (await prompt("Transport (telegram/lark/slack) [telegram]: ")) || "telegram";

  let telegramToken = "";
  let allowedChats = "";
  if (transport === "telegram") {
    telegramToken = await prompt("Telegram bot token: ");
    allowedChats = await prompt("Allowed chat IDs (comma-separated): ");
  }

  console.log("\n--- Runtime ---");
  const runtime = (await prompt("Runtime (cursor/claude/codex) [cursor]: ")) || "cursor";

  let cursorKey = "";
  let model = "";
  if (runtime === "cursor") {
    cursorKey = await prompt("Cursor API key: ");
    model = (await prompt("Model [claude-opus-4-6]: ")) || "claude-opus-4-6";
  }

  console.log("\n--- Session (optional) ---");
  const recallApi = await prompt("Recall API URL (enter to skip): ");
  const recallKey = recallApi ? await prompt("Recall API key: ") : "";

  // Build config
  const lines: string[] = [
    `transport: ${transport}`,
    `runtime: ${runtime}`,
    "",
  ];

  if (transport === "telegram") {
    lines.push("telegram:");
    if (telegramToken) {
      lines.push(`  token: "${telegramToken}"`);
    } else {
      lines.push("  token: ${TELEGRAM_BOT_TOKEN}");
    }
    if (allowedChats) {
      const chats = allowedChats.split(",").map((s) => s.trim());
      lines.push("  allowed_chats:");
      for (const c of chats) lines.push(`    - "${c}"`);
    }
    lines.push("");
  }

  if (runtime === "cursor") {
    lines.push("cursor:");
    if (cursorKey) {
      lines.push(`  api_key: "${cursorKey}"`);
    } else {
      lines.push("  api_key: ${CURSOR_API_KEY}");
    }
    lines.push(`  model: ${model}`);
    lines.push("");
  }

  lines.push("session:");
  lines.push(`  log_dir: ~/.thronglets/logs`);
  if (recallApi) {
    lines.push(`  recall_api: ${recallApi}`);
    if (recallKey) {
      lines.push(`  recall_key: "${recallKey}"`);
    }
  }

  const yaml = lines.join("\n") + "\n";

  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, yaml);

  console.log(`\nConfig written to ${CONFIG_PATH}`);
  console.log("\nTo start:");
  console.log("  cd /path/to/your/workspace");
  console.log("  thronglets start");
}
