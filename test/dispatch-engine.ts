/**
 * Phase C closed-loop test — DispatchEngine.
 *
 * Feeds synthetic ThrongTrace events through a real FleetEventBus and asserts
 * the engine's routing decisions: cost tracking, budget enforcement,
 * file-ownership conflict detection, and tier suggestion. Pure logic — no API.
 *
 * Usage: npx tsx test/dispatch-engine.ts
 */

import { FleetEventBus } from "../src/fleet/manager.js";
import { DispatchEngine } from "../src/fleet/dispatch-engine.js";

let pass = true;
function check(label: string, cond: boolean): void {
  console.log(`  ${cond ? "✅" : "❌"} ${label}`);
  if (!cond) pass = false;
}

const bus = new FleetEventBus();
const engine = new DispatchEngine(bus, { budgetUsdPerAgent: 0.05, lockTtlMs: 60_000 });

// Helper to emit events the way the gateway does
function toolCall(agent: string, name: string, input: Record<string, unknown>): void {
  bus.publish("tool_call", agent, "s", { tool: { id: "t", name, input, summary: name } });
}
function toolResult(agent: string, ok: boolean): void {
  bus.publish("tool_result", agent, "s", { result: { toolId: "t", ok, preview: "" } });
}
function usage(agent: string, costUsd: number): void {
  bus.publish("usage", agent, "s", { usage: { inputTokens: 100, outputTokens: 50, cachedTokens: 0, costUsd, model: "gpt-4o", latencyMs: 500 } });
}

console.log("\n── Test 1: cost tracking + budget ──");
usage("zuri", 0.02);
usage("zuri", 0.04);   // total 0.06 > budget 0.05
usage("mira", 0.01);
check("zuri cost = 0.06", Math.abs(engine.getCost("zuri") - 0.06) < 1e-9);
check("zuri over budget (0.06 >= 0.05)", engine.isOverBudget("zuri"));
check("mira under budget (0.01 < 0.05)", !engine.isOverBudget("mira"));
check("total cost = 0.07", Math.abs(engine.getTotalCost() - 0.07) < 1e-9);

console.log("\n── Test 2: file-ownership conflict prevention ──");
toolCall("zuri", "Edit", { file_path: "/repo/src/auth.ts" });   // zuri writes auth.ts
const ok1 = engine.checkWrite("zuri", "/repo/src/auth.ts");     // same agent → allowed
const blocked = engine.checkWrite("mira", "/repo/src/auth.ts"); // other agent → blocked
const otherFile = engine.checkWrite("mira", "/repo/src/ui.ts"); // different file → allowed
check("zuri may re-edit its own file", ok1.allowed);
check("mira blocked from zuri's file", !blocked.allowed && blocked.owner === "zuri");
check("mira may edit an unowned file", otherFile.allowed);
check("getFileOwner returns zuri", engine.getFileOwner("/repo/src/auth.ts") === "zuri");

console.log("\n── Test 3: capability stats (success rate) ──");
toolResult("kilo", true);
toolResult("kilo", true);
toolResult("kilo", false);  // 1 error of 3
const k = engine.getStats("kilo");
check("kilo 3 tool results", k.toolResults === 3);
check("kilo 1 error", k.errors === 1);
check("kilo success rate ~0.667", Math.abs(k.successRate - 2 / 3) < 1e-6);

console.log("\n── Test 4: tier suggestion heuristic ──");
check('"refactor the auth module" → large', engine.suggestTier("refactor the auth module") === "large");
check('"fix a typo in README" → small', engine.suggestTier("fix a typo in README") === "small");
check('"add a new endpoint" → mid', engine.suggestTier("add a new endpoint") === "mid");
check('"investigate the race condition" → large', engine.suggestTier("investigate the race condition") === "large");
check('"rename the variable" → small', engine.suggestTier("rename the variable") === "small");

console.log("\n── Engine summary ──");
console.log(engine.summary().split("\n").map((l) => "  " + l).join("\n"));

console.log(pass ? "\n✅ SUCCESS: dispatch engine decisions are correct!\n" : "\n❌ FAILED\n");
process.exit(pass ? 0 : 1);
