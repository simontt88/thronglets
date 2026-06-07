/**
 * Standalone gateway PoC test — OpenAI
 *
 * Starts a mini gateway server on port 3900, sends a real OpenAI request
 * with tool_calling enabled, and verifies that tool_calls are intercepted
 * and emitted as events. No Telegram, no fleet, no SDK.
 *
 * Usage: npx tsx test/gateway-openai.ts
 */

import express from "express";
import { createServer } from "http";
import EventEmitter from "node:events";

const OPENAI_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_KEY) {
  console.error("Error: OPENAI_API_KEY env var is required");
  console.error("Usage: OPENAI_API_KEY=sk-... npx tsx test/gateway-openai.ts");
  process.exit(1);
}
const GATEWAY_PORT = 3900;

// ── Minimal event bus (no fleet needed) ───────────────────────────────────────

const bus = new EventEmitter();
const capturedEvents: Array<{ type: string; agent: string; summary: string; toolName: string }> = [];

bus.on("tool_call", (e) => {
  capturedEvents.push(e);
  console.log(`\n  🔧 EVENT: [${e.agent}] ${e.toolName} → ${e.summary}`);
});

// ── Tool call parser (OpenAI format) ─────────────────────────────────────────

function summarize(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "read_file":       return `📖 ${input.path || "?"}`;
    case "get_weather":     return `🌤 ${input.location || "?"}`;
    case "calculator":      return `🔢 ${input.expression || "?"}`;
    default:                return `🔧 ${name}`;
  }
}

function parseOpenAIToolCalls(choices: unknown[]): void {
  if (!Array.isArray(choices)) return;
  for (const choice of choices) {
    const c = choice as Record<string, unknown>;
    const msg = c.message as Record<string, unknown> | undefined;
    const toolCalls = msg?.tool_calls as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(toolCalls)) continue;

    for (const tc of toolCalls) {
      if (tc.type !== "function") continue;
      const fn = tc.function as Record<string, unknown> | undefined;
      if (!fn) continue;
      let parsedArgs: Record<string, unknown> = {};
      try { parsedArgs = JSON.parse(String(fn.arguments || "{}")); } catch {}

      const name = String(fn.name || "");
      bus.emit("tool_call", {
        type: "tool_call",
        agent: "test-agent",
        toolName: name,
        toolId: String(tc.id || ""),
        summary: summarize(name, parsedArgs),
        input: parsedArgs,
      });
    }
  }
}

// ── Gateway server ────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

app.all(/.*/, async (req, res) => {
  const url = `https://api.openai.com/v1${req.path}`;
  console.log(`  → Proxying ${req.method} ${url}`);

  try {
    const upstream = await fetch(url, {
      method: req.method,
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${OPENAI_KEY}`,
      },
      body: req.method !== "GET" ? JSON.stringify(req.body) : undefined,
    });

    const data = await upstream.json();

    // Intercept tool_calls if present
    if (req.method === "POST" && req.path.endsWith("/chat/completions")) {
      const choices = data.choices as unknown[] | undefined;
      if (choices?.length) parseOpenAIToolCalls(choices);
    }

    res.status(upstream.status).json(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ✗ Proxy error: ${msg}`);
    res.status(502).json({ error: msg });
  }
});

// ── Test runner ───────────────────────────────────────────────────────────────

async function runTest(): Promise<void> {
  // Start gateway
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(GATEWAY_PORT, "127.0.0.1", resolve));
  console.log(`\nGateway running at http://127.0.0.1:${GATEWAY_PORT}`);
  console.log("Sending a tool-calling request through the gateway...\n");

  try {
    // Send request to OUR gateway (which proxies to OpenAI)
    const res = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        max_tokens: 200,
        messages: [
          { role: "user", content: "What's the weather in Shanghai and Tokyo? Use the tool." }
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              description: "Get current weather for a city",
              parameters: {
                type: "object",
                properties: {
                  location: { type: "string", description: "City name" },
                },
                required: ["location"],
              },
            },
          },
        ],
        tool_choice: "auto",
      }),
    });

    const data = await res.json() as Record<string, unknown>;
    const choices = data.choices as Array<{ message: { content?: string; tool_calls?: unknown[] } }> | undefined;
    const firstChoice = choices?.[0];

    console.log("\n─── Results ─────────────────────────────────────────────────────────");
    console.log(`Status: ${res.status} ${res.ok ? "✅" : "❌"}`);
    console.log(`Model:  ${data.model || "?"}`);

    if (firstChoice?.message?.tool_calls?.length) {
      console.log(`\nOpenAI requested ${firstChoice.message.tool_calls.length} tool call(s):`);
      for (const tc of firstChoice.message.tool_calls as Array<{ id: string; function: { name: string; arguments: string } }>) {
        console.log(`  • ${tc.function.name}(${tc.function.arguments})`);
      }
    } else if (firstChoice?.message?.content) {
      console.log(`\nDirect answer: ${firstChoice.message.content}`);
    }

    console.log(`\nGateway intercepted ${capturedEvents.length} tool_call event(s):`);
    for (const e of capturedEvents) {
      console.log(`  ✓ ${e.toolName} → ${e.summary}`);
    }

    if (capturedEvents.length > 0) {
      console.log("\n✅ SUCCESS: Gateway is intercepting OpenAI tool_calls correctly!");
    } else {
      // Model might have answered directly without using tools
      console.log(`\n⚠️  No tool_calls captured (model may have answered directly). Raw stop_reason: ${(choices?.[0] as any)?.finish_reason}`);
    }
  } finally {
    server.close();
    console.log("\nGateway stopped.\n");
  }
}

runTest().catch(console.error);
