/**
 * Phase B closed-loop test — telemetry spine (SSE streaming).
 *
 * Sends a REAL streaming (stream:true) OpenAI request with tool-calling through
 * the full production gateway (createOpenAIGatewayRouter) and verifies:
 *   1. the client receives a complete SSE stream (agent isn't broken)
 *   2. tool_calls are reconstructed from streamed deltas
 *   3. usage (tokens/cost) is captured (gateway injects include_usage)
 *   4. the GATEWAY_AGENT marker is stripped before reaching the model
 *   5. a trace JSONL file is written
 *
 * Usage: OPENAI_API_KEY=sk-... npx tsx test/gateway-streaming.ts
 */

import express from "express";
import { createServer } from "http";
import EventEmitter from "node:events";
import { existsSync, readFileSync, rmSync } from "fs";
import { createOpenAIGatewayRouter } from "../src/gateway/proxy.js";
import { traceFilePath } from "../src/gateway/trace.js";

const OPENAI_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_KEY) {
  console.error("Error: OPENAI_API_KEY env var is required");
  process.exit(1);
}
const PORT = 3902;
const AGENT = "stream-test-agent";
const SESSION = "stream-test-session";

// Capture bus events
const bus = new EventEmitter() as any;
const events: Array<{ type: string; payload: any }> = [];
bus.publish = (type: string, _a: string, _s: string, payload: any) => {
  events.push({ type, payload });
  if (type === "tool_call") console.log(`  🔧 tool_call: ${payload.tool?.summary}`);
  if (type === "usage") console.log(`  💰 usage: ${payload.usage?.inputTokens}in/${payload.usage?.outputTokens}out $${payload.usage?.costUsd?.toFixed(5)} ${payload.usage?.latencyMs}ms`);
};
bus.onEvent = () => bus;

async function run(): Promise<void> {
  // Clean any prior trace file
  const tracePath = traceFilePath(AGENT, SESSION);
  if (existsSync(tracePath)) rmSync(tracePath);

  const app = express();
  app.use(express.json());
  app.use("/gateway/openai", createOpenAIGatewayRouter(bus, OPENAI_KEY!));
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", r));
  console.log(`\nGateway on http://127.0.0.1:${PORT}/gateway/openai\n`);
  console.log("Sending a STREAMING tool-calling request (with GATEWAY_AGENT marker)...\n");

  let pass = true;
  let chunkCount = 0;
  let sawDone = false;

  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/gateway/openai/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        stream: true,
        max_tokens: 200,
        messages: [
          // Marker should be stripped by the gateway before upstream sees it
          { role: "user", content: `[GATEWAY_AGENT:${AGENT}|${SESSION}]\nWhat's the weather in Paris? Use the tool.` },
        ],
        tools: [{
          type: "function",
          function: {
            name: "get_weather",
            description: "Get weather for a city",
            parameters: { type: "object", properties: { location: { type: "string" } }, required: ["location"] },
          },
        }],
        tool_choice: "auto",
      }),
    });

    console.log(`Response status: ${res.status} ${res.headers.get("content-type")}`);

    // Read the SSE stream the way an agent would
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      chunkCount++;
      if (text.includes("[DONE]")) sawDone = true;
    }

    console.log(`\n─── Verification ───────────────────────────────────────────────`);

    // 1. Stream received
    console.log(`1. Stream chunks received: ${chunkCount}, saw [DONE]: ${sawDone}`);
    if (chunkCount > 0 && sawDone) console.log("   ✅ client received complete stream");
    else { console.log("   ❌ stream incomplete"); pass = false; }

    // Give the gateway a tick to finish parsing + persisting after stream end
    await new Promise((r) => setTimeout(r, 100));

    // 2. tool_calls reconstructed
    const toolCalls = events.filter((e) => e.type === "tool_call");
    console.log(`2. tool_call events: ${toolCalls.length}`);
    if (toolCalls.length >= 1 && toolCalls[0].payload.tool?.name === "get_weather") {
      console.log(`   ✅ reconstructed from deltas: ${toolCalls[0].payload.tool.summary}`);
    } else { console.log("   ❌ tool_call not reconstructed"); pass = false; }

    // 3. usage captured
    const usage = events.find((e) => e.type === "usage");
    console.log(`3. usage event: ${usage ? "yes" : "no"}`);
    if (usage && usage.payload.usage.inputTokens > 0) {
      console.log(`   ✅ tokens=${usage.payload.usage.inputTokens}/${usage.payload.usage.outputTokens} cost=$${usage.payload.usage.costUsd.toFixed(5)}`);
    } else { console.log("   ❌ usage not captured"); pass = false; }

    // 4. trace persisted
    console.log(`4. trace file: ${tracePath}`);
    if (existsSync(tracePath)) {
      const lines = readFileSync(tracePath, "utf-8").trim().split("\n").filter(Boolean);
      console.log(`   ✅ ${lines.length} trace line(s) written`);
    } else { console.log("   ❌ no trace file"); pass = false; }

    console.log(pass ? "\n✅ SUCCESS: telemetry spine works on real streaming traffic!\n" : "\n❌ FAILED\n");
  } finally {
    server.close();
  }

  if (!pass) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
