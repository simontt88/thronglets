/**
 * Phase F end-to-end — the self-hosted agent loop on REAL OpenAI traffic.
 *
 * Spins up a NativeRuntime (no codex-sdk), gives a throng a real coding task in a
 * temp workspace, and asserts that:
 *   1. the model actually drove tools (write_file / run_bash) through our loop,
 *   2. the task produced the expected file on disk,
 *   3. telemetry (tool_call / tool_result / usage) flowed straight to the bus —
 *      the same events dispatch + gamification consume.
 *
 * Usage: OPENAI_API_KEY=sk-... npx tsx test/native-runtime.ts
 */

import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { FleetEventBus } from "../src/fleet/manager.js";
import { DispatchEngine } from "../src/fleet/dispatch-engine.js";
import { GameEngine } from "../src/fleet/game-state.js";
import { NativeRuntime } from "../src/runtimes/native/index.js";

if (!process.env.OPENAI_API_KEY) { console.error("Error: OPENAI_API_KEY required"); process.exit(1); }

let pass = true;
const check = (label: string, cond: boolean) => { console.log(`  ${cond ? "✅" : "❌"} ${label}`); if (!cond) pass = false; };

async function run(): Promise<void> {
  const bus = new FleetEventBus();
  const dispatch = new DispatchEngine(bus, { budgetUsdPerAgent: 0 });
  const game = new GameEngine(bus);

  const events: string[] = [];
  bus.onEvent((e) => events.push(e.type));

  const cwd = await mkdtemp(join(tmpdir(), "native-e2e-"));
  const runtime = new NativeRuntime({ model: "gpt-4o-mini", bus });
  const session = await runtime.createSession({ cwd, model: "gpt-4o-mini", name: "nova" });

  console.log(`\nNative throng @nova working in ${cwd}\n`);
  console.log("Task: create hello.txt containing exactly 'thronglets' then verify it.\n");

  const answer = await session.send(
    "Create a file named hello.txt in the current directory whose contents are exactly the word 'thronglets' (no newline). " +
    "Then use run_bash to cat the file and confirm. When done, reply with a one-line summary.",
  );

  console.log("─── Agent final answer ───");
  console.log("  " + answer.replace(/\n/g, "\n  "));
  console.log("\n─── Verification ───");

  // 1. The file exists with the right content
  let fileContent = "";
  try { fileContent = await readFile(join(cwd, "hello.txt"), "utf8"); } catch {}
  check(`hello.txt created with correct content (got: ${JSON.stringify(fileContent)})`, fileContent.trim() === "thronglets");

  // 2. The loop drove real tools and emitted telemetry
  check("emitted tool_call event(s)", events.includes("tool_call"));
  check("emitted tool_result event(s)", events.includes("tool_result"));
  check("emitted usage event(s)", events.includes("usage"));

  // 3. Telemetry reached dispatch + game (same path as the gateway)
  const cost = dispatch.getCost("nova");
  const gstats = game.getStats("nova");
  check(`dispatch tracked cost (> 0): $${cost.toFixed(6)}`, cost > 0);
  check(`game awarded XP (> 0): ${gstats.xp}`, gstats.xp > 0);
  check(`game tracked tool calls: ${dispatch.getStats("nova").toolCalls}`, dispatch.getStats("nova").toolCalls >= 1);

  console.log(`\n  throng @nova: L${gstats.level} ${gstats.xp}xp · ${gstats.mood} · ${gstats.specialty} · $${gstats.costUsd.toFixed(5)}`);

  session.close();
  await rm(cwd, { recursive: true, force: true });

  console.log(pass ? "\n✅ SUCCESS: Phase F self-hosted loop works end-to-end on real traffic!\n" : "\n❌ FAILED\n");
  if (!pass) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
