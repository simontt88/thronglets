import { describe, it, expect } from "vitest";
import { FleetEventBus } from "../src/fleet/manager.js";
import { DispatchEngine } from "../src/fleet/dispatch-engine.js";

function makeEngine(budget = 0.05) {
  const bus = new FleetEventBus();
  const engine = new DispatchEngine(bus, { budgetUsdPerAgent: budget, lockTtlMs: 60_000 });
  return {
    engine,
    toolCall: (agent: string, name: string, input: Record<string, unknown>) =>
      bus.publish("tool_call", agent, "s", { tool: { id: "t", name, input, summary: name } }),
    toolResult: (agent: string, ok: boolean) =>
      bus.publish("tool_result", agent, "s", { result: { toolId: "t", ok, preview: "" } }),
    usage: (agent: string, costUsd: number) =>
      bus.publish("usage", agent, "s", { usage: { inputTokens: 100, outputTokens: 50, cachedTokens: 0, costUsd, model: "gpt-4o", latencyMs: 500 } }),
  };
}

describe("DispatchEngine — cost & budget", () => {
  it("tracks per-agent and total cost", () => {
    const { engine, usage } = makeEngine();
    usage("zuri", 0.02);
    usage("zuri", 0.04);
    usage("mira", 0.01);
    expect(engine.getCost("zuri")).toBeCloseTo(0.06, 9);
    expect(engine.getTotalCost()).toBeCloseTo(0.07, 9);
  });

  it("flags agents over budget", () => {
    const { engine, usage } = makeEngine(0.05);
    usage("zuri", 0.06);
    usage("mira", 0.01);
    expect(engine.isOverBudget("zuri")).toBe(true);
    expect(engine.isOverBudget("mira")).toBe(false);
  });

  it("never flags over budget when budget is 0 (unlimited)", () => {
    const { engine, usage } = makeEngine(0);
    usage("zuri", 999);
    expect(engine.isOverBudget("zuri")).toBe(false);
  });
});

describe("DispatchEngine — file-ownership conflict prevention", () => {
  it("blocks another agent from writing a file in active use", () => {
    const { engine, toolCall } = makeEngine();
    toolCall("zuri", "Edit", { file_path: "/repo/auth.ts" });
    expect(engine.checkWrite("zuri", "/repo/auth.ts").allowed).toBe(true);    // owner ok
    const blocked = engine.checkWrite("mira", "/repo/auth.ts");
    expect(blocked.allowed).toBe(false);
    expect(blocked.owner).toBe("zuri");
    expect(engine.checkWrite("mira", "/repo/ui.ts").allowed).toBe(true);      // other file ok
    expect(engine.getFileOwner("/repo/auth.ts")).toBe("zuri");
  });
});

describe("DispatchEngine — capability stats", () => {
  it("computes success rate from tool results", () => {
    const { engine, toolResult } = makeEngine();
    toolResult("kilo", true);
    toolResult("kilo", true);
    toolResult("kilo", false);
    const k = engine.getStats("kilo");
    expect(k.toolResults).toBe(3);
    expect(k.errors).toBe(1);
    expect(k.successRate).toBeCloseTo(2 / 3, 6);
  });
});

describe("DispatchEngine — tier heuristic", () => {
  const { engine } = makeEngine();
  it.each([
    ["refactor the auth module", "large"],
    ["investigate the race condition", "large"],
    ["fix a typo in README", "small"],
    ["rename the variable", "small"],
    ["add a new endpoint", "mid"],
  ])("suggests tier for %q → %s", (task, tier) => {
    expect(engine.suggestTier(task)).toBe(tier);
  });
});
