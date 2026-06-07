/**
 * Phase A closed-loop test — per-task model switching via gateway.
 *
 * Proves the gateway rewrites the request's `model` field based on a per-agent
 * tier directive, by sending the SAME request body (model: gpt-4o-mini) through
 * the gateway under different directives and checking the model OpenAI actually
 * resolved (echoed back in response.model).
 *
 * Usage: OPENAI_API_KEY=sk-... npx tsx test/gateway-model-switch.ts
 */

import express from "express";
import { createServer } from "http";
import EventEmitter from "node:events";
import { directiveStore } from "../src/gateway/directives.js";
import { setModelRegistry, resolveModel } from "../src/gateway/models.js";

const OPENAI_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_KEY) {
  console.error("Error: OPENAI_API_KEY env var is required");
  console.error("Usage: OPENAI_API_KEY=sk-... npx tsx test/gateway-model-switch.ts");
  process.exit(1);
}
const PORT = 3901;

// Minimal bus that records model_switch events
const bus = new EventEmitter() as any;
const switches: Array<{ from: string; to: string; tier: string }> = [];
bus.publish = (type: string, _agent: string, _session: string, payload: any) => {
  if (type === "model_switch") {
    switches.push(payload);
    console.log(`  🔀 model_switch: ${payload.from} → ${payload.to} (tier=${payload.tier})`);
  }
};

// Configure tiers: small=gpt-4o-mini, mid=gpt-4o (distinct so we can verify)
setModelRegistry({ openai: { small: "gpt-4o-mini", mid: "gpt-4o" } });

// ── Gateway (mirrors src/gateway/proxy.ts model-switch logic) ─────────────────

const app = express();
app.use(express.json());

app.all(/.*/, async (req, res) => {
  const agent = "test-agent";

  // Apply directive (same logic as ApiGateway.applyModelDirective)
  const body = req.body as Record<string, unknown>;
  const tier = directiveStore.consumeTier(agent);
  if (tier) {
    const target = resolveModel("openai", tier);
    const current = body.model as string;
    if (target && target !== current) {
      body.model = target;
      bus.publish("model_switch", agent, "s", { from: current, to: target, tier });
    }
  }

  const upstream = await fetch(`https://api.openai.com/v1${req.path}`, {
    method: req.method,
    headers: { "content-type": "application/json", authorization: `Bearer ${OPENAI_KEY}` },
    body: JSON.stringify(body),
  });
  const data = await upstream.json();
  res.status(upstream.status).json(data);
});

// ── Test runner ───────────────────────────────────────────────────────────────

async function callGateway(): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${PORT}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini", // baseline — directive should override this
      max_tokens: 5,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  const data = (await res.json()) as { model?: string };
  return data.model || "?";
}

async function run(): Promise<void> {
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", r));
  console.log(`\nGateway on http://127.0.0.1:${PORT}\n`);

  let pass = true;
  try {
    // Case 1: no directive — should stay gpt-4o-mini
    console.log("Case 1: no directive (expect gpt-4o-mini)");
    let model = await callGateway();
    console.log(`  → resolved: ${model}`);
    if (!model.startsWith("gpt-4o-mini")) { console.log("  ❌ expected gpt-4o-mini"); pass = false; }
    else console.log("  ✅");

    // Case 2: tier=mid — should switch to gpt-4o
    console.log("\nCase 2: directive tier=mid (expect gpt-4o, NOT mini)");
    directiveStore.setTier("test-agent", "mid");
    model = await callGateway();
    console.log(`  → resolved: ${model}`);
    if (!model.startsWith("gpt-4o") || model.startsWith("gpt-4o-mini")) { console.log("  ❌ expected gpt-4o"); pass = false; }
    else console.log("  ✅");

    // Case 3: oneShot directive — applies once, then reverts
    console.log("\nCase 3: oneShot tier=mid (1st call gpt-4o, 2nd call back to mini)");
    directiveStore.setTier("test-agent", "mid", true);
    const first = await callGateway();
    const second = await callGateway();
    console.log(`  → 1st: ${first} | 2nd: ${second}`);
    if (first.startsWith("gpt-4o") && !first.startsWith("gpt-4o-mini") && second.startsWith("gpt-4o-mini")) {
      console.log("  ✅");
    } else { console.log("  ❌ oneShot did not revert correctly"); pass = false; }

    console.log(`\n─── ${switches.length} model_switch event(s) emitted ───`);
    console.log(pass ? "\n✅ SUCCESS: per-task model switching works end-to-end!\n" : "\n❌ FAILED\n");
  } finally {
    server.close();
  }

  if (!pass) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
