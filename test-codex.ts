import { CodexRuntime } from "./src/runtimes/codex.js";

const runtime = new CodexRuntime({
  apiKey: "REDACTED_OPENAI_KEY",
  model: "o3",
});

console.log("Creating Codex session...");
const start = Date.now();

try {
  const session = await runtime.createSession({
    cwd: process.cwd(),
    model: "o3",
    context: "",
    name: "test-codex",
  });

  console.log(`Session created in ${Date.now() - start}ms`);
  console.log("Sending prompt...");

  const reply = await session.send("What is 2+2? Reply with just the number.");

  console.log(`\nReply (${((Date.now() - start) / 1000).toFixed(1)}s):`);
  console.log(reply);
  session.close();
} catch (err) {
  console.error(`\nError (${((Date.now() - start) / 1000).toFixed(1)}s):`, err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) {
    console.error(err.stack.split("\n").slice(0, 8).join("\n"));
  }
}
