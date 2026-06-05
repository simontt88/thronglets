/**
 * Capstone end-to-end test — the whole pipeline on REAL traffic.
 *
 * Wires the production pieces exactly as index.ts does:
 *   OpenAI gateway router → FleetEventBus → DispatchEngine + GameEngine
 * then sends a real streaming tool-calling request through the gateway and
 * asserts the telemetry flowed all the way into dispatch cost tracking and
 * game XP/mood. Proves Phases B+C+D+E data plumbing together.
 *
 * Usage: OPENAI_API_KEY=sk-... npx tsx test/e2e-pipeline.ts
 */

import express from "express";
import { createServer } from "http";
import { FleetEventBus } from "../src/fleet/manager.js";
import { DispatchEngine } from "../src/fleet/dispatch-engine.js";
import { GameEngine } from "../src/fleet/game-state.js";
import { createOpenAIGatewayRouter } from "../src/gateway/proxy.js";

const OPENAI_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_KEY) { console.error("Error: OPENAI_API_KEY required"); process.exit(1); }
const PORT = 3903;
const AGENT = "e2e-throng";

let pass = true;
const check = (label: string, cond: boolean) => { console.log(`  ${cond ? "✅" : "❌"} ${label}`); if (!cond) pass = false; };

async function run(): Promise<void> {
  // Production wiring
  const bus = new FleetEventBus();
  const dispatch = new DispatchEngine(bus, { budgetUsdPerAgent: 0 });
  const game = new GameEngine(bus);

  const app = express();
  app.use(express.json());
  app.use("/gateway/openai", createOpenAIGatewayRouter(bus, OPENAI_KEY!));
  // mirror the /api/game endpoint
  app.get("/api/game", (_req, res) => res.json({ stats: game.getAll(), enabled: true }));

  const server = createServer(app);
  await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", r));
  console.log(`\nFull pipeline up on :${PORT}\n`);

  try {
    console.log("Sending real streaming tool-call request through the gateway...\n");
    const res = await fetch(`http://127.0.0.1:${PORT}/gateway/openai/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        stream: true,
        max_tokens: 100,
        messages: [{ role: "user", content: `[GATEWAY_AGENT:${AGENT}|s]\nList files using the tool.` }],
        tools: [{
          type: "function",
          function: {
            name: "list_directory",
            description: "List files in a directory",
            parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
          },
        }],
        tool_choice: "required",
      }),
    });

    // Drain the stream like an agent would
    const reader = res.body!.getReader();
    while (true) { const { done } = await reader.read(); if (done) break; }
    await new Promise((r) => setTimeout(r, 150)); // let post-stream parsing settle

    console.log("─── Pipeline verification ───");

    // DispatchEngine saw the cost + tool
    const cost = dispatch.getCost(AGENT);
    const dstats = dispatch.getStats(AGENT);
    check(`dispatch tracked cost (> 0): $${cost.toFixed(6)}`, cost > 0);
    check(`dispatch tracked tool call(s): ${dstats.toolCalls}`, dstats.toolCalls >= 1);

    // GameEngine awarded XP + has a live mood
    const gstats = game.getStats(AGENT);
    check(`game awarded XP (> 0): ${gstats.xp}`, gstats.xp > 0);
    check(`game has tokens accounted: ${gstats.totalTokens}`, gstats.totalTokens > 0);
    check(`game mood is live (working/thinking): ${gstats.mood}`, ["working", "thinking"].includes(gstats.mood));

    // The HTTP /api/game endpoint (what the dashboard polls) reflects it
    const apiRes = await fetch(`http://127.0.0.1:${PORT}/api/game`);
    const apiData = await apiRes.json() as { stats: Record<string, unknown> };
    check("/api/game exposes the throng to the dashboard", AGENT in apiData.stats);

    console.log(`\n  throng @${AGENT}: L${gstats.level} ${gstats.xp}xp · ${gstats.mood} · ${gstats.specialty} · $${gstats.costUsd.toFixed(5)}`);
    console.log(pass ? "\n✅ SUCCESS: telemetry flows end-to-end, gateway → dispatch + game → dashboard API!\n" : "\n❌ FAILED\n");
  } finally {
    server.close();
  }

  if (!pass) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
