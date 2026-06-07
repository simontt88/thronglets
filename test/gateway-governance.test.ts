import { describe, it, expect } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { GovernanceManager, buildGatewayPolicy, type GatewayPolicy } from "../src/gateway/governance.js";

function ledgerPath(): string {
  return join(tmpdir(), `gov-ledger-${Math.random().toString(36).slice(2)}.json`);
}

function policy(virtualKeys: GatewayPolicy["virtualKeys"]): GatewayPolicy {
  return {
    enabled: true,
    providers: { openai: { keys: ["sk-a", "sk-b"] }, anthropic: { keys: ["sk-ant"] } },
    virtualKeys,
  };
}

describe("GovernanceManager — virtual keys", () => {
  it("round-trips vk ↔ agent", () => {
    expect(GovernanceManager.vkFor("_dispatcher")).toBe("vk-_dispatcher");
    expect(GovernanceManager.agentFromVk("Bearer vk-_dispatcher")).toBe("_dispatcher");
    expect(GovernanceManager.agentFromVk("vk-Nova")).toBe("Nova");
    expect(GovernanceManager.agentFromVk("sk-real-key")).toBeUndefined();
    expect(GovernanceManager.agentFromVk(undefined)).toBeUndefined();
  });

  it("falls back to the wildcard policy for unlisted agents", () => {
    const g = new GovernanceManager(policy({ "*": { onExceed: "block", budget: { usd: 1, window: "daily" } } }), ledgerPath());
    expect(g.policyFor("anyone").onExceed).toBe("block");
    expect(g.policyFor("anyone").budget?.usd).toBe(1);
  });
});

describe("GovernanceManager — provider routing", () => {
  it("rotates keys for load-balance and exposes the full list for failover", () => {
    const g = new GovernanceManager(policy({}), ledgerPath());
    const first = g.providerKeys("openai");
    const second = g.providerKeys("openai");
    expect(first).toHaveLength(2);
    expect(first[0]).toBe("sk-a");
    expect(second[0]).toBe("sk-b"); // rotated
    expect(g.providerKeys("anthropic")).toEqual(["sk-ant"]);
  });

  it("rejects a provider the VK is not allowed to use", () => {
    const g = new GovernanceManager(policy({ Nova: { onExceed: "block", providers: ["openai"] } }), ledgerPath());
    expect(g.authorize("Nova", "openai").allow).toBe(true);
    const denied = g.authorize("Nova", "anthropic");
    expect(denied.allow).toBe(false);
    expect(denied.status).toBe(403);
  });
});

describe("GovernanceManager — budgets", () => {
  it("blocks once the USD budget is spent (onExceed: block)", () => {
    const g = new GovernanceManager(policy({ Nova: { onExceed: "block", budget: { usd: 0.5, window: "daily" } } }), ledgerPath());
    expect(g.authorize("Nova", "openai").allow).toBe(true);
    g.recordUsage("Nova", { inputTokens: 1000, outputTokens: 1000, costUsd: 0.6 });
    const blocked = g.authorize("Nova", "openai");
    expect(blocked.allow).toBe(false);
    expect(blocked.status).toBe(402);
  });

  it("downgrades instead of blocking when onExceed is downgrade", () => {
    const g = new GovernanceManager(policy({ Nova: { onExceed: "downgrade", budget: { usd: 0.5, window: "daily" } } }), ledgerPath());
    g.recordUsage("Nova", { inputTokens: 0, outputTokens: 0, costUsd: 0.6 });
    const auth = g.authorize("Nova", "openai");
    expect(auth.allow).toBe(true);
    expect(auth.downgradeTier).toBe("small");
  });

  it("enforces a token budget too", () => {
    const g = new GovernanceManager(policy({ Nova: { onExceed: "block", budget: { tokens: 1500, window: "daily" } } }), ledgerPath());
    g.recordUsage("Nova", { inputTokens: 1000, outputTokens: 1000, costUsd: 0 });
    expect(g.authorize("Nova", "openai").allow).toBe(false);
  });

  it("resets a daily window on the next calendar day", () => {
    const g = new GovernanceManager(policy({ Nova: { onExceed: "block", budget: { usd: 0.5, window: "daily" } } }), ledgerPath());
    const day1 = new Date("2026-06-07T12:00:00Z");
    const day2 = new Date("2026-06-08T01:00:00Z");
    g.recordUsage("Nova", { inputTokens: 0, outputTokens: 0, costUsd: 0.9 }, day1);
    expect(g.authorize("Nova", "openai", day1).allow).toBe(false);
    expect(g.authorize("Nova", "openai", day2).allow).toBe(true); // new day, fresh budget
  });

  it("does NOT reset a total-window budget across days", () => {
    const g = new GovernanceManager(policy({ Nova: { onExceed: "block", budget: { usd: 0.5, window: "total" } } }), ledgerPath());
    const day1 = new Date("2026-06-07T12:00:00Z");
    const day2 = new Date("2026-06-30T01:00:00Z");
    g.recordUsage("Nova", { inputTokens: 0, outputTokens: 0, costUsd: 0.9 }, day1);
    expect(g.authorize("Nova", "openai", day2).allow).toBe(false);
  });

  it("allows agents with no budget (observe-only)", () => {
    const g = new GovernanceManager(policy({ "*": { onExceed: "block" } }), ledgerPath());
    g.recordUsage("Nova", { inputTokens: 999999, outputTokens: 999999, costUsd: 9999 });
    expect(g.authorize("Nova", "openai").allow).toBe(true);
  });
});

describe("GovernanceManager — rate limiting", () => {
  it("blocks past the rpm cap within the window", () => {
    const g = new GovernanceManager(policy({ Nova: { onExceed: "block", rpm: 2 } }), ledgerPath());
    const t = new Date("2026-06-07T12:00:00Z");
    expect(g.authorize("Nova", "openai", t).allow).toBe(true); g.noteRequest("Nova", t);
    expect(g.authorize("Nova", "openai", t).allow).toBe(true); g.noteRequest("Nova", t);
    const blocked = g.authorize("Nova", "openai", t);
    expect(blocked.allow).toBe(false);
    expect(blocked.status).toBe(429);
  });
});

describe("GovernanceManager — stats & persistence", () => {
  it("reports per-VK usage and remaining budget", () => {
    const g = new GovernanceManager(policy({ Nova: { onExceed: "block", budget: { usd: 1, window: "daily" } } }), ledgerPath());
    g.recordUsage("Nova", { inputTokens: 100, outputTokens: 50, costUsd: 0.25 });
    const stats = g.stats() as { virtualKeys: Record<string, { used: { costUsd: number }; remainingUsd: number }> };
    expect(stats.virtualKeys["vk-Nova"].used.costUsd).toBeCloseTo(0.25, 6);
    expect(stats.virtualKeys["vk-Nova"].remainingUsd).toBeCloseTo(0.75, 6);
  });

  it("persists and reloads the ledger", () => {
    const path = ledgerPath();
    const g = new GovernanceManager(policy({ Nova: { onExceed: "block", budget: { usd: 5, window: "total" } } }), path);
    g.recordUsage("Nova", { inputTokens: 0, outputTokens: 0, costUsd: 2 });
    g.flush();
    const g2 = new GovernanceManager(policy({ Nova: { onExceed: "block", budget: { usd: 5, window: "total" } } }), path);
    const stats = g2.stats() as { virtualKeys: Record<string, { lifetimeCostUsd: number }> };
    expect(stats.virtualKeys["vk-Nova"].lifetimeCostUsd).toBeCloseTo(2, 6);
  });
});

describe("buildGatewayPolicy", () => {
  it("uses the explicit gateway block when enabled", () => {
    const p = buildGatewayPolicy(
      { enabled: true, providers: { openai: { keys: ["sk-x"] } }, virtualKeys: { "*": { onExceed: "block" } } },
      {},
    );
    expect(p.enabled).toBe(true);
    expect(p.providers.openai?.keys).toEqual(["sk-x"]);
  });

  it("falls back to agent keys (observe-only) when no block is given", () => {
    const p = buildGatewayPolicy(undefined, { openai: "sk-agent" });
    expect(p.enabled).toBe(true);
    expect(p.providers.openai?.keys).toEqual(["sk-agent"]);
    expect(p.virtualKeys).toEqual({}); // no budgets
  });

  it("is disabled when there are no keys at all", () => {
    const p = buildGatewayPolicy(undefined, {});
    expect(p.enabled).toBe(false);
  });

  it("an enabled block with no providers falls back to agent keys and keeps budgets", () => {
    const p = buildGatewayPolicy(
      { enabled: true, virtualKeys: { _dispatcher: { onExceed: "downgrade", budget: { usd: 5, window: "daily" } } } },
      { openai: "sk-agent" },
    );
    expect(p.enabled).toBe(true);
    expect(p.providers.openai?.keys).toEqual(["sk-agent"]);
    expect(p.virtualKeys._dispatcher?.budget?.usd).toBe(5);
  });
});
