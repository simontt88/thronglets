import { ClaudeCodeRuntime } from "./src/runtimes/claude-code.js";

const runtime = new ClaudeCodeRuntime({
  apiKey: "REDACTED_ANTHROPIC_KEY",
  model: "claude-sonnet-4-6",
  permissionMode: "bypassPermissions",
});

console.log("Creating Claude Code session...");
const start = Date.now();

try {
  const session = await runtime.createSession({
    cwd: process.cwd(),
    model: "claude-sonnet-4-6",
    context: "",
    name: "test-claude",
  });

  console.log(`Session created in ${Date.now() - start}ms`);
  console.log("Sending prompt...");

  const reply = await session.send("Read package.json and tell me the project name and version. Be concise.");

  console.log(`\nReply (${((Date.now() - start) / 1000).toFixed(1)}s):`);
  console.log(reply);
  session.close();
} catch (err) {
  console.error(`\nError (${((Date.now() - start) / 1000).toFixed(1)}s):`, err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) {
    console.error(err.stack.split("\n").slice(0, 8).join("\n"));
  }
}
