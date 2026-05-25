import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FleetManager, FleetEventBus, _setTestDir } from "../src/fleet/index.js";
import type { FleetEvent } from "../src/fleet/index.js";
import type { Runtime, AgentSession, RuntimeSessionOptions } from "../src/runtimes/interface.js";
import type { RuntimeType } from "../src/config.js";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

class MockSession implements AgentSession {
  responses: string[];
  idx = 0;
  closed = false;

  constructor(responses: string[] = ["mock reply"]) {
    this.responses = responses;
  }

  async send(_text: string): Promise<string> {
    return this.responses[this.idx++ % this.responses.length];
  }

  close(): void {
    this.closed = true;
  }
}

class MockRuntime implements Runtime {
  readonly name = "mock";
  sessions: MockSession[] = [];

  async createSession(opts: RuntimeSessionOptions): Promise<AgentSession> {
    const session = new MockSession([`[${opts.name}] reply from ${opts.cwd}`]);
    this.sessions.push(session);
    return session;
  }
}

function makeFleet() {
  const bus = new FleetEventBus();
  const events: FleetEvent[] = [];
  bus.onEvent((e) => events.push(e));

  const fleet = new FleetManager(bus, {
    workspaces: [
      { alias: "ws1", path: "/tmp/workspace-1" },
      { alias: "ws2", path: "/tmp/workspace-2" },
    ],
    createRuntime: () => new MockRuntime(),
    ensureRulesSync: async () => {},
    getAgentDef: (runtime: RuntimeType, model?: string) => ({
      name: runtime,
      runtime,
      apiKey: "test-key",
      model: model || "test-model",
    }),
    commsMode: "hive",
  });

  return { fleet, bus, events };
}

describe("FleetManager", () => {
  let fleet: FleetManager;
  let events: FleetEvent[];
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "thronglets-test-"));
    _setTestDir(testDir);
    const ctx = makeFleet();
    fleet = ctx.fleet;
    events = ctx.events;
  });

  afterEach(() => {
    fleet.stopHealthCheck();
    _setTestDir(null);
    try { rmSync(testDir, { recursive: true, force: true }); } catch {}
  });

  describe("spawn", () => {
    it("creates an agent with the given name", async () => {
      const result = await fleet.spawn("alpha", "cursor", "ws1");
      expect(result).toContain("alpha");
      expect(fleet.hasAgent("alpha")).toBe(true);
    });

    it("sets initial status to waiting", async () => {
      await fleet.spawn("alpha", "cursor", "ws1");
      const status = fleet.getStatus();
      expect(status.total).toBe(1);
      expect(status.waiting).toBe(1);
    });

    it("emits agent_spawned event", async () => {
      await fleet.spawn("alpha", "cursor", "ws1");
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("agent_spawned");
    });

    it("rejects duplicate names", async () => {
      await fleet.spawn("alpha", "cursor", "ws1");
      const result = await fleet.spawn("alpha", "cursor", "ws1");
      expect(result).toContain("already exists");
    });

    it("rejects invalid workspace", async () => {
      const result = await fleet.spawn("alpha", "cursor", "nonexistent");
      expect(result).toContain("Unknown workspace");
    });

    it("auto-generates name when none provided", async () => {
      const result = await fleet.spawn(undefined, "cursor", "ws1");
      expect(result).toContain("spawned");
      expect(fleet.listAgents().length).toBe(1);
    });
  });

  describe("send", () => {
    it("returns runtime reply", async () => {
      await fleet.spawn("alpha", "cursor", "ws1");
      const reply = await fleet.send("alpha", "hello world");
      expect(reply).toContain("reply from");
    });

    it("increments message count", async () => {
      await fleet.spawn("alpha", "cursor", "ws1");
      await fleet.send("alpha", "hello");
      const agent = fleet.getAgent("alpha")!;
      expect(agent.messageCount).toBe(1);
    });

    it("returns to waiting status after reply", async () => {
      await fleet.spawn("alpha", "cursor", "ws1");
      await fleet.send("alpha", "hello");
      const agent = fleet.getAgent("alpha")!;
      expect(agent.status).toBe("waiting");
    });

    it("emits user_message and agent_message events", async () => {
      await fleet.spawn("alpha", "cursor", "ws1");
      events.length = 0;
      await fleet.send("alpha", "hello");
      const types = events.map((e) => e.type);
      expect(types).toContain("user_message");
      expect(types).toContain("agent_message");
    });

    it("errors for missing agent", async () => {
      const reply = await fleet.send("ghost", "hello");
      expect(reply).toContain("not found");
    });

    it("queues concurrent messages", async () => {
      await fleet.spawn("alpha", "cursor", "ws1");
      const p1 = fleet.send("alpha", "first");
      const p2 = fleet.send("alpha", "second");
      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1).toContain("reply from");
      expect(r2).toContain("reply from");
      expect(fleet.getAgent("alpha")!.messageCount).toBe(2);
    });
  });

  describe("kill", () => {
    it("removes the agent", async () => {
      await fleet.spawn("alpha", "cursor", "ws1");
      await fleet.send("alpha", "test");
      const result = await fleet.kill("alpha");
      expect(result).toContain("killed");
      expect(fleet.hasAgent("alpha")).toBe(false);
    });

    it("emits agent_killed event", async () => {
      await fleet.spawn("alpha", "cursor", "ws1");
      events.length = 0;
      await fleet.kill("alpha");
      expect(events.some((e) => e.type === "agent_killed")).toBe(true);
    });
  });

  describe("clear", () => {
    it("resets session and message count", async () => {
      await fleet.spawn("alpha", "cursor", "ws1");
      await fleet.send("alpha", "first message");
      const oldId = fleet.getAgent("alpha")!.currentSessionId;

      const result = await fleet.clear("alpha");
      expect(result).toContain("cleared");

      const agent = fleet.getAgent("alpha")!;
      expect(agent.currentSessionId).not.toBe(oldId);
      expect(agent.messageCount).toBe(0);
    });

    it("emits session_cleared event", async () => {
      await fleet.spawn("alpha", "cursor", "ws1");
      events.length = 0;
      await fleet.clear("alpha");
      expect(events.some((e) => e.type === "session_cleared")).toBe(true);
    });
  });

  describe("multi-agent", () => {
    it("routes to correct workspaces", async () => {
      await fleet.spawn("alpha", "cursor", "ws1");
      await fleet.spawn("beta", "cursor", "ws2");

      expect(fleet.listAgents()).toHaveLength(2);

      const replyA = await fleet.send("alpha", "test A");
      const replyB = await fleet.send("beta", "test B");
      expect(replyA).toContain("workspace-1");
      expect(replyB).toContain("workspace-2");
    });
  });

  describe("respawn", () => {
    it("preserves agent identity", async () => {
      await fleet.spawn("alpha", "cursor", "ws1");
      await fleet.send("alpha", "work on something");
      const before = fleet.getAgent("alpha")!;
      const oldPersonality = before.personality;

      const result = await fleet.respawn("alpha");
      expect(result).toContain("respawned");
      expect(result).toContain("Identity");

      const after = fleet.getAgent("alpha")!;
      expect(after.name).toBe("alpha");
      expect(after.personality).toBe(oldPersonality);
      expect(after.workspace).toBe("ws1");
      expect(after.status).toBe("waiting");
    });

    it("generates fresh session ID", async () => {
      await fleet.spawn("alpha", "cursor", "ws1");
      const oldSessionId = fleet.getAgent("alpha")!.currentSessionId;

      await fleet.respawn("alpha");
      const newSessionId = fleet.getAgent("alpha")!.currentSessionId;
      expect(newSessionId).not.toBe(oldSessionId);
    });

    it("errors for missing agent", async () => {
      const result = await fleet.respawn("ghost");
      expect(result).toContain("not found");
    });

    it("agent works normally after respawn", async () => {
      await fleet.spawn("alpha", "cursor", "ws1");
      await fleet.send("alpha", "first task");
      const countBefore = fleet.getAgent("alpha")!.messageCount;

      await fleet.respawn("alpha");
      const reply = await fleet.send("alpha", "second task");
      expect(reply).toContain("reply from");
      expect(fleet.getAgent("alpha")!.messageCount).toBe(countBefore + 1);
    });
  });

  describe("auto-recovery", () => {
    it("wakes sleeping agent on message", async () => {
      await fleet.spawn("alpha", "cursor", "ws1");
      await fleet.send("alpha", "task");

      // Simulate sleeping state
      const agent = fleet.getAgent("alpha")!;
      (agent as any).status = "sleeping";

      const reply = await fleet.send("alpha", "wake up");
      expect(reply).toContain("reply from");
      expect(fleet.getAgent("alpha")!.status).toBe("waiting");
    });
  });

  describe("workspace management", () => {
    it("lists initial workspaces", () => {
      const ws = fleet.listWorkspaces();
      expect(ws).toHaveLength(2);
      expect(ws.map((w) => w.alias)).toEqual(["ws1", "ws2"]);
    });
  });

  describe("timeouts", () => {
    it("uses default timeouts when not configured", () => {
      expect(fleet.timeouts.sendTimeoutMs).toBe(60 * 60 * 1000);
      expect(fleet.timeouts.sessionMaxAgeMs).toBe(30 * 60 * 1000);
    });
  });

  describe("channel separation", () => {
    it("broadcasts dispatcher replies to peer agents", async () => {
      await fleet.spawn("_dispatcher", "cursor", "ws1");
      await fleet.spawn("alpha", "cursor", "ws2");

      const broadcasts: string[] = [];
      fleet.onDispatcherBroadcast((reply) => {
        broadcasts.push(reply);
      });

      await fleet.send("_dispatcher", "peer task", "alpha");
      expect(broadcasts.length).toBe(1);
    });

    it("suppresses dispatcher replies to system messages", async () => {
      await fleet.spawn("_dispatcher", "cursor", "ws1");

      const broadcasts: string[] = [];
      fleet.onDispatcherBroadcast((reply) => {
        broadcasts.push(reply);
      });

      await fleet.send("_dispatcher", "[IDLE_POKE] test", "system");
      expect(broadcasts.length).toBe(0);
    });
  });

  describe("task ledger", () => {
    it("records tasks when dispatcher sends to agents", async () => {
      await fleet.spawn("_dispatcher", "cursor", "ws1");
      await fleet.spawn("alpha", "cursor", "ws2");

      await fleet.send("alpha", "implement feature X", "_dispatcher");
      const log = fleet.getRecentTaskLog();
      expect(log).toContain("alpha");
      expect(log).toContain("implement feature X");
      expect(log).toContain("completed");
    });

    it("does not record tasks for user messages", async () => {
      await fleet.spawn("alpha", "cursor", "ws1");

      await fleet.send("alpha", "hello world");
      const log = fleet.getRecentTaskLog();
      expect(log).toContain("No tasks recorded");
    });

    it("getTaskLedgerSummary returns empty for no tasks", () => {
      expect(fleet.getTaskLedgerSummary()).toBe("");
    });

    it("getTaskLedgerSummary includes task info", async () => {
      await fleet.spawn("_dispatcher", "cursor", "ws1");
      await fleet.spawn("alpha", "cursor", "ws2");

      await fleet.send("alpha", "build module", "_dispatcher");
      const summary = fleet.getTaskLedgerSummary();
      expect(summary).toContain("completed");
      expect(summary).toContain("alpha");
    });
  });

  describe("user notification", () => {
    it("emits notification through callback", async () => {
      const notifications: { text: string; level: string }[] = [];
      fleet.onUserNotification((text, level) => {
        notifications.push({ text, level });
      });

      fleet.emitUserNotification("test message", "info");
      expect(notifications).toHaveLength(1);
      expect(notifications[0].text).toBe("test message");
      expect(notifications[0].level).toBe("info");
    });

    it("does nothing without callback", () => {
      expect(() => fleet.emitUserNotification("test", "info")).not.toThrow();
    });
  });
});
