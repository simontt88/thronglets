import { describe, it, expect, vi } from "vitest";
import { parseReplyToolCalls, detectDispatchClaim, createPostReplyHook } from "../src/fleet/tools.js";

describe("parseReplyToolCalls — structured TOOL_CALLS block", () => {
  it("extracts a single tool call and strips the block from narrative", () => {
    const reply = `Heading off to Hivka now.

<TOOL_CALLS>
[{ "tool": "fleet_send", "args": { "agent": "Hivka", "text": "go" } }]
</TOOL_CALLS>`;
    const p = parseReplyToolCalls(reply);
    expect(p.structuredCalls).toEqual([{ tool: "fleet_send", args: { agent: "Hivka", text: "go" } }]);
    expect(p.legacyCalls).toEqual([]);
    expect(p.narrative).toBe("Heading off to Hivka now.");
    expect(p.blockParseError).toBeUndefined();
  });

  it("extracts multiple tool calls in a single block", () => {
    const reply = `Doing two things.
<TOOL_CALLS>
[
  { "tool": "fleet_set_goal", "args": { "goal": "ship v1" } },
  { "tool": "fleet_send",     "args": { "agent": "Vekzu", "text": "go" } }
]
</TOOL_CALLS>`;
    const p = parseReplyToolCalls(reply);
    expect(p.structuredCalls).toHaveLength(2);
    expect(p.structuredCalls[0].tool).toBe("fleet_set_goal");
    expect(p.structuredCalls[1].tool).toBe("fleet_send");
  });

  it("returns empty calls and original narrative when no block present", () => {
    const reply = "Just a plain chat reply, no tools.";
    const p = parseReplyToolCalls(reply);
    expect(p.structuredCalls).toEqual([]);
    expect(p.legacyCalls).toEqual([]);
    expect(p.narrative).toBe("Just a plain chat reply, no tools.");
  });

  it("reports parse error and leaves narrative cleaned when block JSON is malformed", () => {
    const reply = `Trying to send.
<TOOL_CALLS>
[ { "tool": "fleet_send", "args": { "agent": "X"
</TOOL_CALLS>`;
    const p = parseReplyToolCalls(reply);
    expect(p.structuredCalls).toEqual([]);
    expect(p.blockParseError).toBeDefined();
    expect(p.narrative).toBe("Trying to send.");
  });

  it("rejects non-array root", () => {
    const reply = `<TOOL_CALLS>{"tool":"x","args":{}}</TOOL_CALLS>`;
    const p = parseReplyToolCalls(reply);
    expect(p.structuredCalls).toEqual([]);
    expect(p.blockParseError).toMatch(/array/i);
  });

  it("backward-compat: picks up legacy [FLEET:...] markers and strips them", () => {
    const reply = `Doing the thing. [FLEET:fleet_send:{"agent":"Hivka","text":"go"}] done.`;
    const p = parseReplyToolCalls(reply);
    expect(p.legacyCalls).toEqual([{ tool: "fleet_send", args: { agent: "Hivka", text: "go" } }]);
    expect(p.structuredCalls).toEqual([]);
    expect(p.narrative).toBe("Doing the thing.  done.");
  });

  it("prefers structured block + still picks up legacy markers in same reply", () => {
    const reply = `Mixed.
[FLEET:fleet_status:{}]
<TOOL_CALLS>
[{ "tool": "fleet_send", "args": { "agent": "X", "text": "y" } }]
</TOOL_CALLS>`;
    const p = parseReplyToolCalls(reply);
    expect(p.structuredCalls).toHaveLength(1);
    expect(p.legacyCalls).toHaveLength(1);
  });

  it("handles truncated block (the brick }] failure mode) — no false tool calls executed", () => {
    // Brick-style failure: model emitted `}]` thinking it was the closing of an outer block.
    // The structured parser must NOT match this as a tool call.
    const reply = `好，让 Hivka 出一份完整方案。\n\n}]\n\n\n\n让 Hivka 写完整方案，写好了我直接贴给你看。`;
    const p = parseReplyToolCalls(reply);
    expect(p.structuredCalls).toEqual([]);
    expect(p.legacyCalls).toEqual([]);
    expect(p.blockParseError).toBeUndefined(); // no <TOOL_CALLS> wrapper to even try parsing
  });
});

describe("detectDispatchClaim — narrate-without-emit guard", () => {
  it("flags Chinese dispatch verbs", () => {
    expect(detectDispatchClaim("好，让 @Hivka 写一份方案")).toBe(true);
    expect(detectDispatchClaim("已派给 Taxi 处理")).toBe(true);
    expect(detectDispatchClaim("分配给 Vekzu 去实现")).toBe(true);
  });

  it("flags English dispatch verbs", () => {
    expect(detectDispatchClaim("Assigned to Hivka")).toBe(true);
    expect(detectDispatchClaim("Dispatched to @Taxi")).toBe(true);
    expect(detectDispatchClaim("handing off to @Mira")).toBe(true);
    expect(detectDispatchClaim("let Vekzu handle this")).toBe(true);
  });

  it("does not flag pure status/question replies", () => {
    expect(detectDispatchClaim("Let me check the state first.")).toBe(false);
    expect(detectDispatchClaim("当前舰队全部 sleeping，没有任务在跑。")).toBe(false);
    expect(detectDispatchClaim("好的，已收到。")).toBe(false);
  });
});

describe("createPostReplyHook — re-prompt signaling", () => {
  function makeMockFleet() {
    return {
      hasAgent: () => true,
      send: vi.fn().mockResolvedValue("ok"),
      emitFleetActivity: vi.fn(),
    } as any;
  }

  it("returns reprompt when narrate-without-emit detected (dispatcher)", async () => {
    const fleet = makeMockFleet();
    const hook = createPostReplyHook(fleet, [], "hive");
    const result = await hook("_dispatcher", "好，让 @Hivka 写一份完整方案。写好了我贴给你。", "user");
    expect(result.reprompt).toBeDefined();
    expect(result.reprompt).toContain("CORRECTION REQUIRED");
    expect(result.narrative).toContain("Hivka");
    expect(fleet.emitFleetActivity).toHaveBeenCalledWith("narrate_without_emit", "_dispatcher", expect.any(Object));
  });

  it("returns reprompt on TOOL_CALLS parse error", async () => {
    const fleet = makeMockFleet();
    const hook = createPostReplyHook(fleet, [], "hive");
    const reply = `Sending now.\n<TOOL_CALLS>\n[{ "tool": "fleet_send", "args": { broken\n</TOOL_CALLS>`;
    const result = await hook("_dispatcher", reply, "user");
    expect(result.reprompt).toBeDefined();
    expect(result.reprompt).toContain("invalid JSON");
    expect(fleet.emitFleetActivity).toHaveBeenCalledWith("tool_block_parse_error", "_dispatcher", expect.any(Object));
  });

  it("returns no reprompt when tool call properly emitted", async () => {
    const fleet = makeMockFleet();
    const hook = createPostReplyHook(fleet, [], "hive");
    const reply = `让 Hivka 写方案。\n<TOOL_CALLS>\n[{ "tool": "fleet_send", "args": { "agent": "Hivka", "text": "write the doc" } }]\n</TOOL_CALLS>`;
    const result = await hook("_dispatcher", reply, "user");
    expect(result.reprompt).toBeUndefined();
    expect(result.narrative).toContain("Hivka");
  });

  it("returns no reprompt for plain replies without dispatch claims", async () => {
    const fleet = makeMockFleet();
    const hook = createPostReplyHook(fleet, [], "hive");
    const result = await hook("_dispatcher", "收到，让我看看目前的状态。", "user");
    expect(result.reprompt).toBeUndefined();
  });

  it("returns no reprompt when correction reply has valid tool calls (second pass)", async () => {
    const fleet = makeMockFleet();
    const hook = createPostReplyHook(fleet, [], "hive");
    const correctionReply = `<TOOL_CALLS>\n[{ "tool": "fleet_send", "args": { "agent": "Hivka", "text": "write the doc" } }]\n</TOOL_CALLS>`;
    const result = await hook("_dispatcher", correctionReply, "user");
    expect(result.reprompt).toBeUndefined();
    expect(result.narrative).toBe("");
  });
});
