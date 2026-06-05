import { describe, it, expect } from "vitest";
import { FleetEventBus } from "../src/fleet/manager.js";
import { GameEngine, levelForXp } from "../src/fleet/game-state.js";

function makeGame() {
  const bus = new FleetEventBus();
  const game = new GameEngine(bus);
  return {
    game,
    toolCall: (agent: string, name: string) =>
      bus.publish("tool_call", agent, "s", { tool: { id: "t", name, input: {}, summary: name } }),
    toolResult: (agent: string, ok: boolean, preview = "") =>
      bus.publish("tool_result", agent, "s", { result: { toolId: "t", ok, preview } }),
    usage: (agent: string, tokens: number) =>
      bus.publish("usage", agent, "s", { usage: { inputTokens: tokens, outputTokens: 0, cachedTokens: 0, costUsd: 0.001, latencyMs: 500, model: "gpt-4o" } }),
  };
}

describe("levelForXp", () => {
  it("follows the triangular curve", () => {
    expect(levelForXp(0)).toBe(1);
    expect(levelForXp(99)).toBe(1);
    expect(levelForXp(100)).toBe(2);
    expect(levelForXp(300)).toBe(3);   // 100 + 200
  });
});

describe("GameEngine — XP & specialty", () => {
  it("accrues XP from tool calls and successful results", () => {
    const { game, toolCall, toolResult } = makeGame();
    toolCall("zuri", "read_file");
    toolCall("zuri", "read_file");
    toolCall("zuri", "Edit");
    toolResult("zuri", true);
    const s = game.getStats("zuri");
    expect(s.toolCalls).toBe(3);
    expect(s.xp).toBe(6);              // 3 tool calls + 3 for the ok result
    expect(s.specialty).toBe("reading");
  });
});

describe("GameEngine — test detection", () => {
  it("grants a big bonus for a passing test and treats '0 failed' as a pass", () => {
    const { game, toolResult } = makeGame();
    toolResult("kilo", true, "Test Suites: 5 passed, 5 total. 0 failed");
    const s = game.getStats("kilo");
    expect(s.testsPassed).toBe(1);
    expect(s.xp).toBe(53);            // 3 (ok) + 50 (test pass)
    expect(s.mood).toBe("triumphant");
  });

  it("does not count a real failure as a pass", () => {
    const { game, toolResult } = makeGame();
    toolResult("kilo", true, "Tests: 3 failed, 2 passed");
    expect(game.getStats("kilo").testsPassed).toBe(0);
  });
});

describe("GameEngine — moods", () => {
  it("stuck after repeated failures", () => {
    const { game, toolResult } = makeGame();
    toolResult("vex", false, "TypeError");
    toolResult("vex", false, "AssertionError");
    expect(game.getStats("vex").mood).toBe("stuck");
  });

  it("exhausted on heavy token burn", () => {
    const { game, usage } = makeGame();
    usage("orix", 25_000);
    expect(game.getStats("orix").mood).toBe("exhausted");
  });

  it("working when tools flow", () => {
    const { game, toolCall } = makeGame();
    toolCall("mira", "bash");
    expect(game.getStats("mira").mood).toBe("working");
  });

  it("idle with no activity", () => {
    const { game } = makeGame();
    expect(game.getStats("ghost").mood).toBe("idle");
  });
});
