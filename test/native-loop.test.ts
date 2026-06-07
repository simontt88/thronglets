import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { FleetEventBus } from "../src/fleet/manager.js";
import { AgentLoop, type Transport } from "../src/runtimes/native/agent-loop.js";
import { directiveStore } from "../src/gateway/directives.js";

let cwd: string;
beforeEach(async () => { cwd = await mkdtemp(join(tmpdir(), "native-loop-")); });
afterEach(async () => { await rm(cwd, { recursive: true, force: true }); directiveStore.clearAll(); });

/** A transport that replays a queued list of responses and records request bodies. */
function scripted(responses: Record<string, unknown>[]) {
  const bodies: Record<string, unknown>[] = [];
  const transport: Transport = async (body) => {
    bodies.push(body);
    const next = responses.shift();
    if (!next) throw new Error("scripted transport exhausted");
    return next;
  };
  return { transport, bodies };
}

function collectEvents(bus: FleetEventBus) {
  const events: Array<{ type: string; payload: unknown }> = [];
  bus.onEvent((e) => events.push({ type: e.type, payload: e.payload }));
  return events;
}

const oaiToolCall = (id: string, name: string, args: Record<string, unknown>) => ({
  model: "gpt-4o-mini",
  choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }],
  usage: { prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 0 } },
});
const oaiFinal = (text: string) => ({
  model: "gpt-4o-mini",
  choices: [{ message: { role: "assistant", content: text } }],
  usage: { prompt_tokens: 20, completion_tokens: 8 },
});

describe("AgentLoop (OpenAI) — full cycle", () => {
  it("executes a tool then returns the model's final answer, emitting telemetry", async () => {
    const bus = new FleetEventBus();
    const events = collectEvents(bus);
    const { transport, bodies } = scripted([
      oaiToolCall("c1", "run_bash", { command: "echo hi" }),
      oaiFinal("done — printed hi"),
    ]);

    const loop = new AgentLoop({
      agent: "tester", session: "s1", provider: "openai", apiKey: "x",
      baseUrl: "http://unused", model: "gpt-4o-mini", cwd, systemPrompt: "sys", bus, transport,
    });

    const answer = await loop.run("print hi");
    expect(answer).toBe("done — printed hi");

    // Real tool execution happened inside the loop
    const toolCall = events.find((e) => e.type === "tool_call");
    const toolResult = events.find((e) => e.type === "tool_result") as { payload: { result: { ok: boolean; preview: string } } };
    expect((toolCall!.payload as { tool: { name: string } }).tool.name).toBe("run_bash");
    expect(toolResult.payload.result.ok).toBe(true);
    expect(toolResult.payload.result.preview).toContain("hi");

    // Usage emitted with a computed cost
    const usage = events.find((e) => e.type === "usage") as { payload: { usage: { costUsd: number } } };
    expect(usage.payload.usage.costUsd).toBeGreaterThan(0);

    // Second request carried the tool result back to the model (role:tool)
    const secondMsgs = (bodies[1].messages as Array<{ role: string }>);
    expect(secondMsgs.some((m) => m.role === "tool")).toBe(true);
  });

  it("stops at maxSteps when the model never finishes", async () => {
    const bus = new FleetEventBus();
    const responses = Array.from({ length: 10 }, (_, i) => oaiToolCall(`c${i}`, "list_dir", { path: "." }));
    const { transport } = scripted(responses);
    const loop = new AgentLoop({
      agent: "looper", session: "s", provider: "openai", apiKey: "x",
      baseUrl: "http://unused", model: "gpt-4o-mini", cwd, systemPrompt: "sys", bus, transport, maxSteps: 3,
    });
    const answer = await loop.run("loop forever");
    expect(answer).toMatch(/max steps: 3/);
  });
});

describe("AgentLoop — true mid-task model switching", () => {
  it("applies a one-shot tier directive on the next step and emits model_switch", async () => {
    const bus = new FleetEventBus();
    const events = collectEvents(bus);
    const { transport, bodies } = scripted([oaiFinal("ok")]);

    directiveStore.setTier("switcher", "large", true); // openai large → gpt-4.1

    const loop = new AgentLoop({
      agent: "switcher", session: "s", provider: "openai", apiKey: "x",
      baseUrl: "http://unused", model: "gpt-4o-mini", cwd, systemPrompt: "sys", bus, transport,
    });
    await loop.run("do it");

    const sw = events.find((e) => e.type === "model_switch") as { payload: { from: string; to: string; tier: string } };
    expect(sw.payload).toMatchObject({ from: "gpt-4o-mini", to: "gpt-4.1", tier: "large" });
    expect(bodies[0].model).toBe("gpt-4.1"); // the actual request used the switched model
  });
});

describe("AgentLoop (Anthropic) — adapter shape", () => {
  it("parses tool_use blocks and feeds tool_result back in Anthropic format", async () => {
    const bus = new FleetEventBus();
    const events = collectEvents(bus);
    const { transport, bodies } = scripted([
      {
        model: "claude-haiku-4-5", content: [{ type: "tool_use", id: "tu1", name: "list_dir", input: { path: "." } }],
        usage: { input_tokens: 12, output_tokens: 6 },
      },
      { model: "claude-haiku-4-5", content: [{ type: "text", text: "listed it" }], usage: { input_tokens: 15, output_tokens: 4 } },
    ]);

    const loop = new AgentLoop({
      agent: "ant", session: "s", provider: "anthropic", apiKey: "x",
      baseUrl: "http://unused", model: "claude-haiku-4-5", cwd, systemPrompt: "sys", bus, transport,
    });
    const answer = await loop.run("list");
    expect(answer).toBe("listed it");
    expect(events.find((e) => e.type === "tool_call")).toBeTruthy();

    // Anthropic carries the system prompt as a top-level field, and tool results as a user turn
    expect(bodies[0].system).toBe("sys");
    const secondMsgs = bodies[1].messages as Array<{ role: string; content: unknown }>;
    const toolResultTurn = secondMsgs.find((m) => Array.isArray(m.content) && (m.content as Array<{ type: string }>).some((b) => b.type === "tool_result"));
    expect(toolResultTurn).toBeTruthy();
  });
});
