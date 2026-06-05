/**
 * Phase D closed-loop test — GameEngine.
 *
 * Feeds synthetic telemetry through a real FleetEventBus and asserts game
 * state: XP accrual, leveling, test-pass detection (big XP), specialty,
 * and mood transitions. Pure logic — no API.
 *
 * Usage: npx tsx test/game-state.ts
 */

import { FleetEventBus } from "../src/fleet/manager.js";
import { GameEngine, levelForXp } from "../src/fleet/game-state.js";

let pass = true;
function check(label: string, cond: boolean): void {
  console.log(`  ${cond ? "✅" : "❌"} ${label}`);
  if (!cond) pass = false;
}

const bus = new FleetEventBus();
const game = new GameEngine(bus);

function toolCall(agent: string, name: string): void {
  bus.publish("tool_call", agent, "s", { tool: { id: "t", name, input: {}, summary: name } });
}
function toolResult(agent: string, ok: boolean, preview = ""): void {
  bus.publish("tool_result", agent, "s", { result: { toolId: "t", ok, preview } });
}
function usage(agent: string, tokens: number, latencyMs = 500): void {
  bus.publish("usage", agent, "s", { usage: { inputTokens: tokens, outputTokens: 0, cachedTokens: 0, costUsd: 0.001, latencyMs, model: "gpt-4o" } });
}

console.log("\n── Test 1: level curve ──");
check("0 xp → level 1", levelForXp(0) === 1);
check("100 xp → level 2", levelForXp(100) === 2);
check("99 xp → level 1", levelForXp(99) === 1);
check("300 xp → level 3 (100+200)", levelForXp(300) === 3);

console.log("\n── Test 2: XP accrual + specialty ──");
toolCall("zuri", "read_file");
toolCall("zuri", "read_file");
toolCall("zuri", "Edit");
toolResult("zuri", true);   // +3
let s = game.getStats("zuri");
check("zuri 3 tool calls", s.toolCalls === 3);
check("zuri xp = 3 (tools) + 3 (ok) = 6", s.xp === 6);
check("zuri specialty = reading (2 reads > 1 edit)", s.specialty === "reading");

console.log("\n── Test 3: test-pass detection grants big XP ──");
toolResult("kilo", true, "Test Suites: 5 passed, 5 total. 0 failed");
s = game.getStats("kilo");
check("kilo testsPassed = 1", s.testsPassed === 1);
check("kilo xp includes +50 test bonus (3+50=53)", s.xp === 53);

console.log("\n── Test 4: mood = triumphant after test pass ──");
check("kilo mood triumphant", game.getStats("kilo").mood === "triumphant");

console.log("\n── Test 5: mood = stuck after repeated failures ──");
toolResult("vex", false, "TypeError: cannot read property");
toolResult("vex", false, "AssertionError: expected true");
check("vex mood stuck (2+ fails)", game.getStats("vex").mood === "stuck");

console.log("\n── Test 6: mood = exhausted on heavy token burn ──");
usage("orix", 25_000);
check("orix mood exhausted (25k tokens)", game.getStats("orix").mood === "exhausted");

console.log("\n── Test 7: mood = working when tools flow ──");
toolCall("mira", "bash");
check("mira mood working", game.getStats("mira").mood === "working");

console.log("\n── Test 8: mood = idle with no recent activity ──");
check("ghost mood idle", game.getStats("ghost").mood === "idle");

console.log("\n── getAll snapshot ──");
const all = game.getAll();
for (const [agent, st] of Object.entries(all)) {
  console.log(`  ${agent}: L${st.level} ${st.xp}xp · ${st.mood} · ${st.specialty} · ${st.testsPassed} tests`);
}

console.log(pass ? "\n✅ SUCCESS: game state is driven correctly by real telemetry!\n" : "\n❌ FAILED\n");
process.exit(pass ? 0 : 1);
