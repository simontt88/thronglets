/**
 * Parallel test: send the same prompt to all 3 runtimes and compare results.
 * Usage: npx tsx test-parallel.ts "your prompt here"
 */

import { CursorRuntime } from "./src/runtimes/cursor.js";
import { ClaudeCodeRuntime } from "./src/runtimes/claude-code.js";
import { CodexRuntime } from "./src/runtimes/codex.js";

const WORKSPACE = process.cwd();
const PROMPT = process.argv[2] || "What files are in this directory? Give a brief summary of what this project is.";

const agents = [
  {
    name: "cursor (claude-opus-4-6)",
    runtime: new CursorRuntime({
      apiKey: "crsr_97e5a1037cf6a3a74fae87554c11a4c51521784d94cd51e401fcf5def1b937ae",
      model: "claude-opus-4-6",
    }),
  },
  {
    name: "claude-code (claude-sonnet-4-6)",
    runtime: new ClaudeCodeRuntime({
      apiKey: "REDACTED_ANTHROPIC_KEY",
      model: "claude-sonnet-4-6",
      permissionMode: "bypassPermissions",
    }),
  },
  {
    name: "codex (o3)",
    runtime: new CodexRuntime({
      apiKey: "REDACTED_OPENAI_KEY",
      model: "o3",
      approvalPolicy: "full-auto",
    }),
  },
];

console.log(`\n=== Thronglets Parallel Test ===`);
console.log(`Workspace: ${WORKSPACE}`);
console.log(`Prompt: "${PROMPT}"`);
console.log(`Agents: ${agents.length}`);
console.log(`\nStarting parallel execution...\n`);

async function testAgent(agent: typeof agents[0]): Promise<{ name: string; reply: string; elapsed: number; error?: string }> {
  const start = Date.now();
  try {
    const session = await agent.runtime.createSession({
      cwd: WORKSPACE,
      model: "",
      context: "",
      name: `test-${Date.now().toString(36)}`,
    });

    const reply = await session.send(PROMPT);
    session.close();
    return { name: agent.name, reply, elapsed: Date.now() - start };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { name: agent.name, reply: "", elapsed: Date.now() - start, error: msg };
  }
}

const results = await Promise.all(agents.map(testAgent));

console.log("\n" + "=".repeat(80));
console.log("RESULTS");
console.log("=".repeat(80));

for (const r of results) {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`Agent: ${r.name}`);
  console.log(`Time: ${(r.elapsed / 1000).toFixed(1)}s`);
  if (r.error) {
    console.log(`ERROR: ${r.error}`);
  } else {
    console.log(`Response (${r.reply.length} chars):`);
    console.log(r.reply.slice(0, 1000));
    if (r.reply.length > 1000) console.log(`... (${r.reply.length - 1000} more chars)`);
  }
}

console.log(`\n${"─".repeat(60)}`);
console.log("\nSummary:");
for (const r of results) {
  const status = r.error ? `❌ ${r.error.slice(0, 80)}` : `✓ ${r.reply.length} chars`;
  console.log(`  ${r.name}: ${(r.elapsed / 1000).toFixed(1)}s — ${status}`);
}
